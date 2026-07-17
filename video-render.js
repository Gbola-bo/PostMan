// PostMann Video Render Engine — WebCodecs
//
// Flow:
//   1. Detect which codec + muxer combo this device supports
//   2. Decode source audio to PCM (zero quality loss, no re-encoding distortion)
//   3. Encode audio chunks with CORRECT planar layout
//   4. Seek video frame-by-frame and encode with matching µs timestamps
//   5. Mux into MP4 or WebM — perfect A/V sync by construction

export const WEBCODECS_AVAILABLE =
  typeof VideoEncoder !== 'undefined' &&
  typeof AudioEncoder !== 'undefined';

// ── Codec profiles in preference order ───────────────────────────────────
// H.264 + AAC → MP4 is widest-device compatible.
// VP9 + Opus → WebM is the fallback for devices where H.264 fails.
const PROFILES = [
  {
    label:     'H.264 + AAC → MP4',
    videoCodec: 'avc1.42001f',
    audioCodec: 'mp4a.40.2',
    muxerPkg:  'mp4-muxer@4',
    ext:       'mp4',
    mimeType:  'video/mp4',
    muxerVideo: { codec: 'avc' },
    muxerAudio: (ch, sr) => ({ codec: 'aac', numberOfChannels: ch, sampleRate: sr }),
    audioEncoderCodec: 'mp4a.40.2',
  },
  {
    label:     'VP9 + Opus → WebM',
    videoCodec: 'vp09.00.10.08',
    audioCodec: 'opus',
    muxerPkg:  'webm-muxer@3',
    ext:       'webm',
    mimeType:  'video/webm',
    muxerVideo: { codec: 'V_VP9' },
    muxerAudio: (ch, sr) => ({ codec: 'A_OPUS', numberOfChannels: ch, sampleRate: sr }),
    audioEncoderCodec: 'opus',
  },
  {
    label:     'VP8 + Opus → WebM',
    videoCodec: 'vp8',
    audioCodec: 'opus',
    muxerPkg:  'webm-muxer@3',
    ext:       'webm',
    mimeType:  'video/webm',
    muxerVideo: { codec: 'V_VP8' },
    muxerAudio: (ch, sr) => ({ codec: 'A_OPUS', numberOfChannels: ch, sampleRate: sr }),
    audioEncoderCodec: 'opus',
  },
];

// ── Pick the first profile this device actually supports ──────────────────
async function detectProfile(W, H, fps, bitrate) {
  for (const p of PROFILES) {
    try {
      const [vs, as] = await Promise.all([
        VideoEncoder.isConfigSupported({
          codec: p.videoCodec, width: W, height: H, bitrate, framerate: fps,
        }),
        AudioEncoder.isConfigSupported({
          codec: p.audioCodec, numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000,
        }),
      ]);
      if (vs.supported && as.supported) {
        console.log('WebCodecs: using', p.label);
        return p;
      }
    } catch(e) { /* try next */ }
  }
  throw new Error(
    'No supported WebCodecs codec found on this device.\n' +
    'Try Chrome 94+ on desktop/Android, or update iOS to 16.4+.'
  );
}

// ── Load the right muxer from CDN ─────────────────────────────────────────
async function loadMuxer(pkg) {
  const urls = [
    `https://esm.sh/${pkg}`,
    `https://cdn.skypack.dev/${pkg}`,
    `https://cdn.jsdelivr.net/npm/${pkg.replace('@', '/').replace(/\/([^/]+)$/, '/build/$1.js')}`,
  ];
  for (const url of urls) {
    try {
      const mod   = await import(url);
      const Muxer = mod.Muxer ?? mod.default?.Muxer;
      const ABT   = mod.ArrayBufferTarget ?? mod.default?.ArrayBufferTarget;
      if (typeof Muxer === 'function' && typeof ABT === 'function') {
        return { Muxer, ArrayBufferTarget: ABT };
      }
    } catch(e) { /* try next */ }
  }
  throw new Error(`Could not load ${pkg} from any CDN. Check internet connection.`);
}

// ── Seek with timeout (mobile browsers can hang on fast sequential seeks) ─
async function seekWithTimeout(seekFn, t, timeoutMs = 3000) {
  await Promise.race([
    seekFn(t),
    new Promise(r => setTimeout(r, timeoutMs)), // fallback: continue after timeout
  ]);
}

// ── Main render function ──────────────────────────────────────────────────
/**
 * @param {HTMLCanvasElement} opts.canvas
 * @param {Function}          opts.drawFrame     () => void
 * @param {Function}          opts.seekTo        async (t) => void
 * @param {string}            opts.blobUrl       blob: URL of source video
 * @param {number}            opts.trimIn
 * @param {number}            opts.trimOut
 * @param {number}            opts.videoBitrate
 * @param {number}            opts.fps
 * @param {Function}          opts.onProgress    (0..1, label) => void
 * @returns {Promise<{blob: Blob, ext: string, mimeType: string}>}
 */
