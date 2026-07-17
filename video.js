// PostMann Video Engine
// Handles media pipeline: loading, sync (requestVideoFrameCallback),
// trim in/out, and recording. The UI sets engine.onDrawFrame to composite
// video + overlays onto the shared canvas on every frame.

export class VideoEngine {
  #canvas; #ctx;
  #videoEl = null; #audioEl = null; #blobUrl = null;
  #state = 'idle';
  #duration = 0; #trimIn = 0; #trimOut = 0;
  #rvfcHandle = null; #rafHandle = null;
  #activeAudioCtx = null;
  #recorder = null; #chunks = [];
  #onState; #onTime; #onProgress;
  onTrimOutReached = null; // set by renderVideo to stop MediaRecorder

  /** Set to a () => void function that draws the full frame to the canvas. */
  onDrawFrame = null;

  constructor(canvas, { onStateChange, onTimeUpdate, onProgress } = {}) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.#onState    = onStateChange || (() => {});
    this.#onTime     = onTimeUpdate  || (() => {});
    this.#onProgress = onProgress    || (() => {});
  }

  // ── Getters ──────────────────────────────────────────────────────────────
  get state()        { return this.#state; }
  get duration()     { return this.#duration; }
  get trimIn()       { return this.#trimIn; }
  get trimOut()      { return this.#trimOut; }
  get trimDuration() { return this.#trimOut - this.#trimIn; }
  get currentTime()  { return this.#videoEl?.currentTime ?? 0; }
  get hasVideo()     { return this.#videoEl !== null && this.#duration > 0; }
  get blobUrl()      { return this.#blobUrl; }
  get audioEl()      { return this.#audioEl; }   // needed by renderVideo for audio capture
  
  // Start real-time playback from a position — used by render flow
  playFrom(t) {
    if (!this.#videoEl) return;
    // Safety net: if RVFC/RAF never fires the trimOut check (e.g. video ends
    // naturally and the browser stops delivering frame callbacks), the 'ended'
    // event guarantees the recorder is stopped and the render promise resolves.
    const endedSafety = () => {
      this.#stopLoop();
      this.#setState('ready');
      this.onTrimOutReached?.();
    };
    this.#videoEl.addEventListener('ended', endedSafety, { once: true });
    this.#videoEl.currentTime = t;
    this.#videoEl.play().catch(() => {});
    this.#setState('recording');
    this.#startRecordLoop();
  }
  
  // Stop active recording (called by video-render.js when trimOut is reached)
  stopRecording() {
    if (this._recordPollId) { clearInterval(this._recordPollId); this._recordPollId = null; }
    this.#videoEl?.pause();
    this.#audioEl?.pause();
    this.#stopLoop();
    this.#setState('ready');
  }
  get isPlaying()    { return this.#state === 'playing'; }
  get isRecording()  { return this.#state === 'recording'; }

  // ── Draw the current video frame cover-fit into a rect (called by UI) ────
  drawVideoInto(ctx, x, y, w, h) {
    if (!this.#videoEl || !this.#videoEl.videoWidth) return;
    const vw = this.#videoEl.videoWidth, vh = this.#videoEl.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const sw = vw * scale, sh = vh * scale;
    ctx.drawImage(this.#videoEl, x + (w - sw) / 2, y + (h - sh) / 2, sw, sh);
  }

  // ── Load a video file ─────────────────────────────────────────────────────
  async load(file) {
    this.#cleanup();
    this.#setState('loading');
    this.#blobUrl = URL.createObjectURL(file);

    // Muted video element drives canvas drawing
    this.#videoEl = document.createElement('video');
    this.#videoEl.muted = true; this.#videoEl.playsInline = true; this.#videoEl.preload = 'auto';
    this.#videoEl.src = this.#blobUrl;

    // Unmuted audio element provides the audio track for recording.
    // A fresh element per load avoids the createMediaElementSource
    // "consumed element" bug that silently drops audio on second render.
    this.#audioEl = document.createElement('audio');
    this.#audioEl.src = this.#blobUrl; this.#audioEl.preload = 'auto';
    // Unlock iOS autoplay while we're still inside the file-picker user gesture
    this.#audioEl.play().then(() => { this.#audioEl.pause(); this.#audioEl.currentTime = 0; }).catch(() => {});

    await new Promise((resolve, reject) => {
      this.#videoEl.onloadedmetadata = resolve;
      this.#videoEl.onerror = () => reject(new Error('Could not load the video file.'));
    });

    this.#duration = this.#videoEl.duration;
    this.#trimIn = 0; this.#trimOut = this.#duration;

    // Show first frame immediately
    await this.#seekTo(0);
    this.onDrawFrame?.();
    this.#setState('ready');
    return { duration: this.#duration };
  }

  // ── Thumbnail filmstrip for the timeline ──────────────────────────────────
  async generateThumbnails(count = 10) {
    if (!this.#videoEl || !this.#duration) return [];
    const tc = document.createElement('canvas'); tc.width = 80; tc.height = 45;
    const tctx = tc.getContext('2d');
    const thumbs = [];
    for (let i = 0; i < count; i++) {
      const t = this.#duration * i / Math.max(1, count - 1);
      await this.#seekTo(t);
      tctx.drawImage(this.#videoEl, 0, 0, 80, 45);
      const blob = await new Promise(r => tc.toBlob(r, 'image/jpeg', 0.5));
      thumbs.push({ time: t, url: URL.createObjectURL(blob) });
    }
    await this.#seekTo(this.#trimIn); this.onDrawFrame?.();
    return thumbs;
  }

  // ── Trim ─────────────────────────────────────────────────────────────────
  setTrimIn(t)  { this.#trimIn  = Math.max(0, Math.min(t, this.#trimOut - 0.1, this.#duration)); }
  setTrimOut(t) { this.#trimOut = Math.max(this.#trimIn + 0.1, Math.min(t, this.#duration)); }

  // ── Seek ─────────────────────────────────────────────────────────────────
  async seek(t) {
    if (!this.#videoEl) return;
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.#videoEl.pause();
      if (this.#audioEl) this.#audioEl.pause();
      this.#stopLoop();
    }
    await this.#seekTo(Math.max(0, Math.min(t, this.#duration)));
    // Keep audio element in sync with video position.
    // During WebCodecs render, engine is in 'ready' state so wasPlaying is false
    // and #doPlay() is never called — audio stays silent. Correct behaviour.
    if (this.#audioEl) this.#audioEl.currentTime = this.#videoEl.currentTime;
    this.onDrawFrame?.(); this.#onTime(this.currentTime);
    if (wasPlaying) this.#doPlay();
  }

  // ── Play / Pause ─────────────────────────────────────────────────────────
  play() {
    if (!this.#videoEl || this.isRecording) return;
    this.#stopLoop();
    const atEnd = this.currentTime >= this.#trimOut - 0.05 || this.#videoEl.ended;
    if (atEnd) {
      // MOBILE FIX: videoEl.play() must be called SYNCHRONOUSLY inside the
      // user gesture. If we await a seek first, iOS/Android blocks the play.
      // Setting currentTime synchronously un-sets the 'ended' flag so play()
      // works immediately. RVFC picks up the correct position once the internal
      // seek settles.
      this.#videoEl.currentTime = this.#trimIn;
      if (this.#audioEl) this.#audioEl.currentTime = this.#trimIn;
      this.#videoEl.play().catch(() => {});
      if (this.#audioEl) this.#audioEl.play().catch(() => {});
      this.#setState('playing');
      this.#startPreviewLoop();
    } else {
      this.#doPlay();
    }
  }

  pause() {
    if (!this.isPlaying) return;
    this.#videoEl.pause();
    if (this.#audioEl) this.#audioEl.pause();
    this.#stopLoop(); this.#setState('ready');
  }

  toggle() { this.isPlaying ? this.pause() : this.play(); }

  // ── Record the trimmed region ─────────────────────────────────────────────
  // Returns Promise<Blob> that resolves when the recording is complete.
  async record(mimeType, videoBitsPerSecond) {
    if (!this.#videoEl || this.isRecording) return;
    if (this.isPlaying) this.pause();

    this.#setState('recording');
    this.#chunks = [];

    await this.#seekTo(this.#trimIn);

    const stream = this.#canvas.captureStream(30);

    // ── Audio capture strategy ────────────────────────────────────────────
    // Chrome / Android: captureStream() on the video element gives us the
    // decoded audio track directly — no Web Audio processing, no resampling,
    // no latency offset. This is the cleanest path and produces the best sync.
    //
    // iOS / Safari: captureStream() on media elements isn't supported.
    // We fall back to Web Audio API, but route through a near-silent gain
    // node instead of connecting directly to audioCtx.destination.
    // The original approach (connect to destination = play through speakers)
    // caused distortion because iOS changes its audio session routing when
    // something plays through the speaker while the AudioContext is running.
    // The silent gain node keeps the context alive without triggering that.

    let audioMethod = 'none';

    // Try direct stream capture first (Chrome / Android / Firefox)
    if (this.#videoEl.captureStream) {
      try {
        const vs = this.#videoEl.captureStream();
        const audioTracks = vs.getAudioTracks();
        if (audioTracks.length > 0) {
          audioTracks.forEach(t => stream.addTrack(t));
          audioMethod = 'directStream';
        }
      } catch(e) { /* fall through to Web Audio */ }
    }

    // iOS fallback: Web Audio with silent keepalive
    if (audioMethod === 'none' && this.#audioEl) {
      try {
        this.#activeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        await this.#activeAudioCtx.resume();

        const src  = this.#activeAudioCtx.createMediaElementSource(this.#audioEl);
        const dest = this.#activeAudioCtx.createMediaStreamDestination();
        src.connect(dest);

        // Keep context alive with a near-silent oscillator — prevents iOS from
        // suspending the context WITHOUT routing the source audio through speakers
        // (which was the cause of the distortion).
        const keepAlive = this.#activeAudioCtx.createOscillator();
        const silence   = this.#activeAudioCtx.createGain();
        silence.gain.value = 0.0001;
        keepAlive.connect(silence);
        silence.connect(this.#activeAudioCtx.destination);
        keepAlive.start();

        this.#activeAudioCtx.addEventListener('statechange', () => {
          if (this.#activeAudioCtx?.state === 'suspended') {
            this.#activeAudioCtx.resume().catch(() => {});
          }
        });

        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        audioMethod = 'webAudio';
      } catch(e) {
        console.warn('Audio capture unavailable:', e.message);
      }
    }

    console.log(`Recording: audio method = ${audioMethod}`);

    const opts = { videoBitsPerSecond };
    if (mimeType) opts.mimeType = mimeType;
    this.#recorder = new MediaRecorder(stream, opts);
    this.#recorder.ondataavailable = e => { if (e.data.size > 0) this.#chunks.push(e.data); };
    this.#recorder.start(100);

    this.#videoEl.play();
    // For Web Audio path, also play the separate audio element
    if (audioMethod === 'webAudio' && this.#audioEl) {
      this.#audioEl.currentTime = this.#trimIn;
      this.#audioEl.play();
    }
    this.#startRecordLoop();

    return new Promise(resolve => {
      this.#recorder.onstop = () => {
        const blob = new Blob(this.#chunks, { type: mimeType || 'video/webm' });
        if (this.#activeAudioCtx) {
          this.#activeAudioCtx.close().catch(() => {});
          this.#activeAudioCtx = null;
        }
        if (this.#audioEl) this.#audioEl.pause();
        this.#videoEl.pause();
        this.#setState('ready');
        resolve(blob);
      };
    });
  }

  stopRecord() { if (this.#recorder?.state !== 'inactive') this.#recorder.stop(); }
  destroy()    { this.#cleanup(); }

  // ── Private ───────────────────────────────────────────────────────────────
  #setState(s) { this.#state = s; this.#onState(s); }

  async #seekTo(t) {
    this.#videoEl.currentTime = t;
    await new Promise(r => this.#videoEl.addEventListener('seeked', r, { once: true }));
  }

  #doPlay() {
    this.#videoEl.play().catch(() => {});
    if (this.#audioEl) {
      this.#audioEl.currentTime = this.#videoEl.currentTime;
      this.#audioEl.play().catch(() => {});
    }
    // When the video ends naturally, pause the preview cleanly.
    // Without this, RVFC stops firing (no new frames) but state stays 'playing',
    // causing the glitch when the user tries to play again.
    this.#videoEl.addEventListener('ended', () => {
      if (this.isPlaying) {
        this.#stopLoop();
        this.#setState('ready');
        this.onDrawFrame?.(); // redraw final frame without the playing-state overlay
      }
    }, { once: true });
    this.#setState('playing');
    this.#startPreviewLoop();
  }

  // requestVideoFrameCallback fires in sync with the video decoder —
  // meta.mediaTime is the exact decoded timestamp, not wall-clock time.
  // This eliminates the drift that RAF-based loops produce over long clips.
  #useRVFC() { return 'requestVideoFrameCallback' in HTMLVideoElement.prototype; }

  #startPreviewLoop() {
    this.#stopLoop();
    if (this.#useRVFC()) {
      const loop = (_, meta) => {
        if (!this.isPlaying) return;
        this.onDrawFrame?.(); this.#onTime(meta.mediaTime);
        if (meta.mediaTime >= this.#trimOut) { this.pause(); return; }
        this.#rvfcHandle = this.#videoEl.requestVideoFrameCallback(loop);
      };
      this.#rvfcHandle = this.#videoEl.requestVideoFrameCallback(loop);
    } else {
      const loop = () => {
        if (!this.isPlaying) return;
        this.onDrawFrame?.(); this.#onTime(this.currentTime);
        if (this.currentTime >= this.#trimOut) { this.pause(); return; }
        this.#rafHandle = requestAnimationFrame(loop);
      };
      this.#rafHandle = requestAnimationFrame(loop);
    }
  }

  #startRecordLoop() {
    this.#stopLoop();
    const SYNC = 0.15;
    const needsSync = () => this.#audioEl && !this.#audioEl.paused && this.#activeAudioCtx;

    // Redundant fallback: poll every 200ms so the recorder stops even if the
    // RVFC/RAF callback chain dies silently (e.g. thrown error inside callback,
    // mobile-specific frame timing issue, or background tab throttling).
    const pollId = setInterval(() => {
      if (!this.isRecording) { clearInterval(pollId); return; }
      if (this.#videoEl && this.#videoEl.currentTime >= this.#trimOut) {
        clearInterval(pollId);
        this.#videoEl.pause();
        this.#stopLoop();
        this.#setState('ready');
        this.onTrimOutReached?.();
      }
    }, 200);
    // Store so stopRecording() can clear it
    this._recordPollId = pollId;

    if (this.#useRVFC()) {
      const loop = (_, meta) => {
        if (!this.isRecording) return;
        // Correct audio drift only in Web Audio path; direct stream doesn't need it
        if (needsSync() && Math.abs(this.#audioEl.currentTime - meta.mediaTime) > SYNC) {
          this.#audioEl.currentTime = meta.mediaTime;
        }
        this.onDrawFrame?.(); this.#onTime(meta.mediaTime);
        this.#onProgress((meta.mediaTime - this.#trimIn) / Math.max(0.01, this.trimDuration));
        if (meta.mediaTime >= this.#trimOut) { this.#videoEl?.pause(); this.#stopLoop(); this.#setState('ready'); this.onTrimOutReached?.(); return; }
        this.#rvfcHandle = this.#videoEl.requestVideoFrameCallback(loop);
      };
      this.#rvfcHandle = this.#videoEl.requestVideoFrameCallback(loop);
    } else {
      const loop = () => {
        if (!this.isRecording) return;
        const ct = this.currentTime;
        if (needsSync() && Math.abs(this.#audioEl.currentTime - ct) > SYNC) this.#audioEl.currentTime = ct;
        this.onDrawFrame?.(); this.#onTime(ct);
        this.#onProgress((ct - this.#trimIn) / Math.max(0.01, this.trimDuration));
        if (ct >= this.#trimOut) { this.#videoEl?.pause(); this.#stopLoop(); this.#setState('ready'); this.onTrimOutReached?.(); return; }
        this.#rafHandle = requestAnimationFrame(loop);
      };
      this.#rafHandle = requestAnimationFrame(loop);
    }
  }

  #stopLoop() {
    if (this.#rvfcHandle && this.#videoEl) {
      try { this.#videoEl.cancelVideoFrameCallback(this.#rvfcHandle); } catch(e) {}
      this.#rvfcHandle = null;
    }
    if (this.#rafHandle) { cancelAnimationFrame(this.#rafHandle); this.#rafHandle = null; }
  }

  #cleanup() {
    this.#stopLoop();
    if (this.#recorder?.state !== 'inactive') try { this.#recorder.stop(); } catch(e) {}
    if (this.#activeAudioCtx) { this.#activeAudioCtx.close().catch(() => {}); this.#activeAudioCtx = null; }
    if (this.#videoEl) { this.#videoEl.pause(); this.#videoEl.src = ''; this.#videoEl = null; }
    if (this.#audioEl) { this.#audioEl.pause(); this.#audioEl.src = ''; this.#audioEl = null; }
    if (this.#blobUrl) { URL.revokeObjectURL(this.#blobUrl); this.#blobUrl = null; }
    this.#recorder = null; this.#chunks = [];
  }
}

// bestMimeType() has moved to video-render.js