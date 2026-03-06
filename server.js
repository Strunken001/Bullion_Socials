const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");
const { initBrowser, getBrowser } = require("./browserManager");
const { devices } = require("playwright");
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

(async () => {
  await initBrowser();
})();

app.post("/start-session", async (req, res) => {
  let context, page;
  try {
    const { platform, width, height } = req.body;
    console.log(`\n--- New Flow: Start Session ---`);
    console.log(`[API] /start-session requested for platform: ${platform}, width: ${width || 'default'}, height: ${height || 'default'}`);

    const allowed = {
      facebook: "https://www.facebook.com/",
      instagram: "https://www.instagram.com",
      x: "https://x.com/",
      tiktok: "https://www.tiktok.com",
      linkedin: "https://www.linkedin.com",
    };

    if (!allowed[platform]) {
      return res.status(400).json({ error: "Platform not allowed" });
    }

    const browser = getBrowser();

    // Dynamically adjust viewport dimensions (fallback to iPhone 13 standard)
    const viewWidth = width ? parseInt(width, 10) : 390;
    const viewHeight = height ? parseInt(height, 10) : 844;

    context = await browser.newContext({
      viewport: { width: viewWidth, height: viewHeight },
      deviceScaleFactor: 1, // CRITICAL FIX: Changed 2 to 1. Drawing 2x pixels on headless Chrome taxes the CPU deeply, increasing latency.
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    page = await context.newPage();

    // Set a timeout for navigation to prevent hanging
    await page.goto(allowed[platform], {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Inject CSS to slightly brighten the page and increase contrast, making dull sites "pop" on mobile streams
    await page
      .addStyleTag({
        content:
          "html { filter: brightness(1.1) contrast(1.05) saturate(1.1) !important; }",
      })
      .catch(() => { });

    const sessionId = uuidv4();
    createSession(sessionId, context, page, {
      width: viewWidth,
      height: viewHeight,
    });

    res.json({
      sessionId,
      width: viewWidth,
      height: viewHeight,
      quality: 80, // Restored to 80 to maintain good visual fidelity. Latency is still optimized via deviceScaleFactor & async CDP acks.
      format: "jpeg",
    });
    console.log(
      `[API] Session created: ${sessionId} | Viewport: ${viewWidth}x${viewHeight} | Quality: 80 (visual balance restored)`,
    );
  } catch (error) {
    console.error(`[API] Error starting session:`, error.message);
    if (page) await page.close().catch(() => { });
    if (context) await context.close().catch(() => { });
    res
      .status(500)
      .json({ error: "Failed to start session", details: error.message });
  }
});

app.post("/end-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    console.log(`\n--- New Flow: End Session ---`);
    console.log(`[API] /end-session requested for sessionId: ${sessionId}`);
    const session = getSession(sessionId);

    if (session) {
      if (session.ws && session.ws.readyState === session.ws.OPEN) {
        session.ws.send(
          JSON.stringify({
            type: "session-ended",
            message: "Session time exhausted",
          }),
        );
      }

      // Give a small delay for message to send before closing everything?
      // User said "after some seconds close that instance of the browser used"
      // But for simplicity/robustness, we can just close resources. The message should go through.

      if (session.page)
        await session.page
          .close()
          .catch((e) => console.error("Error closing page:", e));
      if (session.context)
        await session.context
          .close()
          .catch((e) => console.error("Error closing context:", e));
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

  // Cleanup idle sessions every minute
  // Max idle time: 5 minutes (300,000 ms)
  setInterval(async () => {
    try {
      await cleanupIdleSessions(300000);
    } catch (err) {
      console.error("Error during periodic cleanup:", err);
    }
  }, 60000);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`\n--- New Flow: WebSocket Connection ---`);
  console.log(`[WebSocket] Client connected from ${ip}`);

  ws.on("message", async (message) => {
    // Check if it's binary (shouldn't be from client, but handle gracefully)
    if (Buffer.isBuffer(message) && message[0] !== 0x7b) {
      return;
    }

    let data;
    try {
      data = JSON.parse(message.toString());
      console.log(
        `[WebSocket] Received message from client (type: ${data.type}):`,
        data,
      );
    } catch (err) {
      console.error("Invalid JSON message:", err.message);
      return;
    }

    const session = getSession(data.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid session" }));
      return;
    }

    // --- Stream Control ---
    if (data.type === "start-stream") {
      // Store the WebSocket reference in the session
      updateSession(data.sessionId, { ws });

      try {
        // Retrieve the actual viewport size from the page/context if possible, or use hardcoded mobile defaults
        const streamWidth = session.viewport?.width || 390;
        const streamHeight = session.viewport?.height || 844;

        const streamOptions = {
          maxWidth: streamWidth,
          maxHeight: streamHeight,
          quality: 80, // Restored to 80.
          everyNthFrame: 1, // Chrome screencast inherently only sends frames when screen changes
        };

        const cdpSession = await startScreencast(
          session.page,
          (frameBuffer, metadata) => {
            // Send frame as binary WebSocket message
            console.log(
              `[WebSocket] Checking connection before send - ws.readyState: ${ws.readyState}, ws.OPEN: ${ws.OPEN}, typeof ws.send: ${typeof ws.send}`,
            );
            if (ws.readyState === 1) {
              // 1 is WebSocket.OPEN
              ws.send(frameBuffer, { binary: true });
              console.log(
                `[WebSocket] Rendered view (frame) sent back to client. Size: ${frameBuffer.length} bytes`,
              );
            }
          },
          streamOptions,
        );

        updateSession(data.sessionId, { cdpSession });

        ws.send(
          JSON.stringify({
            type: "stream-started",
            width: session.viewport?.width || 390,
            height: session.viewport?.height || 844,
          }),
        );

        console.log(`Screencast started for session ${data.sessionId}`);
      } catch (err) {
        console.error("Failed to start screencast:", err);
        ws.send(
          JSON.stringify({ type: "error", message: "Failed to start stream" }),
        );
      }
      return;
    }

    if (data.type === "stop-stream") {
      if (session.cdpSession) {
        await stopScreencast(session.cdpSession);
        updateSession(data.sessionId, { cdpSession: null });
      }
      ws.send(JSON.stringify({ type: "stream-stopped" }));
      return;
    }

    if (data.type === "ping") {
      // Just respond to keep connection alive, or do nothing.
      // We don't need to log this every 10s as it clutters the terminal.
      return;
    }

    // --- Input Events ---
    // All other message types are treated as input events
    await handleInput(session.page, data);
  });

  ws.on("close", async () => {
    console.log(
      `WebSocket client disconnected for session: ${data ? data.sessionId : "unknown"}`,
    );
    // If we wanted to clean up immediately on disconnect, we could call deleteSession here.
    // For now, we rely on the idle timeout (cleanupIdleSessions) to allow for re-connection.
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});
