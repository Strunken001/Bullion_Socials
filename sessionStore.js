/**
 * Session Store - Manages all active browser sessions.
 * Stores browser, context, page, audioSession so nothing leaks on cleanup.
 */

const sessions = new Map();

/**
 * Create a new session entry.
 * @param {string} id
 * @param {object} context  - Playwright BrowserContext
 * @param {object} page     - Playwright Page
 * @param {object} extras   - { width, height, browser, audioSession }
 */
function createSession(id, context, page, extras = {}) {
  sessions.set(id, {
    context,
    page,
    viewport: {
      width: extras.width || 390,
      height: extras.height || 850,
    },
    browser: extras.browser || null,
    audioSession: extras.audioSession || null,
    cdpSession: null,
    ws: null,
    lastActivity: Date.now(),
  });
}

function getSession(id) {
  const session = sessions.get(id);
  if (session) session.lastActivity = Date.now();
  return session;
}

function updateSession(id, updates) {
  const session = sessions.get(id);
  if (session) {
    Object.assign(session, updates);
    session.lastActivity = Date.now();
  }
}

/**
 * Fully tear down and delete a session.
 */
async function deleteSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  console.log(`[SessionStore] Cleaning up session ${id}...`);
  sessions.delete(id); // Remove first to prevent double-cleanup

  try {
    // Stop WebRTC peer connection and data channel
    if (session.peerConnection) {
      if (session.videoChannel) {
        session.videoChannel.close();
      }
      session.peerConnection.close();
    }

    // Stop screencast CDP session
    if (session.cdpSession) {
      const { stopScreencast } = require("./streamManager");
      await stopScreencast(session.cdpSession).catch(() => { });
    }

    // Stop audio (kills FFmpeg + unloads PulseAudio module)
    if (session.audioSession?.stop) {
      await session.audioSession.stop().catch(() => { });
    }

    // Close page and context in order
    if (session.page) await session.page.close().catch(() => { });
    if (session.context) await session.context.close().catch(() => { });

    // Notify WebSocket client if still connected
    if (session.ws?.readyState === 1 /* OPEN */) {
      session.ws.send(
        JSON.stringify({
          type: "session-ended",
          message: "Session cleaned up",
        }),
      );
    }
  } catch (err) {
    console.info(`[SessionStore] Cleanup warning for ${id}:`, err.message);
  }

  console.log(`[SessionStore] Session ${id} deleted`);
}

/**
 * Idle-timeout cleanup — call on a setInterval.
 */
async function cleanupIdleSessions(maxIdleMs) {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActivity > maxIdleMs) {
      console.log(
        `[SessionStore] Session ${id} idle for ${Math.round((now - session.lastActivity) / 1000)}s — cleaning up`,
      );
      await deleteSession(id);
    }
  }
}

module.exports = {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  cleanupIdleSessions,
  getAllSessions: () => sessions,
};
