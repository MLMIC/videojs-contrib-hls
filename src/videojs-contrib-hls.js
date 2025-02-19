/**
 * videojs-hls
 * The main file for the HLS project.
 * License: https://github.com/videojs/videojs-contrib-hls/blob/master/LICENSE
 */
import PlaylistLoader from './playlist-loader';
import Playlist from './playlist';
import xhrFactory from './xhr';
import {Decrypter, AsyncStream, decrypt} from './decrypter';
import utils from './bin-utils';
import {MediaSource, URL} from 'videojs-contrib-media-sources';
import m3u8 from './m3u8';
import videojs from 'video.js';
import resolveUrl from './resolve-url';

const Hls = {
  PlaylistLoader,
  Playlist,
  Decrypter,
  AsyncStream,
  decrypt,
  utils,
  xhr: xhrFactory()
};

// the desired length of video to maintain in the buffer, in seconds
Hls.GOAL_BUFFER_LENGTH = 30;

// HLS is a source handler, not a tech. Make sure attempts to use it
// as one do not cause exceptions.
Hls.canPlaySource = function() {
  return videojs.log.warn('HLS is no longer a tech. Please remove it from ' +
                          'your player\'s techOrder.');
};

// Search for a likely end time for the segment that was just appened
// based on the state of the `buffered` property before and after the
// append.
// If we found only one such uncommon end-point return it.
Hls.findSoleUncommonTimeRangesEnd_ = function(original, update) {
  let i;
  let start;
  let end;
  let result = [];
  let edges = [];

  // In order to qualify as a possible candidate, the end point must:
  //  1) Not have already existed in the `original` ranges
  //  2) Not result from the shrinking of a range that already existed
  //     in the `original` ranges
  //  3) Not be contained inside of a range that existed in `original`
  let overlapsCurrentEnd = function(span) {
    return (span[0] <= end && span[1] >= end);
  };

  if (original) {
    // Save all the edges in the `original` TimeRanges object
    for (i = 0; i < original.length; i++) {
      start = original.start(i);
      end = original.end(i);

      edges.push([start, end]);
    }
  }

  if (update) {
    // Save any end-points in `update` that are not in the `original`
    // TimeRanges object
    for (i = 0; i < update.length; i++) {
      start = update.start(i);
      end = update.end(i);

      if (edges.some(overlapsCurrentEnd)) {
        continue;
      }

      // at this point it must be a unique non-shrinking end edge
      result.push(end);
    }
  }

  // we err on the side of caution and return null if didn't find
  // exactly *one* differing end edge in the search above
  if (result.length !== 1) {
    return null;
  }

  return result[0];
};

/**
 * Whether the browser has built-in HLS support.
 */
Hls.supportsNativeHls = (function() {
  let video = document.createElement('video');
  let xMpegUrl;
  let vndMpeg;

  // native HLS is definitely not supported if HTML5 video isn't
  if (!videojs.getComponent('Html5').isSupported()) {
    return false;
  }

  xMpegUrl = video.canPlayType('application/x-mpegURL');
  vndMpeg = video.canPlayType('application/vnd.apple.mpegURL');
  return (/probably|maybe/).test(xMpegUrl) ||
    (/probably|maybe/).test(vndMpeg);
}());

// HLS is a source handler, not a tech. Make sure attempts to use it
// as one do not cause exceptions.
Hls.isSupported = function() {
  return videojs.log.warn('HLS is no longer a tech. Please remove it from ' +
                          'your player\'s techOrder.');
};

/**
 * A comparator function to sort two playlist object by bandwidth.
 * @param left {object} a media playlist object
 * @param right {object} a media playlist object
 * @return {number} Greater than zero if the bandwidth attribute of
 * left is greater than the corresponding attribute of right. Less
 * than zero if the bandwidth of right is greater than left and
 * exactly zero if the two are equal.
 */
Hls.comparePlaylistBandwidth = function(left, right) {
  let leftBandwidth;
  let rightBandwidth;

  if (left.attributes && left.attributes.BANDWIDTH) {
    leftBandwidth = left.attributes.BANDWIDTH;
  }
  leftBandwidth = leftBandwidth || window.Number.MAX_VALUE;
  if (right.attributes && right.attributes.BANDWIDTH) {
    rightBandwidth = right.attributes.BANDWIDTH;
  }
  rightBandwidth = rightBandwidth || window.Number.MAX_VALUE;

  return leftBandwidth - rightBandwidth;
};

/**
 * A comparator function to sort two playlist object by resolution (width).
 * @param left {object} a media playlist object
 * @param right {object} a media playlist object
 * @return {number} Greater than zero if the resolution.width attribute of
 * left is greater than the corresponding attribute of right. Less
 * than zero if the resolution.width of right is greater than left and
 * exactly zero if the two are equal.
 */
Hls.comparePlaylistResolution = function(left, right) {
  let leftWidth;
  let rightWidth;

  if (left.attributes &&
      left.attributes.RESOLUTION &&
      left.attributes.RESOLUTION.width) {
    leftWidth = left.attributes.RESOLUTION.width;
  }

  leftWidth = leftWidth || window.Number.MAX_VALUE;

  if (right.attributes &&
      right.attributes.RESOLUTION &&
      right.attributes.RESOLUTION.width) {
    rightWidth = right.attributes.RESOLUTION.width;
  }

  rightWidth = rightWidth || window.Number.MAX_VALUE;

  // NOTE - Fallback to bandwidth sort as appropriate in cases where multiple renditions
  // have the same media dimensions/ resolution
  if (leftWidth === rightWidth &&
      left.attributes.BANDWIDTH &&
      right.attributes.BANDWIDTH) {
    return left.attributes.BANDWIDTH - right.attributes.BANDWIDTH;
  }
  return leftWidth - rightWidth;
};

// A fudge factor to apply to advertised playlist bitrates to account for
// temporary flucations in client bandwidth
const bandwidthVariance = 1.2;

// 5 minute blacklist
const blacklistDuration = 5 * 60 * 1000;

// Fudge factor to account for TimeRanges rounding
const TIME_FUDGE_FACTOR = 1 / 30;
const Component = videojs.getComponent('Component');

// The amount of time to wait between checking the state of the buffer
const bufferCheckInterval = 500;

