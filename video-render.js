// PostMann Video Render — Real-time canvas recording
//
// A 12-second clip takes ~12 seconds to render. That is correct and expected.
// Real-time recording is:
//   - Faster than seek-by-seek on mobile (no 412 seeks for a 30fps clip)
//   - Simpler and more reliable than WebCodecs pipelines
//   - What every browser-based video tool actually uses
//
// Audio capture strategy (tried in order):
//   1. audioEl.captureStream() — Chrome / Android / Firefox
//      The cleanest approach: no Web Audio processing, no latency, no distortion.
//      The audio element is never muted so the stream includes the audio track.
//   2. Web Audio API — iOS Safari fallback
//      Uses a near-silent oscillator to keep the AudioContext alive WITHOUT
//      routing the source audio through the device speakers.
//      Routing to speakers was what caused the distortion in previous attempts.

export function renderSupported() {
  return !!(
    typeof MediaRecorder !== 'undefined' &&
    HTMLCanvasElement.prototype.captureStream
  );
}

export function bestMimeType() {
  return ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Record the trimmed video region with the canvas overlay composited on top.
 *
 * @param {object}   opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {Function}          opts.drawFrame      () => void — draws video + overlay each frame
 * @param {Function}          opts.seekTo         async (t) => void
 * @param {Function}          opts.playFrom       (t) => void — starts real-time playback from t
 * @param {Function}          opts.stopPlayback   () => void
 * @param {HTMLAudioElement}  opts.audioEl        — the never-muted audio element
 * @param {number}            opts.trimIn
 * @param {number}            opts.trimOut
 * @param {number}            opts.videoBitrate
 * @param {Function}          opts.onProgress     (pct, label) => void
 * @returns {Promise<{blob, ext, mimeType}>}
 */
export async function renderVideo({
  canvas, drawFrame, seekTo, playFrom, stopPlayback,
  audioEl, trimIn, trimOut, videoBitrate, onProgress,
  registerStop,   // (stopFn) => void — caller uses this to wire recorder.stop to engine events
}) {
  if (!renderSupported()) {
    throw new Error('canvas.captureStream() is not supported. Try Chrome or update your browser.');
  }

  const mimeType    = bestMimeType();
  const duration    = trimOut - trimIn;
  const canvasStream = canvas.captureStream(30);

  // ── Audio capture ────────────────────────────────────────────────────────
  let audioMethod   = 'none';
  let activeAudioCtx = null;

  if (audioEl) {
    // Method 1: Direct stream capture — Chrome, Android, Firefox
    const captureStream = audioEl.captureStream || audioEl.mozCaptureStream;
    if (captureStream) {
      try {
        const as = captureStream.call(audioEl);
        const tracks = as.getAudioTracks();
        if (tracks.length > 0) {
          tracks.forEach(t => canvasStream.addTrack(t));
          audioMethod = 'directCapture';
        }
      } catch(e) { /* fall through */ }
    }

    // Method 2: Web Audio API — iOS Safari (captureStream unavailable)
    // Route source → capture destination only.
    // A near-silent oscillator keeps iOS from suspending the AudioContext
    // WITHOUT playing the source audio through the speakers (which caused distortion).
    if (audioMethod === 'none') {
      try {
        activeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        await activeAudioCtx.resume();
        activeAudioCtx.addEventListener('statechange', () => {
          if (activeAudioCtx?.state === 'suspended') activeAudioCtx.resume().catch(() => {});
        });

        const src  = activeAudioCtx.createMediaElementSource(audioEl);
        const dest = activeAudioCtx.createMediaStreamDestination();
        src.connect(dest);

        // Keep context alive on iOS: near-silent oscillator → destination
        // This prevents iOS suspending the context WITHOUT causing audio distortion
        const osc = activeAudioCtx.createOscillator();
        const sil = activeAudioCtx.createGain();
        sil.gain.value = 0.00001;
        osc.connect(sil); sil.connect(activeAudioCtx.destination);
        osc.start();

        dest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));
        audioMethod = 'webAudio';
      } catch(e) {
        console.warn('Audio capture unavailable:', e.message);
        if (activeAudioCtx) { activeAudioCtx.close().catch(() => {}); activeAudioCtx = null; }
      }
    }
  }

  console.log(`renderVideo: audio method = ${audioMethod}, mimeType = ${mimeType || 'default'}`);

  // ── MediaRecorder setup ───────────────────────────────────────────────────
  const recOpts = { videoBitsPerSecond: videoBitrate };
  if (mimeType) recOpts.mimeType = mimeType;
  const recorder = new MediaRecorder(canvasStream, recOpts);
  const chunks   = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  // Give the caller a way to stop the recorder (wired to engine.onTrimOutReached)
  registerStop?.(() => { if (recorder.state !== 'inactive') recorder.stop(); });

  // ── Seek to trim start ────────────────────────────────────────────────────
  await seekTo(trimIn);
  if (audioEl) audioEl.currentTime = trimIn;

  // ── Start recording, then start playback ──────────────────────────────────
  recorder.start(100);
  playFrom(trimIn); // engine plays the video at real speed from trimIn
  if (audioMethod !== 'none' && audioEl) audioEl.play().catch(() => {});

  // ── Progress reporting ────────────────────────────────────────────────────
  const startTime = Date.now();
  const progressId = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const pct     = Math.min(1, elapsed / duration);
    onProgress?.(pct, `${elapsed.toFixed(0)}s / ${duration.toFixed(0)}s`);
  }, 300);

  // ── Wait for recording to complete ───────────────────────────────────────
  // The engine's record loop stops at trimOut and calls stopRecording() which
  // the caller wires to recorder.stop().
  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      clearInterval(progressId);
      if (audioEl) audioEl.pause();
      if (activeAudioCtx) { activeAudioCtx.close().catch(() => {}); }
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const ext  = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
      resolve({ blob, ext, mimeType: mimeType || 'video/webm' });
    };
    recorder.onerror = e => { clearInterval(progressId); reject(new Error('MediaRecorder: ' + e.error)); };
  });
}