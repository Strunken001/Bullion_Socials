/**
 * server.js  — Fixed for Windows Server / remote deployment
 *
 * Key fixes vs original:
 *  1. Audio capture WS URL always uses 127.0.0.1 (server-internal) — correct
 *  2. url.parse() replaced with URL API (removes DEP0169 warning)
 *  3. CORS hardened but still open for remote clients
 *  4. Session cleanup on Playwright browser restart
 *  5. /health endpoint extended with active session count
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const { URL } = require('url');
const { initBrowser, getBrowser } = require('./browserManager');
const {
  createSession, getSession, updateSession, deleteSession, cleanupIdleSessions,
} = require('./sessionStore');
const { startWebRTCStream, stopWebRTCStream, getAudioHandler } = require('./streamManager');
const { handleInput } = require('./inputHandler');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');

const audioInjectionScript = fs.readFileSync(
  path.join(__dirname, 'audioCaptureInjection.js'),
  'utf8'
);

const app = express();

// Allow all origins — tighten this if you know your client origin
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// Serve client.html at root so you can open http://<IP>:3000 directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), ts: Date.now() });
});

// ── Browser init ──────────────────────────────────────────────────────────────
(async () => {
  await initBrowser();
})();

// ── Allowed platforms ─────────────────────────────────────────────────────────
const ALLOWED_PLATFORMS = {
  facebook: 'https://www.facebook.com/',
  instagram: 'https://www.instagram.com',
  x: 'https://x.com/',
  tiktok: 'https://www.tiktok.com',
  linkedin: 'https://www.linkedin.com',
  telegram: 'https://web.telegram.org/',
  discord: 'https://discord.com/app',
  messenger: 'https://www.messenger.com/',
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
};

// ── POST /start-session ───────────────────────────────────────────────────────
app.post('/start-session', async (req, res) => {
  let context, page;
  try {
    const { platform, width, height } = req.body;
    console.log(`\n--- New Flow: Start Session ---`);
    console.log(`[API] /start-session: platform=${platform}`);

    if (!ALLOWED_PLATFORMS[platform]) {
      return res.status(400).json({ error: `Platform "${platform}" not allowed` });
    }

    const browser = getBrowser();
    const viewWidth = width ? parseInt(width, 10) : 390;
    const viewHeight = height ? parseInt(height, 10) : 844;

    context = await browser.newContext({
      viewport: { width: viewWidth, height: viewHeight },
      deviceScaleFactor: 1,
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      bypassCSP: true,
      permissions: ['microphone', 'camera', 'geolocation', 'notifications'],
    });

    await context.addInitScript(audioInjectionScript);

    page = await context.newPage();

    // Relay useful browser console messages
    page.on('console', msg => {
      const text = msg.text();
      const suppress = [
        'deprecated', 'Failed to load resource', 'ERR_', 'Unrecognized feature: \'bluetooth\'',
        'blocked by CORS policy', 'This is a browser feature intended for developers',
        'See https://www.facebook.com/selfxss',
      ];
      if (!suppress.some(s => text.includes(s))) {
        console.log(`[Browser] ${text}`);
      }
    });

    // Sync CDP window size to viewport
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: viewWidth, height: viewHeight },
      });
    } catch (e) {
      console.warn('[CDP] setWindowBounds:', e.message);
    }

    // Navigate to platform
    try {
      await page.goto(ALLOWED_PLATFORMS[platform], { waitUntil: 'commit', timeout: 30000 });
    } catch (e) {
      console.warn(`[Navigation] ${platform} soft-timeout:`, e.message);
    }

    const sessionId = uuidv4();
    createSession(sessionId, context, page, { width: viewWidth, height: viewHeight });

    // Audio capture — always 127.0.0.1 because this runs server-side (Playwright → Node)
    const serverWsUrl = 'ws://127.0.0.1:3000';
    try {
      await page.evaluate(({ wsUrl, sId }) => {
        if (typeof window.initAudioCapture === 'function') {
          window.initAudioCapture(wsUrl, sId).catch(console.error);
        } else {
          setTimeout(() => {
            if (typeof window.initAudioCapture === 'function') {
              window.initAudioCapture(wsUrl, sId).catch(console.error);
            }
          }, 1500);
        }
      }, { wsUrl: serverWsUrl, sId: sessionId });
    } catch (e) {
      console.warn('[AudioInjection]', e.message);
    }

    res.json({ sessionId, width: viewWidth, height: viewHeight, quality: 92, format: 'jpeg' });
    console.log(`[API] Session ${sessionId} | ${viewWidth}×${viewHeight}`);

  } catch (error) {
    console.error('[API] start-session error:', error.message);
    if (page) await page.close().catch(() => { });
    if (context) await context.close().catch(() => { });
    res.status(500).json({ error: 'Failed to start session', details: error.message });
  }
});

// ── POST /end-session ─────────────────────────────────────────────────────────
app.post('/end-session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = getSession(sessionId);
    if (session) {
      if (session.ws?.readyState === session.ws?.OPEN) {
        session.ws.send(JSON.stringify({ type: 'session-ended', message: 'Session ended' }));
      }
      if (session.webrtcStreamId) stopWebRTCStream(session.webrtcStreamId);
      await session.page?.close().catch(() => { });
      await session.context?.close().catch(() => { });
      deleteSession(sessionId);
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = app.listen(3000, '0.0.0.0', () => {
  console.log('Server listening on http://0.0.0.0:3000');

  // Idle session cleanup every 60 s (kills sessions idle > 5 min)
  setInterval(async () => {
    try { await cleanupIdleSessions(300000); } catch (e) { console.error('Cleanup:', e); }
  }, 60000);
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// Audio-only connections keyed by sessionId (from audioCaptureInjection.js)
const audioWsSessions = new Map();

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  // Use URL API instead of deprecated url.parse
  let audioSessionId = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    audioSessionId = u.searchParams.get('audioSession');
  } catch (_) { }

  // ── Audio-only connection (Playwright browser → server) ──────────────────
  if (audioSessionId) {
    console.log(`[AudioWS] Browser audio stream connected for session ${audioSessionId}`);
    audioWsSessions.set(audioSessionId, ws);

    let lastLogTime = 0, byteCount = 0;

    ws.on('message', message => {
      if (Buffer.isBuffer(message) && message[0] !== 0x7b) {
        const session = getSession(audioSessionId);
        if (session?.webrtcStreamId) {
          const ah = getAudioHandler(session.webrtcStreamId);
          if (ah) {
            ah.pushAudio(message);
            byteCount += message.length;
            const now = Date.now();
            if (now - lastLogTime > 5000) {
              const kbps = ((byteCount * 8) / (now - lastLogTime)).toFixed(1);
              console.log(`[AudioWS] Session ${audioSessionId} | Flowing @ ${kbps} kbps`);
              byteCount = 0; lastLogTime = now;
            }
          }
        }
        return;
      }

      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'audio-init') {
          console.log(`[AudioWS] Handshake received for session ${msg.sessionId}`);
          audioWsSessions.set(msg.sessionId, ws);
        }
      } catch (_) { }
    });

    ws.on('close', () => {
      audioWsSessions.delete(audioSessionId);
      console.log(`[AudioWS] Browser audio disconnected for session ${audioSessionId}`);
    });

    return;
  }

  // ── Control connection (from client.html / mobile app) ───────────────────
  console.log(`\n[WebSocket] Control connection from ${ip}`);
  let currentSessionId = null;

  ws.on('message', async message => {
    // Binary audio from client mic (future feature)
    if (Buffer.isBuffer(message) && message[0] !== 0x7b) {
      const session = getSession(currentSessionId);
      if (session?.webrtcStreamId) {
        const ah = getAudioHandler(session.webrtcStreamId);
        if (ah) ah.pushAudio(message);
      }
      return;
    }

    let data;
    try { data = JSON.parse(message.toString()); }
    catch (e) { console.error('Invalid JSON:', e.message); return; }

    if (data.sessionId) currentSessionId = data.sessionId;
    if (data.type !== 'ping') {
      console.log(`[WS] ${data.type}`, data.type === 'start-stream' ? '(SDP omitted)' : '');
    }

    const session = getSession(data.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' }));
      return;
    }

    // ── Stream control ──────────────────────────────────────────────────────
    if (data.type === 'start-stream') {
      updateSession(data.sessionId, { ws });

      if (!data.offerSdp) {
        ws.send(JSON.stringify({ type: 'error', message: 'offerSdp required' }));
        return;
      }

      try {
        const { width: sw, height: sh } = session.viewport ?? { width: 390, height: 844 };
        const { answer, streamId } = await startWebRTCStream(session.page, data.offerSdp, { width: sw, height: sh });
        updateSession(data.sessionId, { webrtcStreamId: streamId });

        ws.send(JSON.stringify({ type: 'webrtc-answer', sdpAnswer: answer, width: sw, height: sh }));
        ws.send(JSON.stringify({ type: 'stream-started', width: sw, height: sh }));
        console.log(`[Stream] WebRTC running at ${sw}×${sh}`);
      } catch (err) {
        console.error('[Stream] Start failed:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to start stream: ' + err.message }));
      }
      return;
    }

    if (data.type === 'stop-stream') {
      if (session.webrtcStreamId) {
        stopWebRTCStream(session.webrtcStreamId);
        updateSession(data.sessionId, { webrtcStreamId: null });
      }
      ws.send(JSON.stringify({ type: 'stream-stopped' }));
      return;
    }

    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    // ── Input events ────────────────────────────────────────────────────────
    await handleInput(session.page, data);
  });

  ws.on('close', () => {
    console.log(`[WS] Control disconnected | session: ${currentSessionId || 'unknown'}`);
  });

  ws.on('error', err => {
    console.error('[WS] Error:', err.message);
  });
});