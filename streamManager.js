/**
 * Stream Manager - Uses CDP Page.startScreencast for efficient frame capture.
 * Chrome pushes frames only when content changes, much more efficient than polling screenshots.
 */

const DEFAULT_OPTIONS = {
  format: 'jpeg',
  quality: 50, // Reduced from 80 for better performance under load
  everyNthFrame: 1
};

/**
 * Start CDP screencast for a Playwright page.
 * Returns the CDP session so it can be stored and used later to stop.
 * @param {import('playwright').Page} page
 * @param {(frameData: Buffer, metadata: object) => void} onFrame - Callback with raw frame buffer
 * @param {object} options - Optional overrides for screencast options (maxWidth, maxHeight, quality)
 * @returns {Promise<import('playwright').CDPSession>}
 */
async function startScreencast(page, onFrame, options = {}) {
  const cdpSession = await page.context().newCDPSession(page);

  cdpSession.on('Page.screencastFrame', async (params) => {
    try {
      // Acknowledge the frame so Chrome sends the next one
      await cdpSession.send('Page.screencastFrameAck', {
        sessionId: params.sessionId
      });

      // Convert base64 frame data to Buffer
      const frameBuffer = Buffer.from(params.data, 'base64');
      console.log(`[CDP] Received frame from Chrome, size: ${frameBuffer.length}`); // optional, could be noisy

      onFrame(frameBuffer, params.metadata);
    } catch (err) {
      // Session may have been closed
      if (!err.message.includes('Target closed') && !err.message.includes('Session closed')) {
        console.error('Screencast frame error:', err.message);
      }
    }
  });

  // Merge defaults with provided options
  // Use high defaults for max dims if not provided to avoid accidental downscaling
  const screencastOptions = {
    ...DEFAULT_OPTIONS,
    maxWidth: options.maxWidth || 2048,
    maxHeight: options.maxHeight || 4096,
    ...options
  };

  await cdpSession.send('Page.startScreencast', screencastOptions);

  console.log('CDP screencast started with options:', screencastOptions);
  
  // Force a repaint to ensure we get an initial frame
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.width = '1px';
    el.style.height = '1px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 100);
  }).catch(() => {});

  return cdpSession;
}

/**
 * Stop CDP screencast.
 * @param {import('playwright').CDPSession} cdpSession
 */
async function stopScreencast(cdpSession) {
  try {
    await cdpSession.send('Page.stopScreencast');
    await cdpSession.detach();
    console.log('CDP screencast stopped');
  } catch (err) {
    // Ignore errors if session is already closed
    console.warn('Screencast stop warning:', err.message);
  }
}

module.exports = { startScreencast, stopScreencast };
