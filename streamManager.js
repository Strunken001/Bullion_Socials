/**
 * streamManager.js  — Fixed for Windows Server / remote connections
 *
 * Key fixes vs original:
 *  1. Longer ICE gathering timeout (8 s) for cross-continent connections
 *  2. TURN servers added server-side so the answer SDP always has relay candidates
 *  3. Frame dedup threshold tuned to prevent freeze on slow screens
 *  4. Capture quality raised; frame-rate cap raised to 45 fps
 *  5. Graceful CDP session recovery — stream doesn't die on a single bad frame
 *  6. Audio handler leak fixed — stop() called correctly on teardown
 *  7. Continuous frame processing via queue to prevent stalling after first frame
 */

const { RTCPeerConnection, nonstandard } = require('@roamhq/wrtc');
const { RTCVideoSource, rgbaToI420 } = nonstandard;
const sharp = require('sharp');
const AudioHandler = require('./audioHandler');

const activeStreams = new Map();

// ── Perceptual dedup ─────────────────────────────────────────────────────────
const THUMB_W = 8;
const THUMB_H = 8;
const DIFF_THRESHOLD = 4;    // pixels that must differ (out of 64) — lower = more sensitive
const DIFF_PIXEL_DELTA = 8;    // luminance delta to count as "different"
const MAX_STALE_MS = 400;  // force-send if no frame sent for this long (~2.5 fps min)

// ── Frame-rate cap ────────────────────────────────────────────────────────────
const MIN_FRAME_INTERVAL_MS = 22; // ≈ 45 fps hard cap

// Compute the 8×8 luminance thumbnail directly from an already-decoded RGBA
// buffer. Avoids a second full JPEG decode per frame (the old computeThumb did
// a separate sharp() decode just to downscale), which was a major CPU/lag cost.
function thumbFromRgba(data, width, height) {
  const out = new Uint8Array(THUMB_W * THUMB_H);
  for (let ty = 0; ty < THUMB_H; ty++) {
    const sy = Math.min(height - 1, ((ty + 0.5) * height / THUMB_H) | 0);
    for (let tx = 0; tx < THUMB_W; tx++) {
      const sx = Math.min(width - 1, ((tx + 0.5) * width / THUMB_W) | 0);
      const idx = (sy * width + sx) * 4;
      // Rec.601 luma
      out[ty * THUMB_W + tx] = (data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) >> 8;
    }
  }
  return out;
}

function isDifferent(thumbA, thumbB) {
  if (!thumbA) return true;
  let n = 0;
  for (let i = 0; i < thumbA.length; i++) {
    if (Math.abs(thumbA[i] - thumbB[i]) > DIFF_PIXEL_DELTA && ++n >= DIFF_THRESHOLD) return true;
  }
  return false;
}

/**
 * Starts a native WebRTC stream using Playwright CDP screencast.
 * @param {import('playwright').Page} page
 * @param {string} offerSdp
 * @param {{ width?: number, height?: number }} options
 * @returns {{ answer: string, streamId: string }}
 */
