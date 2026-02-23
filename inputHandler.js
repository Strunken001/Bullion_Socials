/**
 * Input Handler - Processes input events from the client and applies them to the Playwright page.
 */

/**
 * Handle a click event.
 * @param {import('playwright').Page} page
 * @param {{ x: number, y: number, button?: string }} data
 */
async function handleClick(page, data) {
  const button = data.button === 'right' ? 'right' : 'left';
  await page.mouse.click(data.x, data.y, { button });
}

/**
 * Handle typing a string of text.
 * @param {import('playwright').Page} page
 * @param {{ text: string }} data
 */
async function handleType(page, data) {
  await page.keyboard.type(data.text);
}

/**
 * Handle a key down event.
 * @param {import('playwright').Page} page
 * @param {{ key: string }} data
 */
async function handleKeyDown(page, data) {
  await page.keyboard.down(data.key);
}

/**
 * Handle a key up event.
 * @param {import('playwright').Page} page
 * @param {{ key: string }} data
 */
async function handleKeyUp(page, data) {
  await page.keyboard.up(data.key);
}

/**
 * Handle a key press (down + up).
 * @param {import('playwright').Page} page
 * @param {{ key: string }} data
 */
async function handleKeyPress(page, data) {
  await page.keyboard.press(data.key);
}

/**
 * Handle mouse scroll.
 * @param {import('playwright').Page} page
 * @param {{ deltaX?: number, deltaY: number }} data
 */
async function handleScroll(page, data) {
  await page.mouse.wheel(data.deltaX || 0, data.deltaY);
}

/**
 * Handle mouse move.
 * @param {import('playwright').Page} page
 * @param {{ x: number, y: number }} data
 */
async function handleMouseMove(page, data) {
  await page.mouse.move(data.x, data.y);
}

/**
 * Handle a specific key action like Enter or Backspace.
 * @param {import('playwright').Page} page
 * @param {{ key: string }} data
 */
async function handleKey(page, data) {
  if (data.key === 'backspace') {
    await page.keyboard.press('Backspace');
  } else if (data.key === 'enter') {
    await page.keyboard.press('Enter');
  } else {
    // Attempt to press the key directly if it's something else
    try {
      await page.keyboard.press(data.key);
    } catch(e) {}
  }
}

/**
 * Route an input event to the appropriate handler.
 * @param {import('playwright').Page} page
 * @param {object} data - The parsed input event
 */
async function handleInput(page, data) {
  console.log('Input received:', data);
  
  try {
    // Normalize casing for backspace and enter so mobile apps sending 'backspace' work perfectly
    if (data.key) {
      const lowerKey = data.key.toLowerCase();
      if (lowerKey === 'backspace') data.key = 'Backspace';
      else if (lowerKey === 'enter') data.key = 'Enter';
    }

    switch (data.type) {
      case 'click':
        await handleClick(page, data);
        break;
      case 'type':
        await handleType(page, data);
        break;
      case 'key':
        await handleKey(page, data);
        break;
      case 'keydown':
        await handleKeyDown(page, data);
        break;
      case 'keyup':
        await handleKeyUp(page, data);
        break;
      case 'keypress':
        await handleKeyPress(page, data);
        break;
      case 'scroll':
        await handleScroll(page, data);
        break;
      case 'mousemove':
        await handleMouseMove(page, data);
        break;
      default:
        console.warn('Unknown input type:', data.type);
    }
  } catch (err) {
    console.error(`Input handler error (${data.type}):`, err.message);
  }
}

module.exports = { handleInput };