// returns true if a key has failed to download within a certain amount of retries
const keyFailed = function(key) {
  return key.retries && key.retries >= 2;
};

/**
 * Returns the CSS value for the specified property on an element
 * using `getComputedStyle`. Firefox has a long-standing issue where
 * getComputedStyle() may return null when running in an iframe with
 * `display: none`.
 * @see https://bugzilla.mozilla.org/show_bug.cgi?id=548397
 */
const safeGetComputedStyle = function(el, property) {
  let result;

  if (!el) {
    return '';
  }

  result = getComputedStyle(el);
  if (!result) {
    return '';
  }

  return result[property];
};

/**
 * Updates segment with information about its end-point in time and, optionally,
 * the segment duration if we have enough information to determine a segment duration
 * accurately.
 * @param playlist {object} a media playlist object
 * @param segmentIndex {number} the index of segment we last appended
 * @param segmentEnd {number} the known of the segment referenced by segmentIndex
 */
const updateSegmentMetadata = function(playlist, segmentIndex, segmentEnd) {
  if (!playlist) {
    return;
  }

  let segment = playlist.segments[segmentIndex];
  let previousSegment = playlist.segments[segmentIndex - 1];

  if (segmentEnd && segment) {
    segment.end = segmentEnd;

    // fix up segment durations based on segment end data
    if (!previousSegment) {
      // first segment is always has a start time of 0 making its duration
      // equal to the segment end
      segment.duration = segment.end;
    } else if (previousSegment.end) {
      segment.duration = segment.end - previousSegment.end;
    }
  }
};

/**
 * Determines if we should call endOfStream on the media source based on the state
 * of the buffer or if appened segment was the final segment in the playlist.
 * @param playlist {object} a media playlist object
 * @param mediaSource {object} the MediaSource object
 * @param segmentIndex {number} the index of segment we last appended
 * @param currentBuffered {object} the buffered region that currentTime resides in
 * @return {boolean} whether the calling function should call endOfStream on the MediaSource
 */
const detectEndOfStream = function(playlist, mediaSource, segmentIndex, currentBuffered) {
  if (!playlist) {
    return false;
  }

  let segments = playlist.segments;

  // determine a few boolean values to help make the branch below easier
  // to read
  let appendedLastSegment = (segmentIndex === segments.length - 1);
  let bufferedToEnd = (currentBuffered.length &&
    segments[segments.length - 1].end <= currentBuffered.end(0));

  // if we've buffered to the end of the video, we need to call endOfStream
  // so that MediaSources can trigger the `ended` event when it runs out of
  // buffered data instead of waiting for me
  return playlist.endList &&
    mediaSource.readyState === 'open' &&
    (appendedLastSegment || bufferedToEnd);
};

const parseCodecs = function(codecs) {
  let result = {
    codecCount: 0,
    videoCodec: null,
    audioProfile: null
  };

  result.codecCount = codecs.split(',').length;
  result.codecCount = result.codecCount || 2;

  // parse the video codec but ignore the version
  result.videoCodec = (/(^|\s|,)+(avc1)[^ ,]*/i).exec(codecs);
  result.videoCodec = result.videoCodec && result.videoCodec[2];

  // parse the last field of the audio codec
  result.audioProfile = (/(^|\s|,)+mp4a.\d+\.(\d+)/i).exec(codecs);
  result.audioProfile = result.audioProfile && result.audioProfile[2];

  return result;
};

const filterBufferedRanges = function(predicate) {
  return function(time) {
    let i;
    let ranges = [];
    let tech = this.tech_;

    // !!The order of the next two assignments is important!!
    // `currentTime` must be equal-to or greater-than the start of the
    // buffered range. Flash executes out-of-process so, every value can
    // change behind the scenes from line-to-line. By reading `currentTime`
    // after `buffered`, we ensure that it is always a current or later
    // value during playback.
    let buffered = tech.buffered();

    if (typeof time === 'undefined') {
      time = tech.currentTime();
    }

    // IE 11 has a bug where it will report a the video as fully buffered
    // before any data has been loaded. This is a work around where we
    // report a fully empty buffer until SourceBuffers have been created
    // which is after a segment has been loaded and transmuxed.
    if (!this.mediaSource ||
        (this.mediaSource.mediaSource_ &&
        !this.mediaSource.mediaSource_.sourceBuffers.length)) {
      return videojs.createTimeRanges([]);
    }

    if (buffered && buffered.length) {
      // Search for a range containing the play-head
      for (i = 0; i < buffered.length; i++) {
        if (predicate(buffered.start(i), buffered.end(i), time)) {
          ranges.push([buffered.start(i), buffered.end(i)]);
        }
      }
    }

    return videojs.createTimeRanges(ranges);
  };
};

