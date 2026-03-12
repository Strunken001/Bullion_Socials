/**
 * audioCaptureInjection.js
 *
 * Injected as an init script into every Playwright page.
 * Strategy: Hook HTMLMediaElement.play() and AudioContext so that ANY audio
 * playing on the page (video, audio elements, Web Audio API) gets captured
 * and streamed back to the server as raw 16-bit PCM mono 48 kHz.
 *
 * This works in headless Chrome because we bypass the need for
 * getDisplayMedia (which requires a real display) by tapping directly into
 * the Web Audio graph.
 */
(function installAudioHooks() {
    // Prevent double-installation across navigations
    if (window.__audioCaptureInstalled) return;
    window.__audioCaptureInstalled = true;

    // ── Shared state ──────────────────────────────────────────────────────────
    let captureContext = null;
    let destinationNode = null;   // MediaStreamAudioDestinationNode
    let processorNode = null;
    let wsRef = null;
    let connectedSources = new WeakSet();

    const SAMPLE_RATE = 48000;
    const BUFFER_SIZE = 4096;

    function getOrCreateCaptureContext() {
        if (captureContext && captureContext.state !== 'closed') return captureContext;

        try {
            captureContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE,
                latencyHint: 'interactive', // Changed from playback for lower latency
            });

            console.log('[AudioCapture] Created AudioContext at', captureContext.sampleRate, 'Hz');

            // Resume immediately — we have --autoplay-policy=no-user-gesture-required
            captureContext.resume().catch(() => { });

            // A single destination node that everything feeds into
            destinationNode = captureContext.createMediaStreamDestination();

            // ScriptProcessor to capture PCM (deprecated but still reliable in Chromium)
            processorNode = captureContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
            
            processorNode.onaudioprocess = (e) => {
                if (!wsRef || wsRef.readyState !== WebSocket.OPEN) return;
                const float32 = e.inputBuffer.getChannelData(0);
                const pcm = new Int16Array(float32.length);
                for (let i = 0; i < float32.length; i++) {
                    const clamped = Math.max(-1, Math.min(1, float32[i]));
                    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
                }
                wsRef.send(pcm.buffer);
            };

            destinationNode.connect(processorNode);
            processorNode.connect(captureContext.destination);
            
            return captureContext;
        } catch (err) {
            console.error('[AudioCapture] Failed to create AudioContext:', err.message);
            return null;
        }
    }

    // ── Helper: connect any AudioNode source to our capture graph ─────────────
    function tapAudioNode(sourceNode, context) {
        if (connectedSources.has(sourceNode)) return;
        connectedSources.add(sourceNode);
        try {
            // We need a gain node bridge because sourceNode may belong to a different
            // AudioContext instance than captureContext.
            // Instead, create a MediaStreamSource bridge.
            const dest = context.createMediaStreamDestination();
            sourceNode.connect(dest);

            const ctx = getOrCreateCaptureContext();
            const bridgeSource = ctx.createMediaStreamSource(dest.stream);
            bridgeSource.connect(destinationNode);
            console.log('[AudioCapture] Tapped AudioNode →', sourceNode.constructor.name);
        } catch (err) {
            console.warn('[AudioCapture] tapAudioNode failed:', err.message);
        }
    }

    // ── Helper: connect a media element to our capture graph ──────────────────
    function tapMediaElement(el) {
        if (connectedSources.has(el)) return;
        connectedSources.add(el);
        try {
            const ctx = getOrCreateCaptureContext();
            const src = ctx.createMediaElementSource(el);
            src.connect(destinationNode);
            // Re-connect to default output so the page still plays audio locally
            src.connect(ctx.destination);
            console.log('[AudioCapture] Tapped <' + el.tagName.toLowerCase() + '>');
        } catch (err) {
            // createMediaElementSource throws if element already has a source node
            // in another context — in that case we can't tap it, but that's OK.
            console.warn('[AudioCapture] tapMediaElement failed:', err.message);
        }
    }

    // ── Intercept HTMLMediaElement.play ───────────────────────────────────────
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        // Tap on next tick so src/srcObject is set first
        setTimeout(() => tapMediaElement(this), 0);
        return origPlay.apply(this, arguments);
    };

    // ── Intercept AudioContext.createMediaElementSource ───────────────────────
    // Some sites (YouTube) call this themselves — we need to not double-tap.
    const origCreateMES = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (el) {
        const node = origCreateMES.apply(this, arguments);
        // Mark as already tapped so tapMediaElement skips it
        connectedSources.add(el);
        // But still route output into our capture graph
        setTimeout(() => {
            try {
                const ctx = getOrCreateCaptureContext();
                const bridge = ctx.createMediaStreamSource(
                    this.createMediaStreamDestination().stream
                );
                // Can't easily bridge here without the dest — just watch the node
                tapAudioNode(node, this);
            } catch (_) { }
        }, 0);
        return node;
    };

    // ── Scan existing media elements on DOM ready ─────────────────────────────
    function scanExisting() {
        document.querySelectorAll('audio, video').forEach(el => {
            if (!el.paused || el.readyState >= 2) tapMediaElement(el);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanExisting);
    } else {
        scanExisting();
    }

    // MutationObserver to catch dynamically added media elements
    const mo = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') tapMediaElement(node);
                node.querySelectorAll?.('audio, video').forEach(tapMediaElement);
            }
        }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // ── Public init function called from server.js after page load ────────────
    window.initAudioCapture = async function (wsUrl, sessionId) {
        try {
            if (wsRef && wsRef.readyState === WebSocket.OPEN) {
                wsRef.close();
            }

            // Include sessionId in URL query param so server knows which session
            const fullUrl = sessionId ? `${wsUrl}?audioSession=${sessionId}` : wsUrl;
            wsRef = new WebSocket(fullUrl);
            wsRef.binaryType = 'arraybuffer';

            wsRef.onopen = () => {
                console.log('[AudioCapture] WS connected, sending audio handshake');
                // Send a JSON handshake so server can register this WS as an audio channel
                wsRef.send(JSON.stringify({
                    type: 'audio-init',
                    sessionId: sessionId,
                }));
                // Ensure capture context is running
                getOrCreateCaptureContext();
                // Scan for any media that started before WS connected
                scanExisting();
            };

            wsRef.onclose = () => console.log('[AudioCapture] WS closed');
            wsRef.onerror = (e) => console.warn('[AudioCapture] WS error');
        } catch (err) {
            console.error('[AudioCapture] initAudioCapture failed:', err);
        }
    };

    console.log('[AudioCapture] Hooks installed');
})();