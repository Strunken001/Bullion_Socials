/**
 * browserManager.js
 *
 * Cross-platform Playwright browser manager — optimised for Docker on Windows Server.
 *
 * ── Why headless: true with SwiftShader? ────────────────────────────────────
 * On a Windows Server (no display) running a Linux Docker container:
 *   - Xvfb provides a virtual framebuffer (configured in Dockerfile)
 *   - SwiftShader provides software GPU compositing
 *   - Together they enable: WebRTC video, Web Audio API, and WebGL — without real GPU
 *
 * ── @roamhq/wrtc on Windows ──────────────────────────────────────────────────
 * @roamhq/wrtc ships no native Windows binary.
 * ALWAYS run this service inside a Linux Docker container on the Windows host.
 * The Dockerfile in this repo handles that automatically.
 */

const { chromium } = require('playwright');
const os = require('os');

let browser = null;

const IS_LINUX   = os.platform() === 'linux';
const IS_WINDOWS = os.platform() === 'win32';

/**
 * Chromium flags — balanced for quality, correctness, and server compatibility.
 * Tested with Playwright on: Ubuntu 22.04 Docker image (Windows Server host).
 */
const CHROMIUM_ARGS = [
  // ── Sandbox & Web Security ─────────────────────────────────────────────────
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--allow-running-insecure-content',
  '--disable-web-security',              // Bypass CORS policy blocks
  '--disable-site-isolation-trials',     // Prevents cross-origin iframe issues

  // ── Software GPU / SwiftShader ─────────────────────────────────────────────
  // SwiftShader is Chromium's built-in software rasterizer.
  // These flags together activate it without requiring a physical GPU or display.
  '--use-gl=swiftshader',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',        // Required on Chromium ≥ 112
  '--disable-gpu',                      // Tell Chrome not to use real GPU (will fail on server)
  '--disable-gpu-sandbox',
  // NOTE: '--disable-software-rasterizer' is intentionally REMOVED.
  // It conflicts with '--use-gl=swiftshader' — SwiftShader IS the software rasterizer.
  // Keeping both flags causes a contradictory state where SwiftShader is disabled.

  // ── Colour accuracy ────────────────────────────────────────────────────────
  // Ensures frames captured via CDP have correct, consistent sRGB colours.
  '--force-color-profile=srgb',
  '--disable-partial-raster',           // More complete frame rendering per repaint

  // ── Virtual display (Windows Server without display adapter) ──────────────
  ...(IS_WINDOWS ? [
    '--disable-direct-composition',     // No DirectComposition without a real display
    '--disable-d3d11',                  // No Direct3D 11 without GPU
  ] : []),

  // ── Audio (critical for Web Audio API on headless servers) ────────────────
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-user-gesture-required',
  '--audio-output-channels=1',           // Simplify to mono for capture
  '--disable-features=AudioServiceSandbox', // Prevents sandbox issues with virtual audio
  // Ensure '--mute-audio' is NEVER added here.

  // ── Performance ────────────────────────────────────────────────────────────
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',            // /dev/shm too small on some Docker hosts → use /tmp
  '--disable-smooth-scrolling',
  '--no-zygote',                        // Avoids zygote process crashes in containerised environments

  // ── CDP Screencast quality ─────────────────────────────────────────────────
  // Keeps the compositor running at full speed so CDP screencast gets every
  // rendered frame instead of throttled/blank ones.
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--run-all-compositor-stages-before-draw',

  // ── Memory / process ──────────────────────────────────────────────────────
  '--js-flags=--max-old-space-size=512', // Cap V8 heap per tab at 512 MB
  '--disable-ipc-flooding-protection',

  // ── Misc ──────────────────────────────────────────────────────────────────
  '--lang=en-US',
  '--disable-extensions',
  '--disable-default-apps',
  '--no-first-run',
  '--disable-sync',
  '--disable-translate',
];

async function initBrowser() {
  browser = await chromium.launch({
    // headless: true — renders via SwiftShader inside the Xvfb virtual display
    // provided by the Docker container.  Do NOT change to false on a server
    // without a real display: it will crash without Xvfb.
    headless: true,

    args: CHROMIUM_ARGS,

    // On Windows: Playwright may need help finding Chromium.
    // Uncomment and set this if `npx playwright install chromium` used a
    // non-standard path:
    // executablePath: 'C:\\path\\to\\chrome.exe',

    // Increase timeout for slower container/VM startup
    timeout: 60000,
  });

  browser.on('disconnected', () => {
    console.warn('[Browser] Disconnected — restarting in 2s…');
    browser = null;
    setTimeout(() => {
      initBrowser().catch(e => console.error('[Browser] Restart failed:', e));
    }, 2000);
  });

  console.log(`[Browser] Started (platform: ${os.platform()}, headless: true + SwiftShader/Xvfb)`);
  return browser;
}

function getBrowser() {
  if (!browser) throw new Error('Browser not initialised — call initBrowser() first');
  return browser;
}

module.exports = { initBrowser, getBrowser };