export default class HlsHandler extends Component {
  constructor(tech, options) {
    super(tech);
    let _player;

    // tech.player() is deprecated but setup a reference to HLS for
    // backwards-compatibility
    if (tech.options_ && tech.options_.playerId) {
      _player = videojs(tech.options_.playerId);
      if (!_player.hls) {
        Object.defineProperty(_player, 'hls', {
          get: () => {
            videojs.log.warn('player.hls is deprecated. Use player.tech.hls instead.');
            return this;
          }
        });
      }
    }
    this.tech_ = tech;
    this.source_ = options.source;
    this.mode_ = options.mode;
    // the segment info object for a segment that is in the process of
    // being downloaded or processed
    this.pendingSegment_ = null;

    // start playlist selection at a reasonable bandwidth for
    // broadband internet
    // 0.5 Mbps
    this.bandwidth = options.bandwidth || 4194304;
    this.bytesReceived = 0;

    // loadingState_ tracks how far along the buffering process we
    // have been given permission to proceed. There are three possible
    // values:
    // - none: do not load playlists or segments
    // - meta: load playlists but not segments
    // - segments: load everything
    this.loadingState_ = 'none';
    if (this.tech_.preload() !== 'none') {
      this.loadingState_ = 'meta';
    }

    // periodically check if new data needs to be downloaded or
    // buffered data should be appended to the source buffer
    this.startCheckingBuffer_();

    this.on(this.tech_, 'seeking', function() {
      this.setCurrentTime(this.tech_.currentTime());
    });
    this.on(this.tech_, 'error', function() {
      this.stopCheckingBuffer_();
    });

    this.on(this.tech_, 'play', this.play);
  }
  src(src) {
    let oldMediaPlaylist;

    // do nothing if the src is falsey
    if (!src) {
      return;
    }

    this.mediaSource = new videojs.MediaSource({ mode: this.mode_ });

    // load the MediaSource into the player
    this.mediaSource.addEventListener('sourceopen', this.handleSourceOpen.bind(this));

    this.options_ = {};
    if (typeof this.source_.withCredentials !== 'undefined') {
      this.options_.withCredentials = this.source_.withCredentials;
    } else if (videojs.options.hls) {
      this.options_.withCredentials = videojs.options.hls.withCredentials;
    }
    this.playlists = new Hls.PlaylistLoader(this.source_.src,
                                            this.tech_.hls,
                                            this.options_.withCredentials);

    this.tech_.one('canplay', this.setupFirstPlay.bind(this));

    this.playlists.on('loadedmetadata', () => {
      oldMediaPlaylist = this.playlists.media();

      // if this isn't a live video and preload permits, start
      // downloading segments
      if (oldMediaPlaylist.endList &&
          this.tech_.preload() !== 'metadata' &&
          this.tech_.preload() !== 'none') {
        this.loadingState_ = 'segments';
      }

      this.setupSourceBuffer_();
      this.setupFirstPlay();
      this.fillBuffer();
      this.tech_.trigger('loadedmetadata');
    });

    this.playlists.on('error', () => {
      this.blacklistCurrentPlaylist_(this.playlists.error);
    });

    this.playlists.on('loadedplaylist', () => {
      let updatedPlaylist = this.playlists.media();
      let seekable;

      if (!updatedPlaylist) {
        // select the initial variant
        this.playlists.media(this.selectPlaylist());
        return;
      }

      this.updateDuration(this.playlists.media());

      // update seekable
      seekable = this.seekable();
      if (this.duration() === Infinity &&
          seekable.length !== 0) {
        this.mediaSource.addSeekableRange_(seekable.start(0), seekable.end(0));
      }

      oldMediaPlaylist = updatedPlaylist;
    });

    this.playlists.on('mediachange', () => {
      this.tech_.trigger({
        type: 'mediachange',
        bubbles: true
      });
    });

    // do nothing if the tech has been disposed already
    // this can occur if someone sets the src in player.ready(), for instance
    if (!this.tech_.el()) {
      return;
    }

    this.tech_.src(videojs.URL.createObjectURL(this.mediaSource));
  }
  handleSourceOpen() {
    // Only attempt to create the source buffer if none already exist.
    // handleSourceOpen is also called when we are "re-opening" a source buffer
    // after `endOfStream` has been called (in response to a seek for instance)
    if (!this.sourceBuffer) {
      this.setupSourceBuffer_();
    }

    // if autoplay is enabled, begin playback. This is duplicative of
    // code in video.js but is required because play() must be invoked
    // *after* the media source has opened.
    // NOTE: moving this invocation of play() after
    // sourceBuffer.appendBuffer() below caused live streams with
    // autoplay to stall
    if (this.tech_.autoplay()) {
      this.play();
    }
  }

  /**
   * Blacklist playlists that are known to be codec or
   * stream-incompatible with the SourceBuffer configuration. For
   * instance, Media Source Extensions would cause the video element to
   * stall waiting for video data if you switched from a variant with
   * video and audio to an audio-only one.
   *
   * @param media {object} a media playlist compatible with the current
   * set of SourceBuffers. Variants in the current master playlist that
   * do not appear to have compatible codec or stream configurations
   * will be excluded from the default playlist selection algorithm
   * indefinitely.
   */
  excludeIncompatibleVariants_(media) {
    let master = this.playlists.master;
    let codecCount = 2;
    let videoCodec = null;
    let audioProfile = null;
    let codecs;

    if (media.attributes && media.attributes.CODECS) {
      codecs = parseCodecs(media.attributes.CODECS);
      videoCodec = codecs.videoCodec;
      audioProfile = codecs.audioProfile;
      codecCount = codecs.codecCount;
    }
    master.playlists.forEach(function(variant) {
      let variantCodecs = {
        codecCount: 2,
        videoCodec: null,
        audioProfile: null
      };

      if (variant.attributes && variant.attributes.CODECS) {
        variantCodecs = parseCodecs(variant.attributes.CODECS);
      }

      // if the streams differ in the presence or absence of audio or
      // video, they are incompatible
      if (variantCodecs.codecCount !== codecCount) {
        variant.excludeUntil = Infinity;
      }

      // if h.264 is specified on the current playlist, some flavor of
      // it must be specified on all compatible variants
      if (variantCodecs.videoCodec !== videoCodec) {
        variant.excludeUntil = Infinity;
      }
      // HE-AAC ("mp4a.40.5") is incompatible with all other versions of
      // AAC audio in Chrome 46. Don't mix the two.
      if ((variantCodecs.audioProfile === '5' && audioProfile !== '5') ||
          (audioProfile === '5' && variantCodecs.audioProfile !== '5')) {
        variant.excludeUntil = Infinity;
      }
    });
  }

  setupSourceBuffer_() {
    let media = this.playlists.media();
    let mimeType;

    // wait until a media playlist is available and the Media Source is
    // attached
    if (!media || this.mediaSource.readyState !== 'open') {
      return;
    }

    // if the codecs were explicitly specified, pass them along to the
    // source buffer
    mimeType = 'video/mp2t';
    if (media.attributes && media.attributes.CODECS) {
      mimeType += '; codecs="' + media.attributes.CODECS + '"';
    }
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);

    // exclude any incompatible variant streams from future playlist
    // selection
    this.excludeIncompatibleVariants_(media);