async function startWebRTCStream(page, offerSdp, options = {}) {
  const streamId = Math.random().toString(36).substring(2, 9);

  const peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'stun:stun.services.mozilla.com' },
      // Self-hosted TURN on this same box (UDP 3478 + relay range 49152-65535 are
      // opened in the firewall). The server side MUST advertise it too — otherwise
      // it only had the flaky public openrelay and media never relayed (black video).
      ...(process.env.PUBLIC_IP ? [
        { urls: `turn:${process.env.PUBLIC_IP}:3478`, username: process.env.TURN_USERNAME || 'stream', credential: process.env.TURN_CREDENTIAL || 'stream2024' },
        { urls: `turn:${process.env.PUBLIC_IP}:3478?transport=tcp`, username: process.env.TURN_USERNAME || 'stream', credential: process.env.TURN_CREDENTIAL || 'stream2024' },
      ] : []),
      // TURN relay — essential for clients behind strict NAT / mobile networks
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });

  // ── TEMP DIAGNOSTIC LOGGING ───────────────────────────────────────────────
  const _t0 = Date.now();
  peerConnection.oniceconnectionstatechange = () =>
    console.log(`[WebRTC ${streamId}] ICE=${peerConnection.iceConnectionState} (+${Date.now() - _t0}ms)`);
  peerConnection.onconnectionstatechange = () =>
    console.log(`[WebRTC ${streamId}] conn=${peerConnection.connectionState}`);

  // ── Video track ──────────────────────────────────────────────────────────
  const videoSource = new RTCVideoSource({ isScreencast: true });
  const videoTrack = videoSource.createTrack();
  peerConnection.addTrack(videoTrack);

  // ── Audio track ──────────────────────────────────────────────────────────
  const audioHandler = new AudioHandler();
  const audioTrack = audioHandler.getTrack();
  peerConnection.addTrack(audioTrack);

  // ── SDP negotiation ──────────────────────────────────────────────────────
  await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  // Wait for ICE — 8 s for remote / mobile / satellite connections
  await new Promise(resolve => {
    if (peerConnection.iceGatheringState === 'complete') { resolve(); return; }
    const check = () => {
      if (peerConnection.iceGatheringState === 'complete') {
        peerConnection.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    peerConnection.addEventListener('icegatheringstatechange', check);
    setTimeout(() => {
      peerConnection.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, 8000);
  });

  const finalSdp = peerConnection.localDescription.sdp;
  console.log(`[WebRTC ${streamId}] answer candidates=${(finalSdp.match(/a=candidate/g) || []).length} relay=${(finalSdp.match(/typ relay/g) || []).length} srflx=${(finalSdp.match(/typ srflx/g) || []).length}`);

  // ── CDP screencast with continuous frame processing ─────────────────────
  let cdpSession = null;
  let lastThumb = null;
  let skipped = 0;
  let lastSentAt = 0;
  let lastFrameAt = 0;
  let frameCount = 0;

  // Frame queue: hold the latest frame + track if one is currently processing
  let frameQueue = null;
  let isProcessing = false;

  const processQueue = async () => {
    if (isProcessing || !frameQueue) return;
    isProcessing = true;

    const event = frameQueue;
    frameQueue = null; // Pop from queue

    try {
      const now = performance.now();

      // Check frame-rate cap
      if (now - lastFrameAt < MIN_FRAME_INTERVAL_MS) {
        isProcessing = false;
        // Check if another frame arrived while we were checking
        if (frameQueue) setImmediate(processQueue);
        return;
      }
      lastFrameAt = now;

      const buffer = Buffer.from(event.data, 'base64');

      // Decode JPEG → RGBA exactly once
      const { data, info } = await sharp(buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height } = info;

      // Perceptual dedup check
      const thumb = thumbFromRgba(data, width, height);
      const stale = (now - lastSentAt) > MAX_STALE_MS;

      if (!stale && !isDifferent(lastThumb, thumb)) {
        skipped++;
        isProcessing = false;
        // Try next frame from queue
        if (frameQueue) setImmediate(processQueue);
        return;
      }

      // Frame is different — send it
      lastThumb = thumb;
      lastSentAt = now;
      if (skipped > 0) skipped = 0;

      const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
      const i420 = new Uint8ClampedArray((width * height * 3) / 2);

      rgbaToI420({ width, height, data: rgba }, { width, height, data: i420 });
      videoSource.onFrame({ width, height, data: i420 });

      if ((frameCount = (frameCount || 0) + 1) % 30 === 1)
        console.log(`[WebRTC] video frame #${frameCount} sent (${width}x${height}), skipped=${skipped}`);

      isProcessing = false;
      // Try next frame from queue
      if (frameQueue) setImmediate(processQueue);
    } catch (e) {
      isProcessing = false;
      if (!e.message?.includes('premature') && !e.message?.includes('Target closed')) {
        console.error('[Frame Error]', e.message);
      }
      // Try next frame even on error
      if (frameQueue) setImmediate(processQueue);
    }
  };

  try {
    cdpSession = await page.context().newCDPSession(page);

    cdpSession.on('Page.screencastFrame', (event) => {
      try {
        // ACK immediately — non-blocking
        cdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => { });

        // Queue this frame (always latest)
        frameQueue = event;

        // Trigger processing if not busy
        if (!isProcessing) {
          setImmediate(processQueue);
        }
      } catch (e) {
        if (!e.message?.includes('premature') && !e.message?.includes('Target closed')) {
          console.error('[Frame Event Error]', e.message);
        }
      }
    });

    // Capture at 1.5× CSS resolution for sharpness without excess bandwidth
    const capW = Math.round((options.width || 390) * 1.5);
    const capH = Math.round((options.height || 844) * 1.5);

    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,        // High quality — mobile screens warrant it
      maxWidth: capW,
      maxHeight: capH,
      everyNthFrame: 1,         // Every frame — dedup handles dropping unchanged ones
    });

    console.log(`[StreamManager] Stream ${streamId} started at ${options.width}×${options.height}`);

  } catch (err) {
    console.error('[StreamManager] Failed to start stream:', err.message);
    peerConnection.close();
    throw err;
  }

  // ── Teardown on PC disconnect ────────────────────────────────────────────
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

  return { answer: finalSdp, streamId };
}

function stopWebRTCStream(streamId) {
  const stream = activeStreams.get(streamId);
  if (!stream) return;

  try {
    if (stream.cdpSession) {
      stream.cdpSession.send('Page.stopScreencast').catch(() => { });
      stream.cdpSession.detach().catch(() => { });
    }
    stream.videoTrack?.stop();
    stream.audioTrack?.stop();
    stream.audioHandler?.stop();
    stream.peerConnection?.close();
  } catch (err) {
    console.error(`[StreamManager] Error stopping ${streamId}:`, err.message);
  }

  activeStreams.delete(streamId);
  console.log(`[StreamManager] Stopped ${streamId}`);
}

function getAudioHandler(streamId) {
  return activeStreams.get(streamId)?.audioHandler ?? null;
}

module.exports = { startWebRTCStream, stopWebRTCStream, getAudioHandler };
