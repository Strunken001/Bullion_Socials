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
                stream: 'stream2024',   // username: stream, password: stream2024
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
        console.log('[TURN] Credentials — username: stream | password: stream2024');
        return true;

    } catch (err) {
        // node-turn not installed — warn but don't crash the server
        if (err.code === 'MODULE_NOT_FOUND') {
            console.warn('[TURN] node-turn not installed. Run: npm install node-turn');
            console.warn('[TURN] Falling back to public TURN servers (less reliable)');
        } else {
            console.error('[TURN] Failed to start:', err.message);
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