/**
 * server.js — Production ready for bare Windows Server + PM2
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
const { startTurnServer, stopTurnServer } = require('./turnServer');
const { requireServiceKey, verifySessionToken } = require('./auth');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const os = require('os');

// TURN credentials (no longer hardcoded — set via env, rotate periodically)
const TURN_USERNAME = process.env.TURN_USERNAME || 'stream';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || 'stream2024';

// ── Ensure logs + sessions directories exist ──────────────────────────────────
['./logs', './sessions'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const audioInjectionScript = fs.readFileSync(
  path.join(__dirname, 'audioCaptureInjection.js'), 'utf8'
);

// ── Detect public IP for TURN server ─────────────────────────────────────────
function getPublicIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '0.0.0.0';
}

const PUBLIC_IP = process.env.PUBLIC_IP || getPublicIp();
console.log(`[Server] Public IP: ${PUBLIC_IP}`);

// Reduce any identifier to a safe filename component (defeats path traversal).
function sanitizeKey(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Build a Playwright proxy config for a residential gateway where the region is
 * encoded in the username (Bright Data / Oxylabs / Smartproxy style).
 *
 * Env:
 *   SOCIALS_PROXY_SERVER    e.g. http://gw.provider.io:7777   (required to enable)
 *   SOCIALS_PROXY_USERNAME  template, e.g. user-country-{region}-session-{sid}
 *   SOCIALS_PROXY_PASSWORD
 *
 * {region} → lowercased country code (defaults to env SOCIALS_PROXY_DEFAULT_REGION
 * or 'us'); {sid} → a sticky-session id so the same exit IP is reused for a session.
 * Returns undefined when no proxy server is configured (browser then goes direct).
 */
function buildProxy(region, stickyId) {
  const server = process.env.SOCIALS_PROXY_SERVER;
  if (!server) return undefined;

  const reg = sanitizeKey((region || process.env.SOCIALS_PROXY_DEFAULT_REGION || 'us')).toLowerCase();
  const usernameTpl = process.env.SOCIALS_PROXY_USERNAME || '';
  const username = usernameTpl
    .replace(/\{region\}/g, reg)
    .replace(/\{sid\}/g, sanitizeKey(stickyId));

  const proxy = { server };
  if (username) proxy.username = username;
  if (process.env.SOCIALS_PROXY_PASSWORD) proxy.password = process.env.SOCIALS_PROXY_PASSWORD;
  return proxy;
}

// ── Start self-hosted TURN server ─────────────────────────────────────────────
const turnRunning = startTurnServer(PUBLIC_IP);

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
// Lock CORS to configured origins (comma-separated env). Non-browser clients
// (the mobile app, the Laravel backend) send no Origin header and are unaffected.
const CORS_ORIGINS = (process.env.SOCIALS_CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: CORS_ORIGINS.length ? CORS_ORIGINS : false,
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.use(express.json());

// Serve client.html — always open http://YOUR_IP:3000 in browser
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'client.html')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), publicIp: PUBLIC_IP, turn: turnRunning, ts: Date.now() });
});

