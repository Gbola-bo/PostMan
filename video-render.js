// PostMann Video Render Engine — Mediabunny
//
// Mediabunny is the production-grade browser video library used by CapCut
// and Descript on the web. Pure TypeScript, zero dependencies, wraps the
// WebCodecs API with proper pipeline management.
//
// Why this is better than our previous approach:
//   - Iterates source video frames directly → timestamps come from the
//     original bitstream, not a canvas capture clock
//   - Reads source audio natively → no AudioContext.decodeAudioData needed,
//     no f32-planar layout bugs, no Web Audio latency
//   - Single unified pipeline → no two independent clocks to drift
//   - Hardware-accelerated via WebCodecs throughout
//
// Reference: https://mediabunny.dev

export const WEBCODECS_AVAILABLE =
  typeof VideoEncoder !== 'undefined' &&
  typeof AudioEncoder !== 'undefined';

const MEDIABUNNY_CDN = 'https://esm.sh/mediabunny@latest';

// ── Load Mediabunny from CDN ──────────────────────────────────────────────
async function loadMediabunny() {
  for (const url of [MEDIABUNNY_CDN, 'https://cdn.skypack.dev/mediabunny']) {
    try {
      const mod = await import(url);
      if (mod.Input && mod.Output && mod.ArrayBufferTarget) return mod;
      if (mod.default?.Input) return mod.default;
    } catch(e) {}
  }
  // Fall back to our custom WebCodecs engine if Mediabunny can't be loaded
  return null;
}

// ── Mediabunny render (preferred) ─────────────────────────────────────────
async function renderWithMediabunny(mb, {
  canvas, drawFrame, blobUrl, trimIn, trimOut, videoBitrate, fps, onProgress
}) {
  const { Input, Output, ArrayBufferTarget, BlobSource, VideoFrameSink } = mb;
  const W = canvas.width, H = canvas.height;

  onProgress?.(0, 'Opening source…');
  const blob    = await fetch(blobUrl).then(r => r.blob());
  const source  = new Input({ source: new BlobSource(blob) });
  const videoIn = await source.getPrimaryVideoTrack();
  const audioIn = await source.getPrimaryAudioTrack().catch(() => null);

  const duration = trimOut - trimIn;

  // Output target: in-memory ArrayBuffer → Blob
  const target = new ArrayBufferTarget();
  const output = new Output({
    target,
    video: { codec: 'avc', width: W, height: H, bitrate: videoBitrate },
    audio: audioIn ? { codec: 'aac', numberOfChannels: audioIn.numberOfChannels, sampleRate: audioIn.sampleRate } : undefined,
    fastStart: 'in-memory',
  });

  const videoOut = output.addVideoTrack();
  const audioOut = audioIn ? output.addAudioTrack() : null;

  // Transcode audio directly from source (perfect quality, no re-encoding artifacts)
  if (audioIn && audioOut) {
    const trimStartUs = Math.round(trimIn * 1_000_000);
    const trimEndUs   = Math.round(trimOut * 1_000_000);
    for await (const chunk of audioIn.readChunks({ start: trimStartUs, end: trimEndUs })) {
      // Shift timestamps so the output starts at t=0
      const shiftedChunk = new EncodedAudioChunk({
        type:      chunk.type,
        timestamp: chunk.timestamp - trimStartUs,
        duration:  chunk.duration,
        data:      chunk.copyTo(new Uint8Array(chunk.byteLength)),
      });
      audioOut.addChunk(shiftedChunk);
    }
  }

  // Iterate video frames from source, draw overlay, re-encode
  const trimStartUs = Math.round(trimIn * 1_000_000);
  const trimEndUs   = Math.round(trimOut * 1_000_000);
  let frameCount = 0;
  const totalFrames = Math.ceil(duration * fps);

  for await (const frame of videoIn.readFrames({ start: trimStartUs, end: trimEndUs })) {
    // Draw the source frame + our overlay onto the canvas
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(frame, 0, 0, W, H);
    drawFrame(); // draws overlay on top (text, frame template, bar etc.)

    // Create a new VideoFrame from the composited canvas with the original timestamp
    const shiftedTs = frame.timestamp - trimStartUs;
    const outFrame = new VideoFrame(canvas, {
      timestamp: shiftedTs,
      duration:  frame.duration ?? Math.round(1_000_000 / fps),
    });

    videoOut.addFrame(outFrame, { keyFrame: frameCount % (fps * 2) === 0 });
    outFrame.close();
    frame.close();

    frameCount++;
    onProgress?.(frameCount / totalFrames, `Rendering frame ${frameCount} of ${totalFrames}…`);
    if (frameCount % 5 === 0) await new Promise(r => setTimeout(r, 0)); // keep UI responsive
  }

  await output.finalize();
  const { buffer } = target;
  return { blob: new Blob([buffer], { type: 'video/mp4' }), ext: 'mp4', mimeType: 'video/mp4' };
}

