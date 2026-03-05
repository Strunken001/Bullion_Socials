/**
 * Stream Manager - Uses CDP Page.startScreencast for efficient frame capture.
 * Chrome pushes frames only when content changes, much more efficient than polling screenshots.
 */

/**
 * Start CDP screencast for a Playwright page.
 * @param {import('playwright').Page} page
 * @param {(frameData: Buffer, metadata: object) => void} onFrame
 * @param {object} options - maxWidth, maxHeight, quality overrides
 * @returns {Promise<import('playwright').CDPSession>}
 */
async function startScreencast(page, onFrame, options = {}) {
  const cdpSession = await page.context().newCDPSession(page);

  cdpSession.on("Page.screencastFrame", (params) => {
    // Fire-and-forget ack — don't await so we don't block the frame callback
    cdpSession
      .send("Page.screencastFrameAck", { sessionId: params.sessionId })
      .catch(() => { });

    try {
      onFrame(Buffer.from(params.data, "base64"), params.metadata);
    } catch (err) {
      if (
        !err.message.includes("Target closed") &&
        !err.message.includes("Session closed")
      ) {
        console.error("[Screencast] Frame error:", err.message);
      }
    }
  });

  const screencastOptions = {
    format: "jpeg",
    quality: options.quality ?? 85,
    everyNthFrame: options.everyNthFrame ?? 1,
    maxWidth: options.maxWidth ?? 2048,
    maxHeight: options.maxHeight ?? 4096,
  };

  await cdpSession.send("Page.startScreencast", screencastOptions);
  console.log("[Screencast] Started:", screencastOptions);

  return cdpSession;
}

/**
 * Stop CDP screencast.
 * @param {import('playwright').CDPSession} cdpSession
 */
async function stopScreencast(cdpSession) {
  try {
    await cdpSession.send("Page.stopScreencast");
    await cdpSession.detach();
    console.log("[Screencast] Stopped");
  } catch (err) {
    console.warn("[Screencast] Stop warning:", err.message);
  }
}

module.exports = { startScreencast, stopScreencast };
