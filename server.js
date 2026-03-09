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
const { startWebRTCStream, stopWebRTCStream, getAudioHandler } = require("./streamManager");
const { handleInput } = require("./inputHandler");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const fs = require("fs");
const url = require("url");

const audioInjectionScript = fs.readFileSync(
  path.join(__dirname, "audioCaptureInjection.js"),
  "utf8"
);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client.html"));
});

(async () => {
  await initBrowser();
})();

const ALLOWED_PLATFORMS = {
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com",
  x: "https://x.com/",
  tiktok: "https://www.tiktok.com",
  linkedin: "https://www.linkedin.com",
  telegram: "https://web.telegram.org/",
  discord: "https://discord.com/app",
  messenger: "https://www.messenger.com/",
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
};

app.post("/start-session", async (req, res) => {
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
      // deviceScaleFactor: 1 — we get 2x quality by capturing at 2x in CDP
      // screencast (maxWidth * 2). Setting this to 2 here causes a mismatch
      // where the page renders at 780px but CDP only sees a 390px surface.
      deviceScaleFactor: 1,
      locale: "en-US",
      hasTouch: true,
      isMobile: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      bypassCSP: true,
      permissions: ["microphone", "camera"],
    });

    // Inject audio capture hooks before any page script runs
    await context.addInitScript(audioInjectionScript);

    page = await context.newPage();

    // Relay browser console for debugging
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        !text.includes("deprecated") &&
        !text.includes("Failed to load resource") &&
        !text.includes("ERR_")
      ) {
        console.log(`[Browser] ${text}`);
      }
    });

    // Match OS window to viewport via CDP
    const cdp = await context.newCDPSession(page);
    await cdp
      .send("Browser.setWindowBounds", {
        windowId: (await cdp.send("Browser.getWindowForTarget")).windowId,
        bounds: { width: viewWidth, height: viewHeight },
      })
      .catch((e) => console.warn("[CDP] setWindowBounds:", e.message));

    try {
      await page.goto(ALLOWED_PLATFORMS[platform], {
        waitUntil: "commit",
        timeout: 30000,
      });
    } catch (e) {
      console.warn(`[Navigation] ${platform} goto soft-timeout:`, e.message);
    }

    const sessionId = uuidv4();
    createSession(sessionId, context, page, { width: viewWidth, height: viewHeight });

    // Inject audio capture — pass sessionId so server can route binary frames
    // The WS URL points back to this server. The audio WS path is handled in wss.on('connection')
    const serverWsUrl = `ws://localhost:3000`;
    await page
      .evaluate(
        ({ wsUrl, sId }) => {
          if (typeof window.initAudioCapture === "function") {
            window.initAudioCapture(wsUrl, sId).catch(console.error);
          } else {
            // Retry once after a short delay in case script hasn't loaded yet
            setTimeout(() => {
              if (typeof window.initAudioCapture === "function") {
                window.initAudioCapture(wsUrl, sId).catch(console.error);
              }
            }, 1500);
          }
        },
        { wsUrl: serverWsUrl, sId: sessionId }
      )
      .catch((e) => console.warn("[AudioInjection]", e.message));

    res.json({
      sessionId,
      width: viewWidth,
      height: viewHeight,
      quality: 92,
      format: "jpeg",
    });

    console.log(`[API] Session ${sessionId} | ${viewWidth}×${viewHeight}`);
  } catch (error) {
    console.error(`[API] start-session error:`, error.message);
    if (page) await page.close().catch(() => { });
    if (context) await context.close().catch(() => { });
    res.status(500).json({ error: "Failed to start session", details: error.message });
  }
});

app.post("/end-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = getSession(sessionId);
    if (session) {
      if (session.ws?.readyState === session.ws?.OPEN) {
        session.ws.send(
          JSON.stringify({ type: "session-ended", message: "Session ended" })
        );
      }
      if (session.page) await session.page.close().catch(() => { });
      if (session.context) await session.context.close().catch(() => { });
      deleteSession(sessionId);
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to end session" });
  }
});

const server = app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
  setInterval(async () => {
    try {
      await cleanupIdleSessions(300000);
    } catch (err) {
      console.error("Cleanup error:", err);
    }
  }, 60000);
});

