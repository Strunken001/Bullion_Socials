const { nonstandard } = require('@roamhq/wrtc');
const { RTCVideoSource } = nonstandard;

try {
    const source = new RTCVideoSource();

    try {
        const data = new Uint8ClampedArray(390 * 844 * 1.5);
        source.onFrame({ width: 390, height: 844, data });
        console.log("SUCCESS onFrame with YUV Uint8ClampedArray");
    } catch (e) {
        console.log("FAIL YUV:", e.message);
    }

    try {
        const data = new Uint8Array(390 * 844 * 1.5);
        source.onFrame({ width: 390, height: 844, data });
        console.log("SUCCESS onFrame with YUV Uint8Array");
    } catch (e) {
        console.log("FAIL YUV 8:", e.message);
    }

    try {
        const data = new Uint8ClampedArray(390 * 844 * 4);
        source.onFrame({ width: 390, height: 844, data });
        console.log("SUCCESS onFrame with RGBA Uint8ClampedArray");
    } catch (e) {
        console.log("FAIL RGBA:", e.message);
    }

} catch (e) {
    console.log("FATAL:", e);
}