    // transition the sourcebuffer to the ended state if we've hit the end of
    // the playlist
    this.sourceBuffer.addEventListener('updateend', this.updateEndHandler_.bind(this));
  }

  /**
   * Seek to the latest media position if this is a live video and the
   * player and video are loaded and initialized.
   */
  setupFirstPlay() {
    let seekable;
    let media = this.playlists.media();

    // check that everything is ready to begin buffering

    // 1) the video is a live stream of unknown duration
    if (this.duration() === Infinity &&

        // 2) the player has not played before and is not paused
        this.tech_.played().length === 0 &&
        !this.tech_.paused() &&

        // 3) the Media Source and Source Buffers are ready
        this.sourceBuffer &&

        // 4) the active media playlist is available
        media &&

        // 5) the video element or flash player is in a readyState of
        // at least HAVE_FUTURE_DATA
        this.tech_.readyState() >= 1) {

      // trigger the playlist loader to start "expired time"-tracking
      this.playlists.trigger('firstplay');

      // seek to the latest media position for live videos
      seekable = this.seekable();
      if (seekable.length) {
        this.tech_.setCurrentTime(seekable.end(0));
      }
    }
  }

  /**
   * Begin playing the video.
   */
  play() {
    this.loadingState_ = 'segments';

    if (this.tech_.ended()) {
      this.tech_.setCurrentTime(0);
    }

    if (this.tech_.played().length === 0) {
      return this.setupFirstPlay();
    }

    // if the viewer has paused and we fell out of the live window,
    // seek forward to the earliest available position
    if (this.duration() === Infinity) {
      if (this.tech_.currentTime() < this.seekable().start(0)) {
        this.tech_.setCurrentTime(this.seekable().start(0));
      }
    }
  }

  setCurrentTime(currentTime) {
    let buffered = this.findBufferedRange_();

    if (!(this.playlists && this.playlists.media())) {
      // return immediately if the metadata is not ready yet
      return 0;
    }

    // it's clearly an edge-case but don't thrown an error if asked to
    // seek within an empty playlist
    if (!this.playlists.media().segments) {
      return 0;
    }

    // if the seek location is already buffered, continue buffering as
    // usual
    if (buffered && buffered.length) {
      return currentTime;
    }

    // if we are in the middle of appending a segment, let it finish up
    if (this.pendingSegment_ && this.pendingSegment_.buffered) {
      return currentTime;
    }

    this.lastSegmentLoaded_ = null;

    // cancel outstanding requests and buffer appends
    this.cancelSegmentXhr();

    // abort outstanding key requests, if necessary
    if (this.keyXhr_) {
      this.keyXhr_.aborted = true;
      this.cancelKeyXhr();
    }

    // begin filling the buffer at the new position
    this.fillBuffer(this.playlists.getMediaIndexForTime_(currentTime));
  }

  duration() {
    let playlists = this.playlists;

    if (!playlists) {
      return 0;
    }

    if (this.mediaSource) {
      return this.mediaSource.duration;
    }

    return Hls.Playlist.duration(playlists.media());
  }

  seekable() {
    let media;
    let seekable;

    if (!this.playlists) {
      return videojs.createTimeRanges();
    }
    media = this.playlists.media();
    if (!media) {
      return videojs.createTimeRanges();
    }

    seekable = Hls.Playlist.seekable(media);
    if (seekable.length === 0) {
      return seekable;
    }

    // if the seekable start is zero, it may be because the player has
    // been paused for a long time and stopped buffering. in that case,
    // fall back to the playlist loader's running estimate of expired
    // time
    if (seekable.start(0) === 0) {
      return videojs.createTimeRanges([[this.playlists.expired_,
                                        this.playlists.expired_ + seekable.end(0)]]);
    }

    // seekable has been calculated based on buffering video data so it
    // can be returned directly
    return seekable;
  }

  /**
   * Update the player duration
   */
  updateDuration(playlist) {
    let oldDuration = this.mediaSource.duration;
    let newDuration = Hls.Playlist.duration(playlist);
    let buffered = this.tech_.buffered();
    let setDuration = () => {
      this.mediaSource.duration = newDuration;
      this.tech_.trigger('durationchange');

      this.mediaSource.removeEventListener('sourceopen', setDuration);
    };

    if (buffered.length > 0) {
      newDuration = Math.max(newDuration, buffered.end(buffered.length - 1));
    }

    // if the duration has changed, invalidate the cached value
    if (oldDuration !== newDuration) {
      // update the duration
      if (this.mediaSource.readyState !== 'open') {
        this.mediaSource.addEventListener('sourceopen', setDuration);
      } else if (!this.sourceBuffer || !this.sourceBuffer.updating) {
        this.mediaSource.duration = newDuration;
        this.tech_.trigger('durationchange');
      }
    }
  }

  /**
   * Clear all buffers and reset any state relevant to the current
   * source. After this function is called, the tech should be in a
   * state suitable for switching to a different video.
   */
  resetSrc_() {
    this.cancelSegmentXhr();
    this.cancelKeyXhr();

    if (this.sourceBuffer && this.mediaSource.readyState === 'open') {
      this.sourceBuffer.abort();
    }
  }

  cancelKeyXhr() {
    if (this.keyXhr_) {
      this.keyXhr_.onreadystatechange = null;
      this.keyXhr_.abort();
      this.keyXhr_ = null;
    }
  }

  cancelSegmentXhr() {
    if (this.segmentXhr_) {
      // Prevent error handler from running.
      this.segmentXhr_.onreadystatechange = null;
      this.segmentXhr_.abort();
      this.segmentXhr_ = null;
    }

    // clear out the segment being processed
    this.pendingSegment_ = null;
  }

  /**
  * Abort all outstanding work and cleanup.
  */
  dispose() {
    this.stopCheckingBuffer_();

    if (this.playlists) {
      this.playlists.dispose();
    }

    this.resetSrc_();
    super.dispose();
  }

  /**
   * Chooses the appropriate media playlist based on the current
   * bandwidth estimate and the player size.
   * @return the highest bitrate playlist less than the currently detected
   * bandwidth, accounting for some amount of bandwidth variance
   */
  selectPlaylist() {
    let effectiveBitrate;
    let sortedPlaylists = this.playlists.master.playlists.slice();
    let bandwidthPlaylists = [];
    let now = +new Date();
    let i;
    let variant;
    let bandwidthBestVariant;
    let resolutionPlusOne;
    let resolutionPlusOneAttribute;
    let resolutionBestVariant;
    let width;
    let height;

    sortedPlaylists.sort(Hls.comparePlaylistBandwidth);

    // filter out any playlists that have been excluded due to
    // incompatible configurations or playback errors
    sortedPlaylists = sortedPlaylists.filter((localVariant) => {
      if (typeof localVariant.excludeUntil !== 'undefined') {
        return now >= localVariant.excludeUntil;
      }
      return true;
    });

    // filter out any variant that has greater effective bitrate
    // than the current estimated bandwidth
    i = sortedPlaylists.length;
    while (i--) {
      variant = sortedPlaylists[i];

      // ignore playlists without bandwidth information
      if (!variant.attributes || !variant.attributes.BANDWIDTH) {
        continue;
      }

      effectiveBitrate = variant.attributes.BANDWIDTH * bandwidthVariance;

      if (effectiveBitrate < this.bandwidth) {
        bandwidthPlaylists.push(variant);

        // since the playlists are sorted in ascending order by
        // bandwidth, the first viable variant is the best
        if (!bandwidthBestVariant) {
          bandwidthBestVariant = variant;
        }
      }
    }

    i = bandwidthPlaylists.length;

    // sort variants by resolution
    bandwidthPlaylists.sort(Hls.comparePlaylistResolution);

    // forget our old variant from above,
    // or we might choose that in high-bandwidth scenarios
    // (this could be the lowest bitrate rendition as  we go through all of them above)
    variant = null;

    width = parseInt(safeGetComputedStyle(this.tech_.el(), 'width'), 10);
    height = parseInt(safeGetComputedStyle(this.tech_.el(), 'height'), 10);

    // iterate through the bandwidth-filtered playlists and find
    // best rendition by player dimension
    while (i--) {
      variant = bandwidthPlaylists[i];

      // ignore playlists without resolution information
      if (!variant.attributes ||
          !variant.attributes.RESOLUTION ||
          !variant.attributes.RESOLUTION.width ||
          !variant.attributes.RESOLUTION.height) {
        continue;
      }

      // since the playlists are sorted, the first variant that has
      // dimensions less than or equal to the player size is the best

      let variantResolution = variant.attributes.RESOLUTION;

      if (variantResolution.width === width &&
          variantResolution.height === height) {
        // if we have the exact resolution as the player use it
        resolutionPlusOne = null;
        resolutionBestVariant = variant;
        break;
      } else if (variantResolution.width < width &&
                 variantResolution.height < height) {
        // if both dimensions are less than the player use the
        // previous (next-largest) variant
        break;
      } else if (!resolutionPlusOne ||
                 (variantResolution.width < resolutionPlusOneAttribute.width &&
                  variantResolution.height < resolutionPlusOneAttribute.height)) {
        // If we still haven't found a good match keep a
        // reference to the previous variant for the next loop
        // iteration

        // By only saving variants if they are smaller than the
        // previously saved variant, we ensure that we also pick
        // the highest bandwidth variant that is just-larger-than
        // the video player
        resolutionPlusOne = variant;
        resolutionPlusOneAttribute = resolutionPlusOne.attributes.RESOLUTION;
      }
    }

    // fallback chain of variants
    return resolutionPlusOne ||
      resolutionBestVariant ||
      bandwidthBestVariant ||
      sortedPlaylists[0];
  }

  /**
   * Periodically request new segments and append video data.
   */
  checkBuffer_() {
    // calling this method directly resets any outstanding buffer checks
    if (this.checkBufferTimeout_) {
      window.clearTimeout(this.checkBufferTimeout_);
      this.checkBufferTimeout_ = null;
    }

    this.fillBuffer();
    this.drainBuffer();

    // wait awhile and try again
    this.checkBufferTimeout_ = window.setTimeout((this.checkBuffer_).bind(this),
                                                  bufferCheckInterval);
  }

  /**
   * Setup a periodic task to request new segments if necessary and
   * append bytes into the SourceBuffer.
   */
  startCheckingBuffer_() {
    this.checkBuffer_();
  }

  /**
   * Stop the periodic task requesting new segments and feeding the
   * SourceBuffer.
   */
  stopCheckingBuffer_() {
    if (this.checkBufferTimeout_) {
      window.clearTimeout(this.checkBufferTimeout_);
      this.checkBufferTimeout_ = null;
    }
  }

  /**
   * Determines whether there is enough video data currently in the buffer
   * and downloads a new segment if the buffered time is less than the goal.
   * @param seekToTime (optional) {number} the offset into the downloaded segment
   * to seek to, in seconds
   */
  fillBuffer(mediaIndex) {
    let tech = this.tech_;
    let currentTime = tech.currentTime();
    let hasBufferedContent = (this.tech_.buffered().length !== 0);
    let currentBuffered = this.findBufferedRange_();
    let outsideBufferedRanges = !(currentBuffered && currentBuffered.length);
    let currentBufferedEnd = 0;
    let bufferedTime = 0;
    let segment;
    let segmentInfo;
    let segmentTimestampOffset;

    // if preload is set to "none", do not download segments until playback is requested
    if (this.loadingState_ !== 'segments') {
      return;
    }

    // if a video has not been specified, do nothing
    if (!tech.currentSrc() || !this.playlists) {
      return;
    }

    // if there is a request already in flight, do nothing
    if (this.segmentXhr_) {
      return;
    }

    // wait until the buffer is up to date
    if (this.pendingSegment_) {
      return;
    }

    // if no segments are available, do nothing
    if (this.playlists.state === 'HAVE_NOTHING' ||
        !this.playlists.media() ||
        !this.playlists.media().segments) {
      return;
    }

    // if a playlist switch is in progress, wait for it to finish
    if (this.playlists.state === 'SWITCHING_MEDIA') {
      return;
    }

    if (typeof mediaIndex === 'undefined') {
      if (currentBuffered && currentBuffered.length) {
        currentBufferedEnd = currentBuffered.end(0);
        mediaIndex = this.playlists.getMediaIndexForTime_(currentBufferedEnd);
        bufferedTime = Math.max(0, currentBufferedEnd - currentTime);

        // if there is plenty of content in the buffer and we're not
        // seeking, relax for awhile
        if (bufferedTime >= Hls.GOAL_BUFFER_LENGTH) {
          return;
        }
      } else {
        mediaIndex = this.playlists.getMediaIndexForTime_(this.tech_.currentTime());
      }
    }
    segment = this.playlists.media().segments[mediaIndex];

    // if the video has finished downloading
    if (!segment) {
      return;
    }

    // we have entered a state where we are fetching the same segment,
    // try to walk forward
    if (this.lastSegmentLoaded_ &&
        this.playlistUriToUrl(this.lastSegmentLoaded_.uri) === this.playlistUriToUrl(segment.uri) &&
        this.lastSegmentLoaded_.byterange === segment.byterange) {
      return this.fillBuffer(mediaIndex + 1);
    }

    // package up all the work to append the segment
    segmentInfo = {
      // resolve the segment URL relative to the playlist
      uri: this.playlistUriToUrl(segment.uri),
      // the segment's mediaIndex & mediaSequence at the time it was requested
      mediaIndex,
      mediaSequence: this.playlists.media().mediaSequence,
      // the segment's playlist
      playlist: this.playlists.media(),
      // The state of the buffer when this segment was requested
      currentBufferedEnd,
      // unencrypted bytes of the segment
      bytes: null,
      // when a key is defined for this segment, the encrypted bytes
      encryptedBytes: null,
      // optionally, the decrypter that is unencrypting the segment
      decrypter: null,
      // the state of the buffer before a segment is appended will be
      // stored here so that the actual segment duration can be
      // determined after it has been appended
      buffered: null,
      // The target timestampOffset for this segment when we append it
      // to the source buffer
      timestampOffset: null
    };

    if (mediaIndex > 0) {
      segmentTimestampOffset = Hls.Playlist.duration(segmentInfo.playlist,
        segmentInfo.playlist.mediaSequence + mediaIndex) + this.playlists.expired_;
    }

    if (this.tech_.seeking() && outsideBufferedRanges) {
      // If there are discontinuities in the playlist, we can't be sure of anything
      // related to time so we reset the timestamp offset and start appending data
      // anew on every seek
      if (segmentInfo.playlist.discontinuityStarts.length) {
        segmentInfo.timestampOffset = segmentTimestampOffset;
      }
    } else if (segment.discontinuity && currentBuffered.length) {
      // If we aren't seeking and are crossing a discontinuity, we should set
      // timestampOffset for new segments to be appended the end of the current
      // buffered time-range
      segmentInfo.timestampOffset = currentBuffered.end(0);
    } else if (!hasBufferedContent && this.tech_.currentTime() > 0.05) {
      // If we are trying to play at a position that is not zero but we aren't
      // currently seeking according to the video element
      segmentInfo.timestampOffset = segmentTimestampOffset;
    }

    this.loadSegment(segmentInfo);
  }

  playlistUriToUrl(segmentRelativeUrl) {
    let playListUrl;

      // resolve the segment URL relative to the playlist
    if (this.playlists.media().uri === this.source_.src) {
      playListUrl = resolveUrl(this.source_.src, segmentRelativeUrl);
    } else {
      playListUrl =
        resolveUrl(resolveUrl(this.source_.src, this.playlists.media().uri || ''),
                   segmentRelativeUrl);
    }
    return playListUrl;
  }

  /*
   * Turns segment byterange into a string suitable for use in
   * HTTP Range requests
   */
  byterangeStr_(byterange) {
    let byterangeStart;
    let byterangeEnd;

    // `byterangeEnd` is one less than `offset + length` because the HTTP range
    // header uses inclusive ranges
    byterangeEnd = byterange.offset + byterange.length - 1;
    byterangeStart = byterange.offset;
    return 'bytes=' + byterangeStart + '-' + byterangeEnd;
  }

  /*
   * Defines headers for use in the xhr request for a particular segment.
   */
  segmentXhrHeaders_(segment) {
    let headers = {};

    if ('byterange' in segment) {
      headers.Range = this.byterangeStr_(segment.byterange);
    }
    return headers;
  }

  /*
   * Sets `bandwidth`, `segmentXhrTime`, and appends to the `bytesReceived.
   * Expects an object with:
   *  * `roundTripTime` - the round trip time for the request we're setting the time for
   *  * `bandwidth` - the bandwidth we want to set
   *  * `bytesReceived` - amount of bytes downloaded
   * `bandwidth` is the only required property.
   */
  setBandwidth(localXhr) {
    // calculate the download bandwidth
    this.segmentXhrTime = localXhr.roundTripTime;
    this.bandwidth = localXhr.bandwidth;
    this.bytesReceived += localXhr.bytesReceived || 0;

    this.tech_.trigger('bandwidthupdate');
  }

  /*
   * Blacklists a playlist when an error occurs for a set amount of time
   * making it unavailable for selection by the rendition selection algorithm
   * and then forces a new playlist (rendition) selection.
   */
  blacklistCurrentPlaylist_(error) {
    let currentPlaylist;
    let nextPlaylist;

    // If the `error` was generated by the playlist loader, it will contain
    // the playlist we were trying to load (but failed) and that should be
    // blacklisted instead of the currently selected playlist which is likely
    // out-of-date in this scenario
    currentPlaylist = error.playlist || this.playlists.media();

    // If there is no current playlist, then an error occurred while we were
    // trying to load the master OR while we were disposing of the tech
    if (!currentPlaylist) {
      this.error = error;
      return this.mediaSource.endOfStream('network');
    }

    // Blacklist this playlist
    currentPlaylist.excludeUntil = Date.now() + blacklistDuration;

    // Select a new playlist
    nextPlaylist = this.selectPlaylist();

    if (nextPlaylist) {
      videojs.log.warn('Problem encountered with the current ' +
                       'HLS playlist. Switching to another playlist.');

      return this.playlists.media(nextPlaylist);
    }
    videojs.log.warn('Problem encountered with the current ' +
                     'HLS playlist. No suitable alternatives found.');
    // We have no more playlists we can select so we must fail
    this.error = error;
    return this.mediaSource.endOfStream('network');
  }

  loadSegment(segmentInfo) {
    let segment = segmentInfo.playlist.segments[segmentInfo.mediaIndex];
    let removeToTime = 0;
    let seekable = this.seekable();
    let currentTime = this.tech_.currentTime();

    // Chrome has a hard limit of 150mb of
    // buffer and a very conservative "garbage collector"
    // We manually clear out the old buffer to ensure
    // we don't trigger the QuotaExceeded error
    // on the source buffer during subsequent appends
    if (this.sourceBuffer && !this.sourceBuffer.updating) {
      // If we have a seekable range use that as the limit for what can be removed safely
      // otherwise remove anything older than 1 minute before the current play head
      if (seekable.length && seekable.start(0) > 0 && seekable.start(0) < currentTime) {
        removeToTime = seekable.start(0);
      } else {
        removeToTime = currentTime - 60;
      }

      if (removeToTime > 0) {
        this.sourceBuffer.remove(0, removeToTime);
      }
    }

    // if the segment is encrypted, request the key
    if (segment.key) {
      this.fetchKey_(segment);
    }

    // request the next segment
    this.segmentXhr_ = this.tech_.hls.xhr({
      uri: segmentInfo.uri,
      responseType: 'arraybuffer',
      withCredentials: this.source_.withCredentials,
      // Set xhr timeout to 150% of the segment duration to allow us
      // some time to switch renditions in the event of a catastrophic
      // decrease in network performance or a server issue.
      timeout: (segment.duration * 1.5) * 1000,
      headers: this.segmentXhrHeaders_(segment)
    }, (error, request) => {
      // This is a timeout of a previously aborted segment request
      // so simply ignore it
      if (!this.segmentXhr_ || request !== this.segmentXhr_) {
        return;
      }

      // the segment request is no longer outstanding
      this.segmentXhr_ = null;

      // if a segment request times out, we may have better luck with another playlist
      if (request.timedout) {
        this.bandwidth = 1;
        return this.playlists.media(this.selectPlaylist());
      }

      // otherwise, trigger a network error
      if (!request.aborted && error) {
        return this.blacklistCurrentPlaylist_({
          status: request.status,
          message: 'HLS segment request error at URL: ' + segmentInfo.uri,
          code: (request.status >= 500) ? 4 : 2
        });
      }

      // stop processing if the request was aborted
      if (!request.response) {
        return;
      }

      this.lastSegmentLoaded_ = segment;
      this.setBandwidth(request);

      if (segment.key) {
        segmentInfo.encryptedBytes = new Uint8Array(request.response);
      } else {
        segmentInfo.bytes = new Uint8Array(request.response);
      }

      this.pendingSegment_ = segmentInfo;

      this.tech_.trigger('progress');
      this.drainBuffer();

      // figure out what stream the next segment should be downloaded from
      // with the updated bandwidth information
      this.playlists.media(this.selectPlaylist());
    });

  }

  drainBuffer() {
    let segmentInfo;
    let mediaIndex;
    let playlist;
    let bytes;
    let segment;
    let decrypter;
    let segIv;

    // if the buffer is empty or the source buffer hasn't been created
    // yet, do nothing
    if (!this.pendingSegment_ || !this.sourceBuffer) {
      return;
    }

    // the pending segment has already been appended and we're waiting
    // for updateend to fire
    if (this.pendingSegment_.buffered) {
      return;
    }

    // we can't append more data if the source buffer is busy processing
    // what we've already sent
    if (this.sourceBuffer.updating) {
      return;
    }

    segmentInfo = this.pendingSegment_;
    mediaIndex = segmentInfo.mediaIndex;
    playlist = segmentInfo.playlist;
    bytes = segmentInfo.bytes;
    segment = playlist.segments[mediaIndex];

    if (segment.key && !bytes) {
      // this is an encrypted segment
      // if the key download failed, we want to skip this segment
      // but if the key hasn't downloaded yet, we want to try again later
      if (keyFailed(segment.key)) {
        return this.blacklistCurrentPlaylist_({
          message: 'HLS segment key request error.',
          code: 4
        });
      } else if (!segment.key.bytes) {
        // waiting for the key bytes, try again later
        return;
      } else if (segmentInfo.decrypter) {
        // decryption is in progress, try again later
        return;
      }
      // if the media sequence is greater than 2^32, the IV will be incorrect
      // assuming 10s segments, that would be about 1300 years
      segIv = segment.key.iv ||
        new Uint32Array([0, 0, 0, mediaIndex + playlist.mediaSequence]);

      // create a decrypter to incrementally decrypt the segment
      decrypter = new Hls.Decrypter(segmentInfo.encryptedBytes,
                                    segment.key.bytes,
                                    segIv,
                                    function(error, localBytes) {
                                      if (error) {
                                        videojs.log.warn(error);
                                      }
                                      segmentInfo.bytes = localBytes;
                                    });
      segmentInfo.decrypter = decrypter;
      return;
    }

    this.pendingSegment_.buffered = this.tech_.buffered();

    if (segmentInfo.timestampOffset !== null) {
      this.sourceBuffer.timestampOffset = segmentInfo.timestampOffset;
    }

    // the segment is asynchronously added to the current buffered data
    this.sourceBuffer.appendBuffer(bytes);
  }

  updateEndHandler_() {
    let segmentInfo = this.pendingSegment_;
    let playlist;
    let currentMediaIndex;
    let currentBuffered;
    let seekable;
    let timelineUpdate;
    let isEndOfStream;

    // stop here if the update errored or was aborted
    if (!segmentInfo) {
      this.pendingSegment_ = null;
      return;
    }

    // In Firefox, the updateend event is triggered for both removing from the buffer and
    // adding to the buffer. To prevent this code from executing on removals, we wait for
    // segmentInfo to have a filled in buffered value before we continue processing.
    if (!segmentInfo.buffered) {
      return;
    }

    this.pendingSegment_ = null;

    playlist = segmentInfo.playlist;
    currentMediaIndex = segmentInfo.mediaIndex +
      (segmentInfo.mediaSequence - playlist.mediaSequence);
    currentBuffered = this.findBufferedRange_();
    isEndOfStream = detectEndOfStream(playlist, this.mediaSource, currentMediaIndex, currentBuffered);

    // if we switched renditions don't try to add segment timeline
    // information to the playlist
    if (segmentInfo.playlist.uri !== this.playlists.media().uri) {
      if (isEndOfStream) {
        return this.mediaSource.endOfStream();
      }
      return this.fillBuffer();
    }

    // when seeking to the beginning of the seekable range, it's
    // possible that imprecise timing information may cause the seek to
    // end up earlier than the start of the range
    // in that case, seek again
    seekable = this.seekable();
    if (this.tech_.seeking() &&
        currentBuffered.length === 0) {
      if (seekable.length &&
          this.tech_.currentTime() < seekable.start(0)) {
        let next = this.findNextBufferedRange_();

        if (next.length) {
          videojs.log('tried seeking to', this.tech_.currentTime(),
                      'but that was too early, retrying at', next.start(0));
          this.tech_.setCurrentTime(next.start(0) + TIME_FUDGE_FACTOR);
        }
      }
    }

    timelineUpdate = Hls.findSoleUncommonTimeRangesEnd_(segmentInfo.buffered,
                                                        this.tech_.buffered());

    // Update segment meta-data (duration and end-point) based on timeline
    updateSegmentMetadata(playlist, currentMediaIndex, timelineUpdate);

    // If we decide to signal the end of stream, then we can return instead
    // of trying to fetch more segments
    if (isEndOfStream) {
      return this.mediaSource.endOfStream();
    }

    if (timelineUpdate !== null ||
        segmentInfo.buffered.length !== this.tech_.buffered().length) {
      this.updateDuration(playlist);
      // check if it's time to download the next segment
      this.fillBuffer();
      return;
    }

    // the last segment append must have been entirely in the
    // already buffered time ranges. just buffer forward until we
    // find a segment that adds to the buffered time ranges and
    // improves subsequent media index calculations.
    this.fillBuffer(currentMediaIndex + 1);
    return;
  }

  /**
   * Attempt to retrieve the key for a particular media segment.
   */
  fetchKey_(segment) {
    let key;
    let settings;
    let receiveKey;

    // if there is a pending XHR or no segments, don't do anything
    if (this.keyXhr_) {
      return;
    }

    settings = this.options_;

    /**
    * Handle a key XHR response.
    */
    receiveKey = (keyRecieved) => {
      return (error, request) => {
        let view;

        this.keyXhr_ = null;

        if (error || !request.response || request.response.byteLength !== 16) {
          keyRecieved.retries = keyRecieved.retries || 0;
          keyRecieved.retries++;
          if (!request.aborted) {
            // try fetching again
            this.fetchKey_(segment);
          }
          return;
        }

        view = new DataView(request.response);
        keyRecieved.bytes = new Uint32Array([
          view.getUint32(0),
          view.getUint32(4),
          view.getUint32(8),
          view.getUint32(12)
        ]);

        // check to see if this allows us to make progress buffering now
        this.checkBuffer_();
      };
    };

    key = segment.key;

    // nothing to do if this segment is unencrypted
    if (!key) {
      return;
    }

    // request the key if the retry limit hasn't been reached
    if (!key.bytes && !keyFailed(key)) {
      this.keyXhr_ = this.tech_.hls.xhr({
        uri: this.playlistUriToUrl(key.uri),
        responseType: 'arraybuffer',
        withCredentials: settings.withCredentials
      }, receiveKey(key));
      return;
    }
  }
}

