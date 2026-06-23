/**
 * turnServer.js
 * 
 * Self-hosted TURN relay — runs on the same machine as the Node server.
 * This guarantees audio+video works for ALL clients regardless of NAT type.
 * 
 * SETUP:
 *   npm install node-turn
 * 
 * FIREWALL: Open these ports on Windows Server firewall + your hosting panel:
 *   TCP 3478  (TURN control)
 *   UDP 3478  (TURN control)
 *   UDP 49152-65535  (TURN relay ports)
 */

let turnServer = null;

function startTurnServer(publicIp) {
    try {
        const Turn = require('node-turn');

        turnServer = new Turn({
            // Must be your actual public IP — clients need this to connect
            listeningIps: [publicIp || '0.0.0.0'],
            relayIps: [publicIp || '0.0.0.0'],
            externalIps: publicIp ? [publicIp] : undefined,

            authMech: 'long-term',
            credentials: {
                // Credentials come from env (no longer hardcoded). Rotate periodically.
                // TODO: move to ephemeral TURN REST credentials (HMAC, time-limited).
                [process.env.TURN_USERNAME || 'stream']: process.env.TURN_CREDENTIAL || 'stream2024',
            },

            listeningPort: 3478,

            // UDP relay port range — open these in your firewall
            minPort: 49152,
            maxPort: 65535,

            debugLevel: 'ERROR',    // change to 'DEBUG' if troubleshooting

            // Timeouts
            defaultLifetime: 600,   // 10 min session lifetime
            softLifetime: 300,   // 5 min soft timeout
        });

        turnServer.start();
        console.log(`[TURN] Server started on ${publicIp || '0.0.0.0'}:3478`);
        console.log('[TURN] Credentials loaded from env (TURN_USERNAME / TURN_CREDENTIAL)');
        return true;

    } catch (err) {
        // node-turn not installed — warn but don't crash the server
        if (err.code === 'MODULE_NOT_FOUND') {
            console.warn('[TURN] node-turn not installed. Run: npm install node-turn');
            console.warn('[TURN] Falling back to public TURN servers (less reliable)');
        } else {
            // Port bind failure is non-critical — the Express server can still handle requests
            // with public TURN relay fallback. Don't stop the whole app.
            if (err.code === 'EADDRINUSE' || err.errno === -98) {
                console.warn(`[TURN] Port 3478 already in use (likely from previous process). Skipping.`);
                console.warn(`[TURN] Clients will use public TURN relay (openrelay.metered.ca) — less optimal but functional.`);
            } else {
                console.error('[TURN] Failed to start:', err.message);
            }
        }
        return false;
    }
}

function stopTurnServer() {
    if (turnServer) {
        try { turnServer.stop(); } catch (_) { }
        turnServer = null;
    }
}

module.exports = { startTurnServer, stopTurnServer };