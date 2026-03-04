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
};

const MOBILE_WIDTH = 360;
const MOBILE_HEIGHT = 780;

// Chromium args
const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--lang=en-US",
  "--autoplay-policy=no-user-gesture-required",
  ...(IS_WINDOWS ? [
    // Windows: audio runs in-process, uses the default Windows audio device
    "--disable-features=AudioServiceOutOfProcess",
    "--audio-output-channels=2",
  ] : [
    // Linux: keep audio in-process so PULSE_SINK env var is respected
    "--disable-features=AudioServiceOutOfProcess",
    "--disable-features=WebRtcPipeWireCapturer",
    "--audio-output-channels=2",
  ]),
];

// Context options shared by both launches
const CTX_OPTIONS = {
  viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
  deviceScaleFactor: 2,
  locale: "en-US",
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /start-session
// ─────────────────────────────────────────────────────────────────────────────
app.post("/start-session", async (req, res) => {
  let browser, context, page, audioSession;

  try {
    const { platform } = req.body;
    if (!ALLOWED[platform])
      return res.status(400).json({ error: "Platform not allowed" });

    const sessionId = uuidv4();
    console.log(`\n[Session] Starting ${sessionId} — platform: ${platform}`);

    // ── 1. Create audio session (sets up PulseAudio sink) ─────────────────
    audioSession = await startAudioStream(sessionId);
    console.log(
      `[Session] Audio method: ${audioSession.method} | sink: ${audioSession.sinkName}`,
    );

    // ── 2. Launch browser — route audio to our dedicated sink ────────────
    browser = await chromium.launch({
      headless: true,
      env: {
        ...process.env,
        ...(IS_WINDOWS ? {} : {
          // Linux: route audio to our dedicated PulseAudio null-sink
          DISPLAY,
          XDG_RUNTIME_DIR,
          PULSE_SERVER,
          PULSE_SINK: audioSession.sinkName,
        }),
      },
      args: CHROMIUM_ARGS,
    });

    context = await browser.newContext(CTX_OPTIONS);
    page = await context.newPage();

    // ── 3. Navigate ────────────────────────────────────────────────────────
    await page.goto(ALLOWED[platform], {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait 2s then move any Chromium audio streams to our sink
    setTimeout(async () => {
      if (audioSession.reroute) await audioSession.reroute();
    }, 2000);

    // await new Promise((r) => setTimeout(r, 2000));
    // await audioSession.reroute();

    // ── 4. Inject: auto-unmute all media + visual boost ───────────────────
    await page
      .addInitScript(() => {
        // Force-unmute every audio/video element as soon as it appears
        function unmute(el) {
          try {
            el.muted = false;
            el.volume = 1.0;
          } catch (e) {}
        }

        // Unmute existing elements
        document.querySelectorAll("audio,video").forEach(unmute);

        // Unmute future elements
        new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeName === "AUDIO" || node.nodeName === "VIDEO") {
                // Small delay to let the element initialise
                setTimeout(() => unmute(node), 50);
              }
            }
          }
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      })
      .catch(() => {});

    await page
      .addStyleTag({
        content: "html { filter: brightness(1.08) contrast(1.04) !important; }",
      })
      .catch(() => {});

    // ── 5. Register session ────────────────────────────────────────────────
    createSession(sessionId, context, page, {
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
      browser,
      audioSession,
    });

    console.log(`[Session] Ready: ${sessionId}`);

    res.json({
      sessionId,
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
      audioMethod: audioSession.method,
    });
  } catch (err) {
    console.error("[/start-session] Fatal error:", err.message);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (audioSession) await audioSession.stop().catch(() => {});
    res
      .status(500)
      .json({ error: "Failed to start session", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /end-session
// ─────────────────────────────────────────────────────────────────────────────
app.post("/end-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    await deleteSession(sessionId); // sessionStore handles full teardown
    res.json({ success: true });
  } catch (err) {
    console.error("[/end-session]", err);
    res.status(500).json({ error: "Failed to end session" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
  // Idle cleanup every 60s — kill sessions idle for 5 min
  setInterval(() => cleanupIdleSessions(300_000).catch(console.error), 60_000);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  console.log(`[WS] Client connected: ${req.socket.remoteAddress}`);

  ws.on("message", async (raw) => {
    // Ignore non-JSON binary blobs
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

    // ── start-stream ───────────────────────────────────────────────────────
    if (data.type === "start-stream") {
      updateSession(data.sessionId, { ws });

      // Send buffered WebM header + early audio chunks to the new client
      session.audioSession?.flushAudio(ws);

      try {
        const cdpSession = await startScreencast(
          session.page,
          (frameBuffer) => {
            if (ws.readyState === 1) {
              ws.send(Buffer.concat([Buffer.from([0x01]), frameBuffer]), {
                binary: true,
              });
            }
          },
          { maxWidth: MOBILE_WIDTH, maxHeight: MOBILE_HEIGHT, quality: 70 },
        );

        updateSession(data.sessionId, { cdpSession });
        ws.send(
          JSON.stringify({
            type: "stream-started",
            width: MOBILE_WIDTH,
            height: MOBILE_HEIGHT,
          }),
        );
      } catch (err) {
        console.error("[WS] Screencast start failed:", err);
        ws.send(
          JSON.stringify({ type: "error", message: "Failed to start stream" }),
        );
      }
      return;
    }

    // ── stop-stream ────────────────────────────────────────────────────────
    if (data.type === "stop-stream") {
      if (session.cdpSession) {
        await stopScreencast(session.cdpSession);
        updateSession(data.sessionId, { cdpSession: null });
      }
      ws.send(JSON.stringify({ type: "stream-stopped" }));
      return;
    }

    if (data.type === "ping") return;

    // ── input events ───────────────────────────────────────────────────────
    await handleInput(session.page, data);
  });

  ws.on("error", (err) => console.error("[WS] Error:", err.message));
});