// ── Custom WebCodecs fallback (when Mediabunny CDN is unavailable) ─────────
const PROFILES = [
  { label: 'H.264+AAC→MP4', videoCodec: 'avc1.42001f', audioCodec: 'mp4a.40.2', pkg: 'mp4-muxer@4', ext: 'mp4', mimeType: 'video/mp4', muxV: { codec: 'avc' }, muxA: (ch, sr) => ({ codec: 'aac', numberOfChannels: ch, sampleRate: sr }) },
  { label: 'VP9+Opus→WebM',  videoCodec: 'vp09.00.10.08', audioCodec: 'opus',     pkg: 'webm-muxer@3', ext: 'webm', mimeType: 'video/webm', muxV: { codec: 'V_VP9' }, muxA: (ch, sr) => ({ codec: 'A_OPUS', numberOfChannels: ch, sampleRate: sr }) },
  { label: 'VP8+Opus→WebM',  videoCodec: 'vp8',          audioCodec: 'opus',     pkg: 'webm-muxer@3', ext: 'webm', mimeType: 'video/webm', muxV: { codec: 'V_VP8' }, muxA: (ch, sr) => ({ codec: 'A_OPUS', numberOfChannels: ch, sampleRate: sr }) },
];

async function detectProfile(W, H, fps, bitrate) {
  for (const p of PROFILES) {
    try {
      const [vs, as] = await Promise.all([
        VideoEncoder.isConfigSupported({ codec: p.videoCodec, width: W, height: H, bitrate, framerate: fps }),
        AudioEncoder.isConfigSupported({ codec: p.audioCodec, numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000 }),
      ]);
      if (vs.supported && as.supported) return p;
    } catch(e) {}
  }
  throw new Error('No supported WebCodecs codec found. Try Chrome 94+ or iOS 16.4+.');
}

async function loadMuxer(pkg) {
  for (const url of [`https://esm.sh/${pkg}`, `https://cdn.skypack.dev/${pkg}`]) {
    try {
      const m = await import(url);
      const M = m.Muxer ?? m.default?.Muxer;
      const T = m.ArrayBufferTarget ?? m.default?.ArrayBufferTarget;
      if (typeof M === 'function' && typeof T === 'function') return { Muxer: M, ArrayBufferTarget: T };
    } catch(e) {}
  }
  throw new Error(`Could not load ${pkg}. Check internet connection.`);
}

