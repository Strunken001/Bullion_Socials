const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");
const { chromium } = require("playwright");
const {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  cleanupIdleSessions,
} = require("./sessionStore");
const {
  startScreencast,
  stopScreencast,
  startAudioStream,
} = require("./streamManager");
const { handleInput } = require("./inputHandler");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const os = require("os");

const IS_WINDOWS = os.platform() === "win32";

const DISPLAY = process.env.DISPLAY || ":1";
const XDG_RUNTIME_DIR =
  process.env.XDG_RUNTIME_DIR ||
  `/run/user/${process.getuid ? process.getuid() : 1000}`;
const PULSE_SERVER =
  process.env.PULSE_SERVER || `unix:${XDG_RUNTIME_DIR}/pulse/native`;

console.log(`[Server] Platform: ${os.platform()} | DISPLAY=${DISPLAY}`);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "client.html")));

// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED = {
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com/",
  x: "https://x.com/",
  tiktok: "https://www.tiktok.com/",
  linkedin: "https://www.linkedin.com/",
  discord: "https://discord.com/",
  messenger: "https://www.messenger.com/",
  telegram: "https://web.telegram.org/",
  youtube: "https://www.youtube.com/",
  google: "https://www.google.com/",
};

// ── Viewport / render size ────────────────────────────────────────────────────
// These MUST match the SERVER_W / SERVER_H constants in client.html exactly.
// 390×844 is the iPhone 14 Pro logical resolution — a safe "mobile" target
// that all the major social apps serve their mobile layout for.
const MOBILE_WIDTH = parseInt(process.env.MOBILE_WIDTH, 10) || 390;
const MOBILE_HEIGHT = parseInt(process.env.MOBILE_HEIGHT, 10) || 844;

// Chromium args
const CHROMIUM_ARGS = [
  "--audio-output-device=CABLE Input (VB-Audio Virtual Cable)",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
  "--no-zygote",
  "--lang=en-US",
  "--autoplay-policy=no-user-gesture-required",
  // WebRTC and GPU encoding flags
  "--enable-usermedia-screen-capturing",
  "--allow-http-screen-capture",
  "--enable-gpu",
  "--enable-accelerated-video-encode",
  "--enable-accelerated-video-decode",
  "--use-gl=desktop",
  "--auto-select-desktop-capture-source=Chromium",
  "--disable-infobars",
  // Force audio to stay in-process — the out-of-process AudioService on Windows
  // picks its own device and bypasses VB-Cable entirely.
  "--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox",
  "--audio-output-channels=2",
  "--allow-running-insecure-content",
  "--disable-web-security",
  // Force Chromium to output audio to CABLE Input by name.
  // This is the most reliable way to ensure headless Chromium routes through VB-Cable.
  ...(IS_WINDOWS
    ? ["--use-fake-ui-for-media-stream"]
    : ["--disable-features=WebRtcPipeWireCapturer"]),
];

