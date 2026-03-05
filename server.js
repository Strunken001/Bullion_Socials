const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");
const { initBrowser, getBrowser } = require("./browserManager");
const {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  cleanupIdleSessions,
} = require("./sessionStore");
const { startScreencast, stopScreencast } = require("./streamManager");
const { handleInput } = require("./inputHandler");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Serve the client HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client.html"));
});

// Initialise shared browser instance on startup
(async () => {
  await initBrowser();
})();

// ─────────────────────────────────────────────────────────────────────────────
// POST /start-session
// ─────────────────────────────────────────────────────────────────────────────
// Accepts optional `width` and `height` from the client so the viewport can
// match the viewer's screen dimensions. Falls back to iPhone 14 Pro defaults.
const DEVICE_SCALE = 2;          // matches deviceScaleFactor in context options
const DEFAULT_W = 390;
const DEFAULT_H = 844;

const ALLOWED = {
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com",
  x: "https://x.com/",
  tiktok: "https://www.tiktok.com/",
  linkedin: "https://www.linkedin.com/",
  discord: "https://discord.com/",
  messenger: "https://www.messenger.com/",
  telegram: "https://web.telegram.org/",
  youtube: "https://www.youtube.com/",
  google: "https://www.google.com/",
};

app.post("/start-session", async (req, res) => {
  let context, page;
  try {
    const { platform, width, height } = req.body;

    if (!ALLOWED[platform]) {
      return res.status(400).json({ error: "Platform not allowed" });
    }

    // Use client-provided dimensions if supplied, else fall back to defaults
    const vpW = (Number(width) > 0 ? Math.round(Number(width)) : DEFAULT_W);
    const vpH = (Number(height) > 0 ? Math.round(Number(height)) : DEFAULT_H);

    console.log(`[Session] Starting — platform: ${platform} viewport: ${vpW}×${vpH}`);

    const browser = getBrowser();

    context = await browser.newContext({
      viewport: { width: vpW, height: vpH },
      deviceScaleFactor: DEVICE_SCALE,
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });

    page = await context.newPage();

    await page.goto(ALLOWED[platform], {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Subtle brightness/contrast boost — makes streams look less washed-out
    await page
      .addStyleTag({
        content: "html { filter: brightness(1.05) contrast(1.03) !important; }",
      })
      .catch(() => { });

    const sessionId = uuidv4();
    createSession(sessionId, context, page, { width: vpW, height: vpH });

    console.log(`[Session] Ready: ${sessionId}`);
    res.json({ sessionId, width: vpW, height: vpH });

  } catch (err) {
    console.error("[/start-session] Error:", err.message);
    if (page) await page.close().catch(() => { });
    if (context) await context.close().catch(() => { });
    res.status(500).json({ error: "Failed to start session", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /end-session
// ─────────────────────────────────────────────────────────────────────────────
app.post("/end-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = getSession(sessionId);

    if (session) {
      if (session.ws?.readyState === 1 /* OPEN */) {
        session.ws.send(JSON.stringify({ type: "session-ended", message: "Session ended" }));
      }
      await session.page?.close().catch(() => { });
      await session.context?.close().catch(() => { });
      deleteSession(sessionId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[/end-session]", err.message);
    res.status(500).json({ error: "Failed to end session" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Delta frame suppression helpers
// ─────────────────────────────────────────────────────────────────────────────
// Fast non-cryptographic hash: samples every 64th byte.
// Collision probability is tiny for JPEG frames (~1/4B) and doesn't matter
// — a missed duplicate just means one extra frame sent.
function quickHash(buf) {
  let h = 0;
  for (let i = 0; i < buf.length; i += 64) {
    h = (Math.imul(h, 31) + buf[i]) >>> 0;
  }
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket server
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
  setInterval(async () => {
    try { await cleanupIdleSessions(300_000); } catch (err) {
      console.error("[Cleanup]", err.message);
    }
  }, 60_000);
});

const wss = new WebSocketServer({ server });

const VIDEO_TAG = Buffer.from([0x01]); // binary frame type prefix expected by client
const FORCE_REFRESH_MS = 5_000;        // always send a frame at least this often

wss.on("connection", (ws, req) => {
  console.log(`[WS] Client connected: ${req.socket.remoteAddress}`);

  ws.on("message", async (raw) => {
    // Ignore non-JSON binary (client only sends JSON)
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

    // ── start-stream ──────────────────────────────────────────────────────────
    if (data.type === "start-stream") {
      updateSession(data.sessionId, { ws });

      // Per-session delta state (closed over in the frame callback)
      let lastHash = -1;
      let lastSentTs = 0;
      let statSent = 0;
      let statSkip = 0;
      let statTs = Date.now();

      // Capture at the physical (2×) resolution to match deviceScaleFactor
      const captureW = (session.viewport?.width ?? DEFAULT_W) * DEVICE_SCALE;
      const captureH = (session.viewport?.height ?? DEFAULT_H) * DEVICE_SCALE;

      try {
        const cdpSession = await startScreencast(
          session.page,
          (frameBuffer) => {
            if (ws.readyState !== 1 /* OPEN */) return;

            const hash = quickHash(frameBuffer);
            const now = Date.now();

            if (hash === lastHash && (now - lastSentTs) < FORCE_REFRESH_MS) {
              statSkip++;
            } else {
              lastHash = hash;
              lastSentTs = now;
              statSent++;
              try {
                ws.send(Buffer.concat([VIDEO_TAG, frameBuffer]));
              } catch { /* client disconnected mid-frame */ }
            }

            // Log bandwidth stats every 5 s
            if (now - statTs >= 5_000) {
              const total = statSent + statSkip;
              const pct = total ? Math.round(statSkip / total * 100) : 0;
              console.log(`[Stream] sent=${statSent} skipped=${statSkip} (${pct}% saved)`);
              statSent = 0; statSkip = 0; statTs = now;
            }
          },
          { maxWidth: captureW, maxHeight: captureH, quality: 85 }
        );

        updateSession(data.sessionId, { cdpSession });

        ws.send(JSON.stringify({
          type: "stream-started",
          width: session.viewport?.width ?? DEFAULT_W,
          height: session.viewport?.height ?? DEFAULT_H,
        }));

        console.log(`[Stream] Screencast running at ${captureW}×${captureH} (display ${session.viewport?.width}×${session.viewport?.height})`);

      } catch (err) {
        console.error("[Stream] Start failed:", err.message);
        ws.send(JSON.stringify({ type: "error", message: "Failed to start stream: " + err.message }));
      }
      return;
    }

    // ── stop-stream ───────────────────────────────────────────────────────────
    if (data.type === "stop-stream") {
      if (session.cdpSession) {
        await stopScreencast(session.cdpSession);
        updateSession(data.sessionId, { cdpSession: null });
      }
      ws.send(JSON.stringify({ type: "stream-stopped" }));
      return;
    }

    // ── ping (keep-alive) ─────────────────────────────────────────────────────
    if (data.type === "ping") return;

    // ── all other types → input events ────────────────────────────────────────
    await handleInput(session.page, data);
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });
});
