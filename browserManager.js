/**
 * browserManager.js
 *
 * Windows-safe Playwright browser manager.
 *
 * ── Why headless: false on Windows? ─────────────────────────────────────────
 * headless: true uses Chrome's "headless shell" mode which:
 *   - Disables GPU compositing entirely → blank/black WebRTC video frames
 *   - Disables Web Audio API in many Chromium builds → silent audio capture
 *   - Disables requestAnimationFrame throttling fixes → choppy CDP screencast
 *
 * headless: false on Windows Server (no display) would normally crash, but
 * the flags below enable a "virtual framebuffer" inside Chromium itself using
 * SwiftShader (software GPU), so it renders fully without a real display.
 *
 * ── @roamhq/wrtc on Windows ──────────────────────────────────────────────────
 * @roamhq/wrtc ships no Windows binary. If you are testing locally on Windows:
 *   - Use WSL2 (Ubuntu) — fully supported, recommended for local dev
 *   - Or run inside a Docker container with a Linux base image
 * For Windows Server deployment, the same applies — run the Node process
 * inside WSL2 or a Linux Docker container on the Windows host.
 * The rest of this file (Playwright flags) works natively on Windows.
 */

const { chromium } = require('playwright');
const os = require('os');

let browser = null;

const IS_WINDOWS = os.platform() === 'win32';

/**
 * Chromium flags that enable full rendering without a physical display.
 * These work on Windows, Linux, and macOS.
 */
const CHROMIUM_ARGS = [
  // ── Sandbox ────────────────────────────────────────────────────────────────
  '--no-sandbox',
  '--disable-setuid-sandbox',

  // ── Virtual GPU / Software rendering ──────────────────────────────────────
  // Forces SwiftShader (Chromium's built-in software rasterizer).
  // This is what makes headless:false work without a real GPU or display.
  '--use-gl=swiftshader',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',       // Required on newer Chromium builds
  '--disable-gpu',                     // Don't attempt real GPU (will fail on server)
  '--disable-gpu-sandbox',
  '--disable-software-rasterizer',     // Counterintuitively needed with SwiftShader

  // ── Virtual display (Windows-specific) ────────────────────────────────────
  // On Windows Server with no display adapter, Chromium needs these to not
  // crash when opening a window.
  ...(IS_WINDOWS ? [
    '--disable-direct-composition',    // No DirectComposition on headless Windows
    '--disable-d3d11',                 // No D3D11 without display
  ] : []),

  // ── Audio ──────────────────────────────────────────────────────────────────
  // Critical: these allow Web Audio API and <video> audio to work without
  // a real audio device (which Windows servers don't have).
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-user-gesture-required',

  // ── Performance ───────────────────────────────────────────────────────────
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',           // /dev/shm too small on some Linux VMs
  '--disable-smooth-scrolling',
  '--no-zygote',                       // Faster startup, avoids zygote crashes on some systems

  // ── CDP Screencast quality ─────────────────────────────────────────────────
  // Keeps the compositor running so CDP screencast gets real rendered frames,
  // not blank ones.
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--run-all-compositor-stages-before-draw',

  // ── Misc ──────────────────────────────────────────────────────────────────
  '--lang=en-US',
  '--disable-extensions',
  '--disable-default-apps',
  '--no-first-run',
  '--disable-ipc-flooding-protection',
];

async function initBrowser() {
  browser = await chromium.launch({
    // headless: false — renders via SwiftShader software GPU.
    // This gives you a fully working Web Audio API, proper GPU compositing
    // for CDP screencast, and working WebGL — all without a real display.
    headless: false,

    args: CHROMIUM_ARGS,

    // On Windows, Playwright may need help finding Chromium.
    // Uncomment and set this if `npx playwright install chromium` put it
    // somewhere non-standard:
    // executablePath: 'C:\\path\\to\\chrome.exe',

    // Increase timeout for slower Windows startup
    timeout: 60000,
  });

  browser.on('disconnected', () => {
    console.warn('[Browser] Disconnected — restarting…');
    browser = null;
    initBrowser().catch(e => console.error('[Browser] Restart failed:', e));
  });

  console.log(`[Browser] Started (platform: ${os.platform()}, headless: true + SwiftShader)`);
}

function getBrowser() {
  if (!browser) throw new Error('Browser not initialised — call initBrowser() first');
  return browser;
}

module.exports = { initBrowser, getBrowser };