// Context options — emulate a modern Android phone
const CTX_OPTIONS = {
  viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
  deviceScaleFactor: 2,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  locale: "en-US",
  hasTouch: true,   // tell sites this is a touch device → mobile layout
  isMobile: true,
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /start-session
// ─────────────────────────────────────────────────────────────────────────────
app.post("/start-session", async (req, res) => {
  let browser, context, page, audioSession;

  try {
    const { platform, audioCodec = "opus", width, height } = req.body;
    if (!ALLOWED[platform])
      return res.status(400).json({ error: "Platform not allowed" });

    // Use provided dimensions or fall back to defaults
    const sessionWidth = width || MOBILE_WIDTH;
    const sessionHeight = height || MOBILE_HEIGHT;

    const sessionId = uuidv4();
    console.log(
      `\n[Session] Starting ${sessionId} — platform: ${platform} codec: ${audioCodec} size: ${sessionWidth}x${sessionHeight}`
    );

    // ── 1. Audio pipeline ────────────────────────────────────────────────────
    // NOTE: On Windows, audio pipeline is started AFTER browser navigates so
    // Chromium's audio session is registered with Windows before FFmpeg opens
    // the dshow capture device. audioSession is set as a placeholder for now.
    if (audioCodec === "none") {
      audioSession = {
        method: "none", codec: "none", sinkName: null,
        flushAudio: () => { }, reroute: async () => { }, stop: async () => { },
      };
    } else if (IS_WINDOWS) {
      // Placeholder — real pipeline started after page.goto below
      audioSession = {
        method: "pending", codec: audioCodec, sinkName: "windows",
        flushAudio: () => { }, reroute: async () => { }, stop: async () => { },
      };

      const { exec } = require('child_process');
      setTimeout(() => {
        exec('nircmd.exe setappvolume ffmpeg.exe 1.0', () => { });
      }, 3000);

    } else {
      audioSession = await startAudioStream(sessionId, audioCodec);
      console.log(`[Session] Audio method: ${audioSession.method} | sink: ${audioSession.sinkName}`);
    }

    // ── 2. Launch browser ────────────────────────────────────────────────────
    browser = await chromium.launch({
      headless: false,
      env: {
        ...process.env,
        ...(IS_WINDOWS
          ? {}
          : {
            DISPLAY,
            XDG_RUNTIME_DIR,
            PULSE_SERVER,
            PULSE_SINK: audioSession.sinkName,
          }),
      },
      args: CHROMIUM_ARGS,
    });

    context = await browser.newContext({
      ...CTX_OPTIONS,
      viewport: { width: sessionWidth, height: sessionHeight }
    });
    page = await context.newPage();

    // ── 3. Inject BEFORE navigation: aggressive unmute script ────────────────
    await page.addInitScript(() => {

      // Save original descriptor FIRST before any site code runs
      const origMutedDesc = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype, "muted"
      );

      // ── Block muted=true at prototype level ──────────────────────────────
      if (origMutedDesc?.set) {
        Object.defineProperty(HTMLMediaElement.prototype, "muted", {
          get: origMutedDesc.get,
          set(val) {
            if (val === true) return; // silently drop all mute attempts
            origMutedDesc.set.call(this, false);
          },
          configurable: true,
        });
      }

      // ── Unmute helper ────────────────────────────────────────────────────
      function forceUnmute(el) {
        try { origMutedDesc?.set?.call(el, false); } catch { }
        try { el.volume = 1.0; } catch { }
        // Also override per-instance so React state can't re-mute
        try {
          Object.defineProperty(el, "muted", {
            get: () => false,
            set: () => { },
            configurable: true,
          });
        } catch { }
      }

      // ── Watch for new media elements ─────────────────────────────────────
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.nodeName === "AUDIO" || node.nodeName === "VIDEO") {
              forceUnmute(node);
              setTimeout(() => forceUnmute(node), 50);
              setTimeout(() => forceUnmute(node), 300);
              setTimeout(() => forceUnmute(node), 1000);
            }
            node.querySelectorAll?.("audio,video").forEach((el) => {
              forceUnmute(el);
              setTimeout(() => forceUnmute(el), 300);
            });
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });

      // ── Block AudioContext.suspend() — Instagram calls this to silence audio
      const _AC = window.AudioContext || window.webkitAudioContext;
      if (_AC) {
        _AC.prototype.suspend = function () {
          return Promise.resolve(); // no-op
        };
        const ACProxy = new Proxy(_AC, {
          construct(Target, args) {
            const ac = new Target(...args);
            ac.resume().catch(() => { });
            return ac;
          },
        });
        try {
          if (window.AudioContext) window.AudioContext = ACProxy;
          if (window.webkitAudioContext) window.webkitAudioContext = ACProxy;
        } catch { }
      }

      // ── Periodic sweep — catches React-rehydrated elements ───────────────
      // Fast for first 30s, then slow
      let sweepCount = 0;
      function sweep() {
        document.querySelectorAll("audio,video").forEach(forceUnmute);
        sweepCount++;
        setTimeout(sweep, sweepCount < 40 ? 800 : 3000);
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", sweep);
      } else {
        sweep();
      }
    });

    // ── 4. Navigate ──────────────────────────────────────────────────────────
    await page.goto(ALLOWED[platform], {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // ── 5. Post-navigation: brightness, unmute buttons, re-unmute poll ──────────
    await page
      .addStyleTag({
        content: "html { filter: brightness(1.08) contrast(1.04) !important; }",
      })
      .catch(() => { });

    // Click any visible mute/sound toggle buttons (Instagram, TikTok, YouTube)
    // Run at 2s and 5s to catch buttons that render after initial load
    async function clickMuteButtons() {
      await page.evaluate(() => {
        const SELECTORS = [
          'button[aria-label*="mute" i]',
          'button[aria-label*="sound" i]',
          '[data-e2e="video-mute"]',
          '[data-e2e="mute-icon"]',
          'button[class*="Mute" ]',
          'button[class*="mute" ]',
          // YouTube mute button
          '.ytp-mute-button',
        ];
        for (const sel of SELECTORS) {
          document.querySelectorAll(sel).forEach((btn) => {
            const label = (btn.getAttribute("aria-label") || btn.title || "").toLowerCase();
            // Click if it looks like a "muted" state button
            if (label.includes("unmute") || label.includes("sound off") || label.includes("muted")) {
              console.log("[Server] Clicking unmute button:", label);
              btn.click();
            }
          });
        }
        // Also brute-force unmute all media
        document.querySelectorAll("audio,video").forEach((el) => {
          try { el.muted = false; el.volume = 1.0; } catch { }
        });
      }).catch(() => { });
    }

    setTimeout(() => clickMuteButtons().catch(() => { }), 2_000);
    setTimeout(() => clickMuteButtons().catch(() => { }), 5_000);
    setTimeout(() => clickMuteButtons().catch(() => { }), 10_000);

    // Ongoing poll every 3s — catches newly scrolled-in videos
    const unmutePoll = setInterval(async () => {
      await clickMuteButtons().catch(() => { });
    }, 3_000);

    // ── On Windows: start the real audio pipeline NOW, after the browser has
    // navigated and Chromium's audio session is registered with Windows.
    // On Linux the pipeline was already started above (PulseAudio sink needed
    // before Chromium launches so PULSE_SINK env var is set correctly).
    if (IS_WINDOWS && audioCodec !== "none") {
      console.log(`[Session] Starting Windows audio pipeline post-navigation...`);
      audioSession = await startAudioStream(sessionId, audioCodec);
      console.log(`[Session] Audio method: ${audioSession.method} | sink: ${audioSession.sinkName}`);
    }

    // Reroute audio on Linux
    setTimeout(async () => {
      if (audioSession.reroute) await audioSession.reroute();
    }, 2_000);

    // ── 6. Register session ──────────────────────────────────────────────────
    createSession(sessionId, context, page, {
      width: sessionWidth,
      height: sessionHeight,
      browser,
      audioSession,
      unmutePoll,   // stored so we can clear it on deleteSession
    });

    console.log(`[Session] Ready: ${sessionId}`);

    res.json({
      sessionId,
      width: sessionWidth,
      height: sessionHeight,
      audioMethod: audioSession.codec || audioSession.method,
    });
  } catch (err) {
    console.error("[/start-session] Fatal error:", err.message);
    if (page) await page.close().catch(() => { });
    if (context) await context.close().catch(() => { });
    if (browser) await browser.close().catch(() => { });
    if (audioSession) await audioSession.stop().catch(() => { });
    res.status(500).json({ error: "Failed to start session", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /end-session
// ─────────────────────────────────────────────────────────────────────────────
app.post("/end-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    await deleteSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error("[/end-session]", err);
    res.status(500).json({ error: "Failed to end session" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Video streaming — CDP screencast → WebSocket binary frames
// Frame format: [ 0x01, ...jpegBytes ]  (matches client binary handler)
// Delta suppression: identical frames are dropped to save bandwidth.
// ─────────────────────────────────────────────────────────────────────────────
function quickHash(buf) {
  // Sample every 64th byte — fast enough to run on every frame
  let h = 0;
  for (let i = 0; i < buf.length; i += 64) {
    h = (Math.imul(h, 31) + buf[i]) >>> 0;
  }
  return h;
}

async function startVideoStream(session, ws) {
  console.log(`[Stream] Starting screencast for session ${session.id}`);

  const VIDEO_TAG = Buffer.from([0x01]);
  let lastHash = -1;
  let skipped = 0;
  let sent = 0;
  let lastStatTs = Date.now();
  let lastSentTs = Date.now();
  const FORCE_INTERVAL_MS = 5000; // always send a frame at least this often

  const cdpSession = await startScreencast(
    session.page,
    (frameBuffer) => {
      if (ws.readyState !== ws.constructor.OPEN) return;

      const hash = quickHash(frameBuffer);
      const now = Date.now();
      const age = now - lastSentTs;

      // Skip if identical and not overdue for a forced refresh
      if (hash === lastHash && age < FORCE_INTERVAL_MS) {
        skipped++;
      } else {
        lastHash = hash;
        lastSentTs = now;
        sent++;
        try {
          ws.send(Buffer.concat([VIDEO_TAG, frameBuffer]));
        } catch {
          // client disconnected mid-frame
        }
      }

      // Log stats every 5s
      if (now - lastStatTs >= 5000) {
        const total = sent + skipped;
        const pct = total ? Math.round(skipped / total * 100) : 0;
        console.log(`[Stream] frames sent=${sent} skipped=${skipped} (${pct}% saved)`);
        sent = 0; skipped = 0; lastStatTs = now;
      }
    },
    // Capture at device pixel ratio to get full-resolution frames
    { maxWidth: session.viewport.width * 2, maxHeight: session.viewport.height * 2, quality: 85 }
  );

  updateSession(session.id, { cdpSession });
  console.log(`[Stream] Screencast running with delta suppression`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
  setInterval(() => cleanupIdleSessions(300_000).catch(console.error), 60_000);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  console.log(`[WS] Client connected: ${req.socket.remoteAddress}`);

  ws.on("message", async (raw) => {
    if (Buffer.isBuffer(raw) && raw[0] !== 0x7b) return;

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const session = getSession(data.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid session" }));
      return;
    }

    // ── start-stream ─────────────────────────────────────────────────────────
    if (data.type === "start-stream") {
      updateSession(data.sessionId, { ws });
      session.audioSession?.flushAudio(ws);

      try {
        await startVideoStream(session, ws);
        ws.send(
          JSON.stringify({
            type: "stream-started",
            width: session.viewport.width,
            height: session.viewport.height,
          })
        );
      } catch (err) {
        console.error("[WS] Stream start failed:", err);
        ws.send(
          JSON.stringify({ type: "error", message: "Failed to start stream: " + err.message })
        );
      }
      return;
    }

    // ── stop-stream ──────────────────────────────────────────────────────────
    if (data.type === "stop-stream") {
      if (session.cdpSession) {
        await stopScreencast(session.cdpSession);
        updateSession(data.sessionId, { cdpSession: null });
      }
      ws.send(JSON.stringify({ type: "stream-stopped" }));
      return;
    }

    if (data.type === "ping") return;

    // ── input events ─────────────────────────────────────────────────────────
    await handleInput(session.page, data);
  });

  ws.on("error", (err) => console.error("[WS] Error:", err.message));
});