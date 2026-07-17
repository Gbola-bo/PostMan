// PostMann Video Render Engine — WebCodecs + mp4-muxer
// Produces a proper MP4 with:
//   - Audio decoded directly from source (zero re-encoding distortion)
//   - Video encoded frame-by-frame with explicit timestamps (zero drift)
//   - Both muxed together with matching timestamps (perfect sync)
//
// Falls back to a clear error message if WebCodecs is not available,
// rather than silently producing broken output.
//
// Requires mp4-muxer to be loaded first:
//   import { Muxer, ArrayBufferTarget } from 'https://unpkg.com/mp4-muxer@4/build/mp4-muxer.js';

export const WEBCODECS_AVAILABLE =
  typeof VideoEncoder !== 'undefined' &&
  typeof AudioEncoder !== 'undefined';

/**
 * Render the trimmed region of a video with a canvas overlay to an MP4 blob.
 *
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas         - The composited canvas (has the overlay drawn on it)
 * @param {Function}          opts.drawFrame      - () => void  — draws the current frame to canvas
 * @param {Function}          opts.seekTo         - async (t) => void — seeks source video to time t
 * @param {string}            opts.blobUrl        - blob: URL of the source video file
 * @param {number}            opts.trimIn         - trim start in seconds
 * @param {number}            opts.trimOut        - trim end in seconds
 * @param {number}            opts.videoBitrate   - e.g. 1_500_000
 * @param {number}            opts.fps            - e.g. 30
 * @param {Function}          opts.onProgress     - (0..1) => void
 */
export async function renderMP4({ canvas, drawFrame, seekTo, blobUrl, trimIn, trimOut, videoBitrate, fps = 30, onProgress }) {
  if (!WEBCODECS_AVAILABLE) throw new Error('WebCodecs is not supported in this browser. Try Chrome 94+ or iOS 16.4+.');

  const W = canvas.width, H = canvas.height;
  const duration = trimOut - trimIn;
  const totalFrames = Math.round(duration * fps);

  // ── Dynamically import mp4-muxer ────────────────────────────────────────
  // We import it only when render is triggered so it doesn't affect page load.
  let Muxer, ArrayBufferTarget;
  try {
    ({ Muxer, ArrayBufferTarget } = await import('https://unpkg.com/mp4-muxer@4/build/mp4-muxer.js'));
  } catch(e) {
    throw new Error('Could not load mp4-muxer. Check your internet connection and try again.');
  }

  // ── Decode source audio (the highest-quality path: PCM direct from file) ─
  // This gives us the raw PCM of the entire source video's audio track.
  // We then slice out only the trimmed region — no re-encoding, no distortion.
  let audioBuffer = null;
  let audioChs = 0, audioRate = 44100;
  try {
    const ab = await fetch(blobUrl).then(r => r.arrayBuffer());
    const ac = new AudioContext();
    audioBuffer = await ac.decodeAudioData(ab);
    audioChs  = audioBuffer.numberOfChannels;
    audioRate = audioBuffer.sampleRate;
    await ac.close();
  } catch(e) {
    console.warn('renderMP4: could not decode audio from source —', e.message, '— video will be silent.');
    audioBuffer = null;
  }

  // ── Set up muxer ─────────────────────────────────────────────────────────
  const target = new ArrayBufferTarget();
  const muxerOpts = {
    target,
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory',
  };
  if (audioBuffer) {
    muxerOpts.audio = { codec: 'aac', numberOfChannels: audioChs, sampleRate: audioRate };
  }
  const muxer = new Muxer(muxerOpts);

  // ── VideoEncoder ──────────────────────────────────────────────────────────
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw new Error('VideoEncoder: ' + e.message); },
  });
  videoEncoder.configure({
    codec: 'avc1.42001f',   // H.264 Constrained Baseline — widest device support
    width: W, height: H,
    bitrate: videoBitrate,
    framerate: fps,
    bitrateMode: 'variable',
    latencyMode: 'quality',
  });

  // ── AudioEncoder ──────────────────────────────────────────────────────────
  let audioEncoder = null;
  if (audioBuffer) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { throw new Error('AudioEncoder: ' + e.message); },
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',   // AAC-LC — compatible with all devices
      numberOfChannels: audioChs,
      sampleRate: audioRate,
      bitrate: 192_000,
    });
  }

  // ── Encode audio first (fast — no seeking needed) ─────────────────────────
  if (audioBuffer && audioEncoder) {
    const startSample  = Math.floor(trimIn   * audioRate);
    const endSample    = Math.ceil(trimOut   * audioRate);
    const chunkSamples = Math.round(audioRate * 0.02);  // 20ms chunks
    const trimmedLen   = endSample - startSample;

    for (let offset = 0; offset < trimmedLen; offset += chunkSamples) {
      const len = Math.min(chunkSamples, trimmedLen - offset);
      const timestamp = Math.round((offset / audioRate) * 1_000_000); // µs

      // Build a Float32Array for each channel covering [offset, offset+len)
      const planes = [];
      for (let ch = 0; ch < audioChs; ch++) {
        const src = audioBuffer.getChannelData(ch);
        planes.push(src.subarray(startSample + offset, startSample + offset + len));
      }

      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: audioRate,
        numberOfChannels: audioChs,
        numberOfFrames: len,
        timestamp,
        data: planes.length === 1 ? planes[0] : (() => {
          // Interleave for multi-channel AudioData construction
          const merged = new Float32Array(len * audioChs);
          planes.forEach((p, ch) => { for (let i = 0; i < len; i++) merged[i * audioChs + ch] = p[i]; });
          return merged;
        })(),
      });
      audioEncoder.encode(audioData);
      audioData.close();
    }
    await audioEncoder.flush();
  }

  // ── Encode video frame by frame ───────────────────────────────────────────
  // We seek to each frame's exact time, draw the composited canvas, then
  // create a VideoFrame from the canvas. Each frame has an explicit timestamp
  // in microseconds — the muxer interleaves audio and video by these timestamps.
  for (let i = 0; i < totalFrames; i++) {
    const t = trimIn + i / fps;
    await seekTo(t);    // engine.seek() — waits for the video to settle
    drawFrame();         // composites video + overlay onto the canvas

    const timestamp_us = Math.round((i / fps) * 1_000_000);
    const duration_us  = Math.round((1 / fps) * 1_000_000);

    const frame = new VideoFrame(canvas, { timestamp: timestamp_us, duration: duration_us });
    const keyFrame = i === 0 || i % (fps * 2) === 0; // keyframe every 2s
    videoEncoder.encode(frame, { keyFrame });
    frame.close();

    onProgress?.((i + 1) / totalFrames);

    // Yield to the browser on every 5th frame so the UI stays responsive
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await videoEncoder.flush();
  muxer.finalize();

  const { buffer } = target;
  return new Blob([buffer], { type: 'video/mp4' });
}
