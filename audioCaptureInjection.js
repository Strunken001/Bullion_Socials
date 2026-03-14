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
    // Prevent double-installation
    if (window.__audioCaptureInstalled) return;
    window.__audioCaptureInstalled = true;

    console.log('[AudioCapture] Installing robust hooks...');

    // ── Shared State ──────────────────────────────────────────────────────────
    let captureContext = null;
    let destinationNode = null;
    let processorNode = null;
    let wsRef = null;
    
    // Track all AudioContexts created by the page
    const knownContexts = new Set();
    const bridgedNodes = new WeakSet();

    const SAMPLE_RATE = 48000;
    const BUFFER_SIZE = 4096;

    // ── Capture Graph Setup ───────────────────────────────────────────────────
    function getOrCreateCaptureContext() {
        if (captureContext && captureContext.state !== 'closed') return captureContext;

        try {
            captureContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE,
                latencyHint: 'interactive',
            });

            console.log('[AudioCapture] Created CaptureContext at', captureContext.sampleRate, 'Hz');

            captureContext.resume().catch(() => { });

            destinationNode = captureContext.createMediaStreamDestination();
            processorNode = captureContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
            
            processorNode.onaudioprocess = (e) => {
                if (!wsRef || wsRef.readyState !== WebSocket.OPEN) return;
                const float32 = e.inputBuffer.getChannelData(0);
                const pcm = new Int16Array(float32.length);
                
                // Peak detection for telemetry
                let peak = 0;
                for (let i = 0; i < float32.length; i++) {
                    const s = float32[i];
                    if (Math.abs(s) > peak) peak = Math.abs(s);
                    const clamped = Math.max(-1, Math.min(1, s));
                    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
                }
                
                wsRef.send(pcm.buffer);
            };

            // FIX: destinationNode (MediaStreamDestination) has no output.
            // We must create a MediaStreamSource from it to pipe through the processor.
            const captureSource = captureContext.createMediaStreamSource(destinationNode.stream);
            captureSource.connect(processorNode);
            processorNode.connect(captureContext.destination);
            
            return captureContext;
        } catch (err) {
            console.error('[AudioCapture] Failed to create CaptureContext:', err.message);
            return null;
        }
    }

    // ── Bridging Logic ────────────────────────────────────────────────────────
    // We intercept any AudioNode connecting to a context's destination.
    const OrigAudioNodeConnect = window.AudioNode.prototype.connect;
    window.AudioNode.prototype.connect = function(destination, outputIndex, inputIndex) {
        const result = OrigAudioNodeConnect.apply(this, arguments);
        
        // If they connect to the final destination, mirror it to our capture context
        if (destination && destination === this.context.destination) {
            const captureCtx = getOrCreateCaptureContext();
            if (captureCtx && destinationNode && this.context !== captureCtx) {
                try {
                    if (!this.__bridgedDest) {
                        this.__bridgedDest = this.context.createMediaStreamDestination();
                        OrigAudioNodeConnect.call(this, this.__bridgedDest, outputIndex);
                        const source = captureCtx.createMediaStreamSource(this.__bridgedDest.stream);
                        source.connect(destinationNode);
                    }
                } catch(e) {
                    console.warn('[AudioCapture] Bridging failed:', e.message);
                }
            }
        }
        return result;
    };

    function bridgeContext(ctx) {
        // Obsolete: Handled dynamically by AudioNode.prototype.connect hook above
    }

    // ── Injection: AudioContext Hook ──────────────────────────────────────────
    const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
    function HookedAudioContext(options) {
        const ctx = new OrigAudioContext(options);
        knownContexts.add(ctx);
        console.log('[AudioCapture] New AudioContext detected');
        
        // Auto-bridge on next tick
        setTimeout(() => bridgeContext(ctx), 100);
        
        return ctx;
    }
    HookedAudioContext.prototype = OrigAudioContext.prototype;
    window.AudioContext = window.webkitAudioContext = HookedAudioContext;

    // ── Injection: MediaElement Hook ──────────────────────────────────────────
    // Useful for sites that don't use Web Audio but just <video>/<audio>
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
        const el = this;
        setTimeout(() => {
            if (bridgedNodes.has(el)) return;
            try {
                const ctx = getOrCreateCaptureContext();
                const source = ctx.createMediaElementSource(el);
                source.connect(destinationNode);
                source.connect(ctx.destination); // Keep local playback
                bridgedNodes.add(el);
                console.log('[AudioCapture] Tapped <' + el.tagName.toLowerCase() + '>');
            } catch (err) {
                // Already connected elsewhere? Manual bridging handled by AudioContext hook then
            }
        }, 0);
        return origPlay.apply(this, arguments);
    };

    // ── Resumption Heartbeat ──────────────────────────────────────────────────
    // Browsers often suspend AudioContexts until a "user gesture" occurs.
    // Since we have --autoplay-policy=no-user-gesture-required, we can 
    // force them back to 'running'.
    setInterval(() => {
        for (const ctx of knownContexts) {
            if (ctx.state === 'suspended') {
                ctx.resume().catch(() => {});
            }
        }
        if (captureContext && captureContext.state === 'suspended') {
            captureContext.resume().catch(() => {});
        }
    }, 2000);

    // ── Public Init ──────────────────────────────────────────────────────────
    window.initAudioCapture = async function (wsUrl, sessionId) {
        try {
            if (wsRef && wsRef.readyState === WebSocket.OPEN) wsRef.close();

            const fullUrl = sessionId ? `${wsUrl}?audioSession=${sessionId}` : wsUrl;
            wsRef = new WebSocket(fullUrl);
            wsRef.binaryType = 'arraybuffer';

            wsRef.onopen = () => {
                console.log('[AudioCapture] WS Connected');
                wsRef.send(JSON.stringify({ type: 'audio-init', sessionId }));
                getOrCreateCaptureContext();
            };

            wsRef.onclose = () => console.log('[AudioCapture] WS Closed');
            wsRef.onerror = (e) => console.warn('[AudioCapture] WS Error');
        } catch (err) {
            console.error('[AudioCapture] Init failed:', err);
        }
    };

    console.log('[AudioCapture] Hooks Installed');
})();