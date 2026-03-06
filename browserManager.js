const { chromium } = require('playwright');

let browser;

async function initBrowser() {
  browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-dev-shm-usage', // Extremely important to prevent out-of-memory crashes when multiple users connect
      '--disable-gpu',           // Helps reduce memory consumption for headless loads
      '--no-zygote',
      '--disable-smooth-scrolling', // Add this to stop Chrome from rendering 30 transitional frames per scroll, which heavily clogs WebSockets and causes severe interaction latency.
      '--lang=en-US'        // Force browser UI language to English
    ]
  });

  // Re-initialize if the browser itself crashes
  browser.on('disconnected', () => {
    console.warn("Browser disconnected! Attempting to restart...");
    initBrowser().catch(e => console.error("Failed to restart browser:", e));
  });

  console.log("Browser started successfully");
}

function getBrowser() {
  return browser;
}

module.exports = { initBrowser, getBrowser };
