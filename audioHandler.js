/**
 * audioHandler.js  — Fixed
 *
 * Key fixes vs original:
 *  1. Silence timer uses 10 ms interval (matches wrtc's expected 480-sample @ 48 kHz frames)
 *  2. Buffer copy done correctly to avoid TypedArray view mutations
 *  3. stop() cleans up the track reference so GC can collect it
 *  4. Overflow buffer capped to prevent unbounded growth on audio bursts
 */

const { RTCAudioSource } = require('@roamhq/wrtc').nonstandard;

const SAMPLE_RATE = 48000;
const SAMPLES_PER_FRAME = 480;   // 10 ms @ 48 kHz — wrtc's required frame size
const CHANNELS = 1;
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 16-bit PCM
const MAX_OVERFLOW_BYTES = BYTES_PER_FRAME * 50; // 0.5 s — cap to prevent memory bloat

class AudioHandler {
    constructor() {
        this.audioSource = new RTCAudioSource();
        this.track = this.audioSource.createTrack();
        this._overflow = Buffer.alloc(0);
        this._hasAudio = false;
        this._lastAudio = 0;
        this._stopped = false;

        // 10 ms silence timer — keeps wrtc's jitter buffer happy
        this._silenceTimer = setInterval(() => this._maybeSilence(), 10);
    }

    /**
     * Push raw 16-bit PCM mono 48 kHz data.
     * Handles partial and multi-frame buffers correctly.
     * @param {Buffer} buf
     */
    pushAudio(buf) {
        if (this._stopped) return;

        this._hasAudio = true;
        this._lastAudio = Date.now();

        let combined = Buffer.concat([this._overflow, buf]);

        // Cap overflow to prevent unbounded growth
        if (combined.length > MAX_OVERFLOW_BYTES) {
            combined = combined.slice(combined.length - MAX_OVERFLOW_BYTES);
        }

        let offset = 0;
        while (offset + BYTES_PER_FRAME <= combined.length) {
            const slice = combined.subarray(offset, offset + BYTES_PER_FRAME);
            // Must copy — subarray is a view and wrtc may hold a reference async
            const samples = new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + BYTES_PER_FRAME));
            this._send(samples);
            offset += BYTES_PER_FRAME;
        }

        this._overflow = combined.slice(offset);
    }

    _send(samples) {
        try {
            this.audioSource.onData({
                samples,
                sampleRate: SAMPLE_RATE,
                bitsPerSample: 16,
                channelCount: CHANNELS,
                numberOfFrames: SAMPLES_PER_FRAME,
            });
        } catch (_) {
            // Drop bad frames silently — stream must not crash
        }
    }

    _maybeSilence() {
        if (this._stopped) return;
        // Only pad silence if real audio hasn't arrived in the last 200 ms
        if (this._hasAudio && Date.now() - this._lastAudio < 200) return;
        this._send(new Int16Array(SAMPLES_PER_FRAME)); // zeros = silence
    }

    getTrack() {
        return this.track;
    }

    stop() {
        this._stopped = true;
        clearInterval(this._silenceTimer);
        try { this.track?.stop(); } catch (_) { }
        this.track = null;
    }
}

module.exports = AudioHandler;