export async function renderVideo({
  canvas, drawFrame, seekTo, blobUrl,
  trimIn, trimOut, videoBitrate, fps = 30, onProgress,
}) {
  if (!WEBCODECS_AVAILABLE) {
    throw new Error('WebCodecs is not supported. Use Chrome 94+ or iOS 16.4+.');
  }

  const W = canvas.width, H = canvas.height;
  const duration    = trimOut - trimIn;
  const totalFrames = Math.round(duration * fps);

  // ── 1. Detect supported codec + load muxer ───────────────────────────────
  onProgress?.(0, 'Detecting codec support…');
  const profile = await detectProfile(W, H, fps, videoBitrate);
  onProgress?.(0, `Loading muxer (${profile.label})…`);
  const { Muxer, ArrayBufferTarget } = await loadMuxer(profile.muxerPkg);

  // ── 2. Decode source audio to PCM ────────────────────────────────────────
  onProgress?.(0, 'Decoding source audio…');
  let audioBuffer = null;
  let audioChs = 0, audioRate = 44100;
  try {
    const arrayBuffer = await fetch(blobUrl).then(r => r.arrayBuffer());
    const tmpCtx      = new (window.AudioContext || window.webkitAudioContext)();
    audioBuffer       = await tmpCtx.decodeAudioData(arrayBuffer);
    audioChs  = audioBuffer.numberOfChannels;
    audioRate = audioBuffer.sampleRate;
    await tmpCtx.close();
  } catch(e) {
    console.warn('renderVideo: could not decode audio —', e.message, '— output will be silent.');
  }

  // ── 3. Set up muxer ──────────────────────────────────────────────────────
  const target    = new ArrayBufferTarget();
  const muxerOpts = {
    target,
    video:      { ...profile.muxerVideo, width: W, height: H },
    fastStart:  'in-memory',
  };
  if (audioBuffer) muxerOpts.audio = profile.muxerAudio(audioChs, audioRate);
  const muxer = new Muxer(muxerOpts);

  // ── 4. Set up encoders with shared error state ───────────────────────────
  // Errors inside WebCodecs callbacks are swallowed by default — we capture
  // them here and check after every operation.
  let encodeError = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => { if (!encodeError) muxer.addVideoChunk(chunk, meta); },
    error:  (e) => { encodeError = new Error('VideoEncoder: ' + e.message); },
  });
  videoEncoder.configure({
    codec:        profile.videoCodec,
    width:        W,
    height:       H,
    bitrate:      videoBitrate,
    framerate:    fps,
    bitrateMode:  'variable',
    latencyMode:  'quality',
  });

  let audioEncoder = null;
  if (audioBuffer) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => { if (!encodeError) muxer.addAudioChunk(chunk, meta); },
      error:  (e) => { encodeError = new Error('AudioEncoder: ' + e.message); },
    });
    audioEncoder.configure({
      codec:           profile.audioEncoderCodec,
      numberOfChannels: audioChs,
      sampleRate:       audioRate,
      bitrate:          192_000,
    });
  }

  // ── 5. Encode audio (fast — no seeking needed) ───────────────────────────
  // KEY FIX: f32-planar layout is ALL samples for channel 0, then ALL samples
  // for channel 1. The previous code used INTERLEAVED layout (L0,R0,L1,R1…)
  // which the decoder interprets as completely wrong samples → distortion.
  if (audioBuffer && audioEncoder) {
    const startSample   = Math.floor(trimIn  * audioRate);
    const endSample     = Math.ceil(trimOut  * audioRate);
    const totalSamples  = endSample - startSample;
    const CHUNK_SAMPLES = Math.round(audioRate * 0.02); // 20ms chunks

    for (let offset = 0; offset < totalSamples; offset += CHUNK_SAMPLES) {
      if (encodeError) throw encodeError;

      const len       = Math.min(CHUNK_SAMPLES, totalSamples - offset);
      const timestamp = Math.round((offset / audioRate) * 1_000_000); // µs

      // CORRECT f32-planar: channel 0 samples then channel 1 samples
      // [L0, L1, L2, ..., Ln, R0, R1, R2, ..., Rn]
      const data = new Float32Array(len * audioChs);
      for (let ch = 0; ch < audioChs; ch++) {
        const src = audioBuffer.getChannelData(ch);
        // Each channel's samples go into a contiguous block
        for (let i = 0; i < len; i++) {
          data[ch * len + i] = src[startSample + offset + i];
        }
      }

      const audioData = new AudioData({
        format:           'f32-planar',
        sampleRate:       audioRate,
        numberOfChannels: audioChs,
        numberOfFrames:   len,
        timestamp,
        data,
      });
      audioEncoder.encode(audioData);
      audioData.close();
    }
    await audioEncoder.flush();
    if (encodeError) throw encodeError;
  }

  // ── 6. Encode video frames ────────────────────────────────────────────────
  for (let i = 0; i < totalFrames; i++) {
    if (encodeError) throw encodeError;

    const t = trimIn + i / fps;
    onProgress?.(i / totalFrames, `Rendering frame ${i + 1} of ${totalFrames}…`);

    // Seek with timeout — mobile browsers sometimes stall on rapid seeks
    await seekWithTimeout(seekTo, t);
    drawFrame();

    const timestamp_us = Math.round((i / fps) * 1_000_000);
    const duration_us  = Math.round((1 / fps) * 1_000_000);

    const frame    = new VideoFrame(canvas, { timestamp: timestamp_us, duration: duration_us });
    const keyFrame = i === 0 || i % (fps * 2) === 0;
    videoEncoder.encode(frame, { keyFrame });
    frame.close();

    // Yield to the browser every 5 frames so the UI stays responsive
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await videoEncoder.flush();
  if (encodeError) throw encodeError;

  muxer.finalize();

  const { buffer } = target;
  return {
    blob:     new Blob([buffer], { type: profile.mimeType }),
    ext:      profile.ext,
    mimeType: profile.mimeType,
  };
}