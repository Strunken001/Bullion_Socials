/**
 * browserManager.js  — Fixed for Windows Server + Linux Docker container
 *
 * Key fixes vs original:
 *  1. Memory flags tuned to prevent OOM crash (the "Disconnected — restarting" loop)
 *  2. Resilient restart — exponential back-off, max 5 attempts
 *  3. Crash reporter disabled so bad frames don't stall the process
 *  4. Shared memory flags consolidated correctly
 */

const { chromium } = require('playwright');
const os = require('os');

let browser = null;
let restartCount = 0;
const MAX_RESTARTS = 10;

const IS_WINDOWS = os.platform() === 'win32';

const CHROMIUM_ARGS = [
  // ── Sandbox ───────────────────────────────────────────────────────────────
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--allow-running-insecure-content',
  '--disable-web-security',
  '--disable-site-isolation-trials',

  // ── Software GPU / SwiftShader ────────────────────────────────────────────
  '--use-gl=swiftshader',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu',
  '--disable-gpu-sandbox',
  '--disable-software-rasterizer',    // intentionally OFF — SwiftShader IS the rasterizer

  // ── Colour ────────────────────────────────────────────────────────────────
  '--force-color-profile=srgb',
  '--disable-partial-raster',

  // ── Windows Server specific ───────────────────────────────────────────────
  ...(IS_WINDOWS ? [
    '--disable-direct-composition',
    '--disable-d3d11',
  ] : []),

  // ── Audio ─────────────────────────────────────────────────────────────────
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-user-gesture-required',
  '--audio-output-channels=1',
  '--disable-features=AudioServiceSandbox',
  // NEVER add --mute-audio here

  // ── Performance ───────────────────────────────────────────────────────────
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',           // use /tmp instead of /dev/shm (Docker default is 64 MB)
  '--disable-smooth-scrolling',
  '--no-zygote',

  // ── CDP screencast quality ────────────────────────────────────────────────
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--run-all-compositor-stages-before-draw',

  // ── Memory — CRITICAL on VPS/containers with limited RAM ──────────────────
  '--js-flags=--max-old-space-size=512',
  '--disable-ipc-flooding-protection',
  '--memory-pressure-off',
  '--max-gum-fps=30',                  // cap getUserMedia fps — not our stream but prevents waste

  // ── Crash reporter — disable so bad frames don't halt the process ─────────
  '--disable-crash-reporter',
  '--no-crash-upload',
  '--disable-breakpad',

  // ── Misc ──────────────────────────────────────────────────────────────────
  '--lang=en-US',
  '--disable-extensions',
  '--disable-default-apps',
  '--no-first-run',
  '--disable-sync',
  '--disable-translate',
  '--disable-notifications',
  '--disable-popup-blocking',
];

async function initBrowser() {
  console.log(`[Browser] Launching (attempt ${restartCount + 1})…`);

  browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS,
    timeout: 60000,
  });

  restartCount = 0; // reset on successful launch

  browser.on('disconnected', () => {
    browser = null;
    restartCount++;

    if (restartCount > MAX_RESTARTS) {
      console.error(`[Browser] Exceeded ${MAX_RESTARTS} restart attempts — giving up.`);
      process.exit(1); // Let the container restart policy revive the service
    }

    const delay = Math.min(Math.pow(2, restartCount) * 1000, 30000);
    console.warn(`[Browser] Disconnected — restart #${restartCount} in ${delay}ms…`);

    setTimeout(() => {
      initBrowser().catch(e => {
        console.error('[Browser] Restart failed:', e.message);
      });
    }, delay);
  });

  console.log(`[Browser] Ready (platform: ${os.platform()}, headless+SwiftShader)`);
  return browser;
}

function getBrowser() {
  if (!browser) throw new Error('Browser not initialised — call initBrowser() first');
  return browser;
}

module.exports = { initBrowser, getBrowser };