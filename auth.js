/**
 * auth.js — Authentication for the remote-browser service.
 *
 * Two mechanisms:
 *  1. Service key (X-Socials-Service-Key header) — only the Laravel backend
 *     may call the control endpoints (/start-session, /save-session, /end-session).
 *  2. Per-session signed token — minted by Laravel after a session is created and
 *     handed to the mobile app, which presents it on the WebSocket handshake
 *     (?token=...). Binds a WS control connection to one user + one sessionId.
 *
 * Token format (must match the Laravel signer):
 *   base64url(JSON payload) + "." + base64url(HMAC_SHA256(base64url(payload), secret))
 *   payload = { sid: <sessionId>, uid: <userId>, exp: <unix seconds> }
 */

const crypto = require('crypto');

const SERVICE_KEY = process.env.SOCIALS_SERVICE_KEY || '';
const TOKEN_SECRET = process.env.SOCIALS_TOKEN_SECRET || '';

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Express middleware: only callers presenting the shared service key may proceed.
 * Fails closed if SOCIALS_SERVICE_KEY is not configured.
 */
function requireServiceKey(req, res, next) {
  const provided = req.get('X-Socials-Service-Key') || '';
  if (!SERVICE_KEY || !provided || !timingSafeEqual(provided, SERVICE_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}

/**
 * Generate a per-session token for a given sessionId and userId.
 * Token is valid for 24 hours.
 */
function generateSessionToken(sessionId, userId) {
  if (!TOKEN_SECRET) return null;
  const exp = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24h from now
  const payload = { sid: sessionId, uid: userId || 'anonymous', exp };
  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payloadBase64)
    .digest();
  const sigBase64 = sig.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return payloadBase64 + '.' + sigBase64;
}

/**
 * Verify a per-session token. Returns the decoded payload ({ sid, uid, exp })
 * on success, or null if the token is missing/malformed/forged/expired.
 */
function verifySessionToken(token) {
  if (!TOKEN_SECRET || !token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  const expected = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payloadPart)
    .digest();
  const provided = b64urlDecode(sigPart);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadPart).toString('utf8'));
  } catch (_) {
    return null;
  }

  if (!payload || typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) {
    return null;
  }
  return payload;
}

module.exports = { requireServiceKey, verifySessionToken, generateSessionToken, timingSafeEqual };