/**
 * Attempts to find the buffered TimeRange that contains the specified
 * time, or where playback is currently happening if no specific time
 * is specified.
 * @param time (optional) {number} the time to filter on. Defaults to
 * currentTime.
 * @return a new TimeRanges object.
 */
HlsHandler.prototype.findBufferedRange_ =
  filterBufferedRanges(function(start, end, time) {
    return start - TIME_FUDGE_FACTOR <= time &&
      end + TIME_FUDGE_FACTOR >= time;
  });
/**
 * Returns the TimeRanges that begin at or later than the specified
 * time.
 * @param time (optional) {number} the time to filter on. Defaults to
 * currentTime.
 * @return a new TimeRanges object.
 */
HlsHandler.prototype.findNextBufferedRange_ =
  filterBufferedRanges(function(start, end, time) {
    return start - TIME_FUDGE_FACTOR >= time;
  });

/**
 * The Source Handler object, which informs video.js what additional
 * MIME types are supported and sets up playback. It is registered
 * automatically to the appropriate tech based on the capabilities of
 * the browser it is running in. It is not necessary to use or modify
 * this object in normal usage.
 */
const HlsSourceHandler = function(mode) {
  return {
    canHandleSource(srcObj) {
      return HlsSourceHandler.canPlayType(srcObj.type);
    },
    handleSource(source, tech) {
      if (mode === 'flash') {
        // We need to trigger this asynchronously to give others the chance
        // to bind to the event when a source is set at player creation
        tech.setTimeout(function() {
          tech.trigger('loadstart');
        }, 1);
      }
      tech.hls = new HlsHandler(tech, {
        source,
        mode
      });

      tech.hls.xhr = xhrFactory();
      // Use a global `before` function if specified on videojs.Hls.xhr
      // but still allow for a per-player override
      if (videojs.Hls.xhr.beforeRequest) {
        tech.hls.xhr.beforeRequest = videojs.Hls.xhr.beforeRequest;
      }

      tech.hls.src(source.src);
      return tech.hls;
    },
    canPlayType(type) {
      return HlsSourceHandler.canPlayType(type);
    }
  };
};

HlsSourceHandler.canPlayType = function(type) {
  let mpegurlRE = /^application\/(?:x-|vnd\.apple\.)mpegurl/i;

  // favor native HLS support if it's available
  if (Hls.supportsNativeHls) {
    return false;
  }
  return mpegurlRE.test(type);
};

if (typeof videojs.MediaSource === 'undefined' ||
    typeof videojs.URL === 'undefined') {
  videojs.MediaSource = MediaSource;
  videojs.URL = URL;
}

// register source handlers with the appropriate techs
if (MediaSource.supportsNativeMediaSources()) {
  videojs.getComponent('Html5').registerSourceHandler(HlsSourceHandler('html5'));
}
if (window.Uint8Array) {
  videojs.getComponent('Flash').registerSourceHandler(HlsSourceHandler('flash'));
}

videojs.HlsHandler = HlsHandler;
videojs.HlsSourceHandler = HlsSourceHandler;
videojs.Hls = Hls;
videojs.m3u8 = m3u8;

module.exports = {
  Hls,
  HlsHandler,
  HlsSourceHandler
};
