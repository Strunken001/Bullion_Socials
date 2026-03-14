const { RTCPeerConnection, nonstandard } = require('@roamhq/wrtc');
const { RTCVideoSource, rgbaToI420 } = nonstandard;
const sharp = require('sharp');
const AudioHandler = require('./audioHandler');

const activeStreams = new Map();

// ── Perceptual frame diffing ─────────────────────────────────────────────────
// Downscale each frame to an 8×8 greyscale thumbnail (64 bytes) and compare
// it against the previous one.  If fewer than DIFF_THRESHOLD pixels changed
// significantly, the frame is considered identical and dropped.
//
// Cost: ~0.3 ms per frame (negligible vs. the full Sharp decode at ~8–15 ms).
// Benefit: zero WebRTC bandwidth consumed for static pages.

const THUMB_W = 8;
const THUMB_H = 8;
// Increased from 4 → 6: previous value was too aggressive and caused "micro-freeze"
// when only a few pixels (cursor blink, loading spinner) changed between frames.
const DIFF_THRESHOLD = 6;       // pixels that must differ (out of 64)
const DIFF_PIXEL_DELTA = 10;    // how different a pixel must be (0–255) to count

// ── Frame-rate cap ────────────────────────────────────────────────────────────
// Limits push rate to ~30 fps max (33ms). CDP can fire faster on idle screens.
// Pushing too fast overwhelms the VP8/H264 encoder in @roamhq/wrtc.
const MIN_FRAME_INTERVAL_MS = 22; // ≈ 45fps hard cap
let lastFrameAt = 0;

async function computeThumb(jpegBuffer) {
  return sharp(jpegBuffer)
    .resize(THUMB_W, THUMB_H, { fit: 'fill', kernel: 'nearest' })
    .greyscale()
    .raw()
    .toBuffer();
}

function isSignificantlyDifferent(thumbA, thumbB) {
  if (!thumbA) return true;   // first frame — always send
  let diffCount = 0;
  for (let i = 0; i < thumbA.length; i++) {
    if (Math.abs(thumbA[i] - thumbB[i]) > DIFF_PIXEL_DELTA) {
      diffCount++;
      if (diffCount >= DIFF_THRESHOLD) return true;
    }
  }
  return false;
}

/**
 * Starts a native Node.js WebRTC stream by capturing Playwright CDP frames.
 */
