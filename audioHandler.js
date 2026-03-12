const { RTCAudioSource } = require('@roamhq/wrtc').nonstandard;

// wrtc RTCAudioSource requires frames of EXACTLY this size at 48kHz
// 10ms frame = 480 samples per channel at 48kHz
const SAMPLES_PER_FRAME = 480;
const SAMPLE_RATE = 48000;
const CHANNELS = 1;

class AudioHandler {
    constructor() {
        this.audioSource = new RTCAudioSource();
        this.track = this.audioSource.createTrack();
        // Overflow buffer for partial frames
        this._overflow = Buffer.alloc(0);
        // Silence timer — keeps the track alive when no audio arrives
        this._silenceTimer = setInterval(() => this._sendSilence(), 20);
        this._hasAudio = false;
        this._lastAudioTime = 0;
    }

    /**
     * Push raw 16-bit PCM mono 48kHz data. Handles partial and multi-frame buffers.
     * @param {Buffer} buffer
     */
    pushAudio(buffer) {
        this._hasAudio = true;
        this._lastAudioTime = Date.now();

        // Combined with leftover overflow
        const combined = Buffer.concat([this._overflow, buffer]);
        const bytesPerFrame = SAMPLES_PER_FRAME * 2; // 16-bit PCM (2 bytes/sample)
        let offset = 0;

        while (offset + bytesPerFrame <= combined.length) {
            const frameBuffer = combined.subarray(offset, offset + bytesPerFrame);
            
            // Create a COPY of the buffer to avoid external mutation if the source buffer is reused
            const samples = new Int16Array(new Uint8Array(frameBuffer).buffer);

            try {
                this.audioSource.onData({
                    samples,
                    sampleRate: SAMPLE_RATE,
                    bitsPerSample: 16,
                    channelCount: CHANNELS,
                    numberOfFrames: SAMPLES_PER_FRAME,
                });
            } catch (err) {
                // Silently drop bad frames to maintain stream continuity
            }

            offset += bytesPerFrame;
        }

        // Save remainder for next call
        this._overflow = combined.slice(offset);
    }

    _sendSilence() {
        // If real audio arrived recently, don't pad with silence
        if (this._hasAudio && Date.now() - this._lastAudioTime < 500) return;

        const samples = new Int16Array(SAMPLES_PER_FRAME); // zeros = silence
        try {
            this.audioSource.onData({
                samples,
                sampleRate: SAMPLE_RATE,
                bitsPerSample: 16,
                channelCount: CHANNELS,
                numberOfFrames: SAMPLES_PER_FRAME,
            });
        } catch (_) { }
    }

    getTrack() {
        return this.track;
    }

    stop() {
        clearInterval(this._silenceTimer);
        if (this.track) this.track.stop();
    }
}

module.exports = AudioHandler;