const sessions = new Map();

function createSession(id, context, page, viewport = {}) {
  sessions.set(id, { 
    context, 
    page, 
    viewport: { width: viewport.width || 1080, height: viewport.height || 1920 },
    cdpSession: null, 
    ws: null,
    lastActivity: Date.now()
  });
}

function getSession(id) {
  const session = sessions.get(id);
  if (session) {
    session.lastActivity = Date.now();
  }
  return session;
}

function updateSession(id, updates) {
  const session = sessions.get(id);
  if (session) {
    Object.assign(session, updates);
    session.lastActivity = Date.now();
  }
}

async function deleteSession(id) {
  const session = sessions.get(id);
  if (session) {
    console.log(`Cleaning up session ${id}...`);
    try {
      if (session.cdpSession) {
        const { stopScreencast } = require('./streamManager');
        await stopScreencast(session.cdpSession).catch(() => {});
      }
      if (session.page) {
        await session.page.close().catch(() => {});
      }
      if (session.context) {
        await session.context.close().catch(() => {});
      }
    } catch (err) {
      console.warn('Session cleanup warning:', err.message);
    }
    sessions.delete(id);
    console.log(`Session ${id} deleted`);
  }
}

async function cleanupIdleSessions(maxIdleTimeMs) {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActivity > maxIdleTimeMs) {
      console.log(`Session ${id} idled out. Cleaning up...`);
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
  getAllSessions: () => sessions
};