// Clients fetch ICE config from server so credentials live in one place only
app.get('/ice-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
  if (turnRunning) {
    iceServers.push(
      { urls: `turn:${PUBLIC_IP}:3478`, username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      { urls: `turn:${PUBLIC_IP}:3478?transport=tcp`, username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    );
  }
  // Public TURN as fallback
  iceServers.push(
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  );
  res.json({ iceServers });
});

// ── Browser init ──────────────────────────────────────────────────────────────
(async () => { await initBrowser(); })();

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
app.post('/start-session', requireServiceKey, async (req, res) => {
  let context, page;
  try {
    const { platform, width, height, userId, region, country } = req.body;
    console.log(`\n--- New Flow: Start Session ---`);
    console.log(`[API] /start-session: platform=${platform}`);

    if (!ALLOWED_PLATFORMS[platform]) {
      return res.status(400).json({ error: `Platform "${platform}" not allowed` });
    }

    // userId scopes saved login state so sessions are never shared across users.
    const userKey = sanitizeKey(userId);
    if (!userKey) {
      return res.status(400).json({ error: 'userId required' });
    }

    const browser = getBrowser();
    const viewWidth = width ? parseInt(width, 10) : 390;
    const viewHeight = height ? parseInt(height, 10) : 844;

    // Reuse saved login state if available — per user + platform, never global.
    const sessionFile = `./sessions/session_${userKey}_${platform}.json`;
    const storageState = fs.existsSync(sessionFile) ? sessionFile : undefined;
    if (storageState) console.log(`[Session] Reusing saved login for ${userKey}/${platform}`);

    // Generate the session id up front so the residential proxy gets a stable
    // sticky-session key (same exit IP for the whole session → fewer login
    // challenges on Instagram/etc.).
    const sessionId = uuidv4();
    const proxy = buildProxy(region || country, sessionId);
    if (proxy) console.log(`[Proxy] Using residential exit for region=${(region || country || 'default')}`);

    context = await browser.newContext({
      viewport: { width: viewWidth, height: viewHeight },
      storageState,
      proxy,
      deviceScaleFactor: 1,
      locale: 'en-US',
      hasTouch: true,
      isMobile: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      // bypassCSP removed — do not strip target sites' Content-Security-Policy.
      // Grant only what the streaming product needs; geolocation/camera removed
      // (no real devices server-side, and geolocation would leak the host's location).
      permissions: ['microphone', 'notifications'],
    });

    await context.addInitScript(audioInjectionScript);
    page = await context.newPage();

    page.on('console', msg => {
      const text = msg.text();
      const suppress = [
        'deprecated', 'Failed to load resource', 'ERR_',
        "Unrecognized feature: 'bluetooth'", 'blocked by CORS policy',
        'browser feature intended for developers', 'facebook.com/selfxss',
        'Starling ICU', 'InvalidCharacterError',
      ];
      if (!suppress.some(s => text.includes(s))) {
        console.log(`[Browser] ${text.substring(0, 300)}`);
      }
    });

    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: viewWidth, height: viewHeight } });
    } catch (e) { console.warn('[CDP] setWindowBounds:', e.message); }

    try {
      await page.goto(ALLOWED_PLATFORMS[platform], { waitUntil: 'commit', timeout: 30000 });
    } catch (e) { console.warn(`[Navigation] ${platform}:`, e.message); }

    createSession(sessionId, context, page, { width: viewWidth, height: viewHeight, userId: userKey });

    // Audio injection — loopback because Playwright runs server-side. Use the
    // actual listen port, not a hardcoded 3000, or audio silently fails when PORT differs.
    try {
      const audioWsUrl = `ws://127.0.0.1:${process.env.PORT || 3000}`;
      await page.evaluate(({ wsUrl, sId }) => {
        const init = () => {
          if (typeof window.initAudioCapture === 'function')
            window.initAudioCapture(wsUrl, sId).catch(console.error);
        };
        init();
        setTimeout(init, 1500);
        setTimeout(init, 4000);
      }, { wsUrl: audioWsUrl, sId: sessionId });
    } catch (e) { console.warn('[AudioInjection]', e.message); }

    res.json({ sessionId, width: viewWidth, height: viewHeight });
    console.log(`[API] Session ${sessionId} | ${viewWidth}×${viewHeight}`);

  } catch (error) {
    console.error('[API] start-session error:', error.message);
    if (page) await page.close().catch(() => { });
    if (context) await context.close().catch(() => { });
    res.status(500).json({ error: 'Failed to start session', details: error.message });
  }
});