async function renderWithWebCodecs({ canvas, drawFrame, seekTo, blobUrl, trimIn, trimOut, videoBitrate, fps, onProgress }) {
  const W = canvas.width, H = canvas.height;
  const duration = trimOut - trimIn;
  const totalFrames = Math.round(duration * fps);

  onProgress?.(0, 'Detecting codec support…');
  const profile = await detectProfile(W, H, fps, videoBitrate);
  onProgress?.(0, `Loading muxer (${profile.label})…`);
  const { Muxer, ArrayBufferTarget } = await loadMuxer(profile.pkg);

  onProgress?.(0, 'Decoding source audio…');
  let audioBuffer = null, audioChs = 0, audioRate = 44100;
  try {
    const ab = await fetch(blobUrl).then(r => r.arrayBuffer());
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    audioBuffer = await ac.decodeAudioData(ab);
    audioChs = audioBuffer.numberOfChannels;
    audioRate = audioBuffer.sampleRate;
    await ac.close();
  } catch(e) { console.warn('Audio decode failed:', e.message); }

  const target = new ArrayBufferTarget();
  const muxOpts = { target, video: { ...profile.muxV, width: W, height: H }, fastStart: 'in-memory' };
  if (audioBuffer) muxOpts.audio = profile.muxA(audioChs, audioRate);
  const muxer = new Muxer(muxOpts);

  let encodeError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => { if (!encodeError) muxer.addVideoChunk(chunk, meta); },
    error:  (e) => { encodeError = new Error('VideoEncoder: ' + e.message); },
  });
  videoEncoder.configure({ codec: profile.videoCodec, width: W, height: H, bitrate: videoBitrate, framerate: fps, bitrateMode: 'variable', latencyMode: 'quality' });

  let audioEncoder = null;
  if (audioBuffer) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => { if (!encodeError) muxer.addAudioChunk(chunk, meta); },
      error:  (e) => { encodeError = new Error('AudioEncoder: ' + e.message); },
    });
    audioEncoder.configure({ codec: profile.audioCodec, numberOfChannels: audioChs, sampleRate: audioRate, bitrate: 192_000 });

    const startSample = Math.floor(trimIn * audioRate);
    const endSample   = Math.ceil(trimOut * audioRate);
    const total = endSample - startSample;
    const CHUNK = Math.round(audioRate * 0.02);
    for (let off = 0; off < total; off += CHUNK) {
      if (encodeError) throw encodeError;
      const len = Math.min(CHUNK, total - off);
      const ts  = Math.round((off / audioRate) * 1_000_000);
      // CORRECT f32-planar: all channel 0 samples, then all channel 1 samples
      const data = new Float32Array(len * audioChs);
      for (let ch = 0; ch < audioChs; ch++) {
        const src = audioBuffer.getChannelData(ch);
        for (let i = 0; i < len; i++) data[ch * len + i] = src[startSample + off + i];
      }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: audioRate, numberOfChannels: audioChs, numberOfFrames: len, timestamp: ts, data });
      audioEncoder.encode(ad);
      ad.close();
    }
    await audioEncoder.flush();
    if (encodeError) throw encodeError;
  }

  for (let i = 0; i < totalFrames; i++) {
    if (encodeError) throw encodeError;
    onProgress?.(i / totalFrames, `Rendering frame ${i + 1} of ${totalFrames}…`);
    // Seek with 3s timeout — mobile browsers can stall on rapid sequential seeks
    const t = trimIn + i / fps;
    await Promise.race([seekTo(t), new Promise(r => setTimeout(r, 3000))]);
    drawFrame();
    const ts_us = Math.round((i / fps) * 1_000_000);
    const dur_us = Math.round((1 / fps) * 1_000_000);
    const frame = new VideoFrame(canvas, { timestamp: ts_us, duration: dur_us });
    videoEncoder.encode(frame, { keyFrame: i === 0 || i % (fps * 2) === 0 });
    frame.close();
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await videoEncoder.flush();
  if (encodeError) throw encodeError;
  muxer.finalize();
  const { buffer } = target;
  return { blob: new Blob([buffer], { type: profile.mimeType }), ext: profile.ext, mimeType: profile.mimeType };
}

// ── Public API ────────────────────────────────────────────────────────────
export async function renderVideo(opts) {
  if (!WEBCODECS_AVAILABLE) {
    throw new Error('WebCodecs is not supported. Use Chrome 94+ or iOS 16.4+.');
  }

  opts.onProgress?.(0, 'Loading render engine…');

  // Try Mediabunny first — it's the production-grade library with proper
  // pipeline management. Fall back to our custom WebCodecs implementation
  // if CDN is unavailable.
  const mb = await loadMediabunny();
  if (mb) {
    console.log('Using Mediabunny render engine');
    return renderWithMediabunny(mb, opts);
  }

  console.log('Mediabunny unavailable — using custom WebCodecs engine');
  return renderWithWebCodecs(opts);
}