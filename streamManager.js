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

async function computeThumb(jpegBuffer) {
  return sharp(jpegBuffer)
    .resize(THUMB_W, THUMB_H, { fit: 'fill', kernel: 'nearest' })
    .greyscale()
    .raw()
    .toBuffer();
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

  // ── CDP screencast ───────────────────────────────────────────────────────
  let cdpSession = null;
  let lastThumb = null;
  let skipped = 0;
  let lastSentAt = 0;
  let lastFrameAt = 0;

  try {
    cdpSession = await page.context().newCDPSession(page);

    cdpSession.on('Page.screencastFrame', async (event) => {
      try {
        // ACK first — lets Chrome's own change-detection work properly
        cdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => { });

        // Frame-rate cap
        const now = performance.now();
        if (now - lastFrameAt < MIN_FRAME_INTERVAL_MS) return;
        lastFrameAt = now;

        const buffer = Buffer.from(event.data, 'base64');

        // Perceptual dedup + stale-frame override
        const thumb = await computeThumb(buffer);
        const stale = (now - lastSentAt) > MAX_STALE_MS;

        if (!stale && !isDifferent(lastThumb, thumb)) {
          skipped++;
          return;
        }

        lastThumb = thumb;
        lastSentAt = now;

        if (skipped > 0) {
          skipped = 0;
        }

        // Decode JPEG → RGBA → I420 and push to WebRTC
        const { data, info } = await sharp(buffer)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const { width, height } = info;
        const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
        const i420 = new Uint8ClampedArray((width * height * 3) / 2);

        rgbaToI420({ width, height, data: rgba }, { width, height, data: i420 });

        videoSource.onFrame({ width, height, data: i420 });

      } catch (e) {
        if (!e.message?.includes('premature') && !e.message?.includes('Target closed')) {
          console.error('[Frame Error]', e.message);
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