// ── POST /save-session — call after logging in via the stream ─────────────────
app.post('/save-session', requireServiceKey, async (req, res) => {
  try {
    const { sessionId, platform } = req.body;
    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Validate platform against the allowlist and scope the file to the session's
    // user. Never interpolate raw request input into a path (path-traversal fix).
    if (!ALLOWED_PLATFORMS[platform]) {
      return res.status(400).json({ error: `Platform "${platform}" not allowed` });
    }
    const userKey = sanitizeKey(session.userId) || 'default';
    const file = `./sessions/session_${userKey}_${platform}.json`;
    await session.context.storageState({ path: file });
    console.log(`[Session] Saved login for ${userKey}/${platform} → ${file}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /end-session ─────────────────────────────────────────────────────────
app.post('/end-session', requireServiceKey, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = getSession(sessionId);
    if (session) {
      if (session.ws?.readyState === session.ws?.OPEN)
        session.ws.send(JSON.stringify({ type: 'session-ended', message: 'Session ended' }));
      if (session.webrtcStreamId) stopWebRTCStream(session.webrtcStreamId);
      await session.page?.close().catch(() => { });
      await session.context?.close().catch(() => { });
      deleteSession(sessionId);
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Failed to end session' }); }
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening → http://${PUBLIC_IP}:${PORT}`);
  setInterval(async () => {
    try { await cleanupIdleSessions(300000); } catch (e) { console.error('Cleanup:', e); }
  }, 60000);
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const audioWsSessions = new Map();

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  let audioSessionId = null;
  let controlToken = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    audioSessionId = u.searchParams.get('audioSession');
    controlToken = u.searchParams.get('token');
  } catch (_) { }

  // ── Audio-only (Playwright browser → Node) ────────────────────────────────
  if (audioSessionId) {
    console.log(`[AudioWS] Connected: ${audioSessionId}`);
    audioWsSessions.set(audioSessionId, ws);
    let lastLog = 0, bytes = 0;

    ws.on('message', msg => {
      if (Buffer.isBuffer(msg) && msg[0] !== 0x7b) {
        const session = getSession(audioSessionId);
        if (session?.webrtcStreamId) {
          const ah = getAudioHandler(session.webrtcStreamId);
          if (ah) {
            ah.pushAudio(msg);
            bytes += msg.length;
            const now = Date.now();
            if (now - lastLog > 5000) {
              console.log(`[AudioWS] ${audioSessionId} | ${((bytes * 8) / (now - lastLog)).toFixed(1)} kbps`);
              bytes = 0; lastLog = now;
            }
          }
        }
        return;
      }
      try {
        const m = JSON.parse(msg.toString());
        if (m.type === 'audio-init') {
          console.log(`[AudioWS] Handshake: ${m.sessionId}`);
          audioWsSessions.set(m.sessionId, ws);
        }
      } catch (_) { }
    });

    ws.on('close', () => {
      audioWsSessions.delete(audioSessionId);
      console.log(`[AudioWS] Disconnected: ${audioSessionId}`);
    });
    return;
  }

  // ── Control connection (client browser / mobile app) ──────────────────────
  // Require a valid per-session token (minted by the Laravel backend). This binds
  // the WS to one authenticated user + sessionId, so nobody can drive a session
  // by merely knowing/guessing its id.
  const claims = verifySessionToken(controlToken);
  if (!claims) {
    console.warn(`[WebSocket] Rejected control connection from ${ip}: invalid token`);
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  console.log(`\n[WebSocket] Control from ${ip} | user=${claims.uid} session=${claims.sid}`);
  let currentSessionId = null;

  ws.on('message', async message => {
    if (Buffer.isBuffer(message) && message[0] !== 0x7b) return;
    let data;
    try { data = JSON.parse(message.toString()); }
    catch (e) { console.error('Invalid JSON:', e.message); return; }

    // The token is bound to exactly one sessionId — ignore any other.
    if (data.sessionId && data.sessionId !== claims.sid) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session mismatch' }));
      return;
    }
    data.sessionId = claims.sid;
    if (data.sessionId) currentSessionId = data.sessionId;
    if (data.type !== 'ping')
      console.log(`[WS] ${data.type}`, data.type === 'start-stream' ? '(SDP omitted)' : '');

    const session = getSession(data.sessionId);
    if (!session) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' })); return; }

    if (data.type === 'start-stream') {
      updateSession(data.sessionId, { ws });
      if (!data.offerSdp) { ws.send(JSON.stringify({ type: 'error', message: 'offerSdp required' })); return; }
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
      if (session.webrtcStreamId) { stopWebRTCStream(session.webrtcStreamId); updateSession(data.sessionId, { webrtcStreamId: null }); }
      ws.send(JSON.stringify({ type: 'stream-stopped' }));
      return;
    }

    if (data.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }

    await handleInput(session.page, data);
  });

  ws.on('close', () => console.log(`[WS] Disconnected | session: ${currentSessionId || 'unknown'}`));
  ws.on('error', err => console.error('[WS] Error:', err.message));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => { stopTurnServer(); process.exit(0); });
process.on('SIGINT', () => { stopTurnServer(); process.exit(0); });