const wss = new WebSocketServer({ server });

// ── Audio-only WebSocket connections keyed by sessionId ─────────────────────
// When audioCaptureInjection.js connects with ?audioSession=<id>, we register
// that WS here and push its binary PCM data to the right AudioHandler.
const audioWsSessions = new Map(); // sessionId → ws

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  const parsedUrl = url.parse(req.url, true);
  const audioSessionId = parsedUrl.query?.audioSession;

  // ── Audio-only connection (from audioCaptureInjection.js in the browser) ──
  if (audioSessionId) {
    console.log(`[AudioWS] Browser audio stream connected for session ${audioSessionId}`);
    audioWsSessions.set(audioSessionId, ws);

    ws.on("message", (message) => {
      // Could be JSON handshake or binary PCM
      if (Buffer.isBuffer(message) && message[0] !== 0x7b) {
        // Binary PCM — push to AudioHandler
        const session = getSession(audioSessionId);
        if (session?.webrtcStreamId) {
          const audioHandler = getAudioHandler(session.webrtcStreamId);
          if (audioHandler) audioHandler.pushAudio(message);
        }
        return;
      }

      // JSON handshake — just log it
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "audio-init") {
          console.log(`[AudioWS] Handshake received for session ${msg.sessionId}`);
        }
      } catch (_) { }
    });

    ws.on("close", () => {
      audioWsSessions.delete(audioSessionId);
      console.log(`[AudioWS] Browser audio disconnected for session ${audioSessionId}`);
    });

    return; // Don't fall through to control handler
  }

  // ── Control WebSocket (from client.html) ─────────────────────────────────
  console.log(`\n[WebSocket] Control connection from ${ip}`);
  let currentSessionId = null;

  ws.on("message", async (message) => {
    // Binary audio from client microphone (future feature)
    if (Buffer.isBuffer(message) && message[0] !== 0x7b) {
      const session = getSession(currentSessionId);
      if (session?.webrtcStreamId) {
        const audioHandler = getAudioHandler(session.webrtcStreamId);
        if (audioHandler) audioHandler.pushAudio(message);
      }
      return;
    }

    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error("Invalid JSON:", err.message);
      return;
    }

    if (data.sessionId) currentSessionId = data.sessionId;
    if (data.type !== "ping") {
      console.log(
        `[WS] ${data.type}`,
        data.type === "start-stream" ? "(SDP omitted)" : ""
      );
    }

    const session = getSession(data.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid session" }));
      return;
    }

    // ── Stream control ───────────────────────────────────────────────────────
    if (data.type === "start-stream") {
      updateSession(data.sessionId, { ws });

      if (!data.offerSdp) {
        ws.send(JSON.stringify({ type: "error", message: "offerSdp required" }));
        return;
      }

      try {
        const streamWidth = session.viewport?.width || 390;
        const streamHeight = session.viewport?.height || 844;

        const { answer, streamId } = await startWebRTCStream(
          session.page,
          data.offerSdp,
          { width: streamWidth, height: streamHeight }
        );

        updateSession(data.sessionId, { webrtcStreamId: streamId });

        ws.send(
          JSON.stringify({
            type: "webrtc-answer",
            sdpAnswer: answer,
            width: streamWidth,
            height: streamHeight,
          })
        );

        ws.send(
          JSON.stringify({
            type: "stream-started",
            width: streamWidth,
            height: streamHeight,
          })
        );

        console.log(`[Stream] WebRTC running at ${streamWidth}×${streamHeight}`);
      } catch (err) {
        console.error("[Stream] Start failed:", err.message);
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Failed to start stream: " + err.message,
          })
        );
      }
      return;
    }

    if (data.type === "stop-stream") {
      if (session.webrtcStreamId) {
        stopWebRTCStream(session.webrtcStreamId);
        updateSession(data.sessionId, { webrtcStreamId: null });
      }
      ws.send(JSON.stringify({ type: "stream-stopped" }));
      return;
    }

    if (data.type === "ping") return;

    // ── Input events ─────────────────────────────────────────────────────────
    await handleInput(session.page, data);
  });

  ws.on("close", () => {
    console.log(`[WS] Control disconnected | session: ${currentSessionId || "unknown"}`);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });
});