async function startWebRTCStream(page, offerSdp, options = {}) {
  const streamId = Math.random().toString(36).substring(2, 9);

  // Create WebRTC components with broad STUN fallback for Windows Server firewalls
  const peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }, // Reliable fallback STUN
      { urls: 'stun:stun.services.mozilla.com' }    // Reliable fallback STUN
    ],
    // Improve connection reliability (especially critical for Windows)
    iceCandidatePoolSize: 10,
  });

  // Video track setup
  const videoSource = new RTCVideoSource({ isScreencast: true });
  const videoTrack = videoSource.createTrack();
  peerConnection.addTrack(videoTrack);

  // Audio track setup
  const audioHandler = new AudioHandler();
  const audioTrack = audioHandler.getTrack();
  peerConnection.addTrack(audioTrack);

  // Set the remote description (the Offer from the client)
  await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerSdp });

  // Generate an Answer
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  // Wait for ICE candidates to gather — increased timeout to 4s
  await new Promise(resolve => {
    if (peerConnection.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const checkState = () => {
      if (peerConnection.iceGatheringState === 'complete') {
        peerConnection.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    };
    peerConnection.addEventListener('icegatheringstatechange', checkState);
    setTimeout(() => {
      peerConnection.removeEventListener('icegatheringstatechange', checkState);
      resolve();
    }, 4000); // Increased from 1500ms
  });

  const finalAnswerSdp = peerConnection.localDescription.sdp;

  // Set up CDP Screencast
  let cdpSession = null;

  // Perceptual dedup state — persists across frames for this stream
  let lastThumb = null;       // Buffer of last sent frame's 8×8 greyscale
  let skippedFrames = 0;      // consecutive skipped frames counter (for logging)
  let lastSentAt = 0;         // performance.now() timestamp of last sent frame

  // Safety: if no frame has been delivered in MAX_STALE_MS, force-send the
  // next one regardless of perceptual diff.  This prevents a fully-black or
  // near-static screen (TikTok loading, Instagram splash) from appearing frozen.
  const MAX_STALE_MS = 500;   // guarantee at least ~2 fps to the client

  try {
    cdpSession = await page.context().newCDPSession(page);

    cdpSession.on('Page.screencastFrame', async (event) => {
      try {
        // ACK immediately — BEFORE any async work.
        // This tells Chrome "I'm ready for the next frame", so CDP's own
        // change-detection runs correctly.  Delaying the ACK causes Chrome to
        // queue and send the next frame regardless of whether content changed.
        cdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => { });

        // ── Frame-rate cap ─────────────────────────────────────────────────
        const now = performance.now();
        if (now - lastFrameAt < MIN_FRAME_INTERVAL_MS) return; // too soon
        lastFrameAt = now;

        const buffer = Buffer.from(event.data, 'base64');

        // ── Perceptual diff (with stale-frame override) ──────────────────────────
        // If no frame has been sent for MAX_STALE_MS, bypass dedup entirely so
        // the client always gets a refresh (prevents frozen dark/static screens).
        const thumb = await computeThumb(buffer);
        const msSinceLastSent = now - lastSentAt;
        const forceSend = msSinceLastSent > MAX_STALE_MS;

        if (!forceSend && !isSignificantlyDifferent(lastThumb, thumb)) {
          skippedFrames++;
          return; // Screen hasn't changed — don't encode or send
        }
        lastThumb = thumb;
        lastSentAt = now;  // record time of this send
        if (skippedFrames > 0) {
          console.log(`[Dedup ${streamId}] Skipped ${skippedFrames} identical frames`);
          skippedFrames = 0;
        }

        const decodeStart = performance.now();

        // Decode JPEG to raw RGBA at native captured size.
        // We do NOT downscale here — the 2x resolution is the whole point.
        // wrtc handles any necessary scaling internally when encoding VP8/H264.
        const { data, info } = await sharp(buffer)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const { width, height } = info;

        // Convert sharp Buffer to Uint8ClampedArray
        const rgbaData = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);

        // wrtc expects I420 (YUV) byte arrays
        const i420Data = new Uint8ClampedArray((width * height * 3) / 2);

        rgbaToI420(
          { width, height, data: rgbaData },
          { width, height, data: i420Data }
        );

        videoSource.onFrame({
          width,
          height,
          data: i420Data,
        });

        const decodeTime = (performance.now() - decodeStart).toFixed(2);
        const kbSize = (buffer.length / 1024).toFixed(2);

        if (parseInt(kbSize) > 5) {
          console.log(`[Telemetry ${streamId}] Frame | ${kbSize} KB | ${decodeTime} ms`);
        }

      } catch (e) {
        if (!e.message?.includes('premature')) {
          console.error('[Frame Error]', e.message);
        }
      }
    });

    // QUALITY FIX: deviceScaleFactor:1 (in server.js) means the browser renders
    // at CSS resolution (390px). However, we want better-than-SD quality.
    // Capturing at 1.5x (585px) provides a good balance between "crisp" and
    // "bandwidth-heavy" for mobile devices.
    const captureW = Math.round((options.width || 390) * 1.5);
    const captureH = Math.round((options.height || 844) * 1.5);

    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,        // Balanced quality (was 98)
      maxWidth: captureW,
      maxHeight: captureH,
      everyNthFrame: 1,
    });

    console.log(`[StreamManager] Stream ${streamId} started at ${options.width}×${options.height}`);

  } catch (err) {
    console.error('[StreamManager] Failed to start stream:', err);
    peerConnection.close();
    throw err;
  }

  // Handle stream teardown
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log(`[StreamManager] PC state: ${state} (${streamId})`);
    if (['disconnected', 'failed', 'closed'].includes(state)) {
      stopWebRTCStream(streamId);
    }
  };

  activeStreams.set(streamId, {
    peerConnection,
    videoSource,
    audioHandler,
    cdpSession,
    videoTrack,
    audioTrack,
  });

  return { answer: finalAnswerSdp, streamId };
}

function stopWebRTCStream(streamId) {
  const stream = activeStreams.get(streamId);
  if (!stream) return;

  try {
    if (stream.cdpSession) {
      stream.cdpSession.send('Page.stopScreencast').catch(() => { });
      stream.cdpSession.detach().catch(() => { });
    }
    if (stream.videoTrack) stream.videoTrack.stop();
    if (stream.audioTrack) stream.audioTrack.stop();
    if (stream.audioHandler) stream.audioHandler.stop();
    if (stream.peerConnection) stream.peerConnection.close();
  } catch (err) {
    console.error(`[StreamManager] Error stopping ${streamId}:`, err);
  }

  activeStreams.delete(streamId);
  console.log(`[StreamManager] Stopped ${streamId}`);
}

function getAudioHandler(streamId) {
  const stream = activeStreams.get(streamId);
  return stream ? stream.audioHandler : null;
}

module.exports = { startWebRTCStream, stopWebRTCStream, getAudioHandler };