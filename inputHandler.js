/**
 * Input Handler
 * Translates WebSocket input events into Playwright page actions.
 */

async function handleClick(page, data) {
  await page.mouse.click(data.x, data.y, {
    button: data.button === "right" ? "right" : "left",
  });
}

async function handleType(page, data) {
  await page.keyboard.type(data.text);
}

async function handleKeyDown(page, data) {
  await page.keyboard.down(data.key);
}

async function handleKeyUp(page, data) {
  await page.keyboard.up(data.key);
}

async function handleKeyPress(page, data) {
  await page.keyboard.press(data.key);
}

async function handleMouseMove(page, data) {
  await page.mouse.move(data.x, data.y);
}

async function handleKey(page, data) {
  const k = data.key.toLowerCase();
  const mapped =
    k === "backspace" ? "Backspace" : k === "enter" ? "Enter" : data.key;
  try {
    await page.keyboard.press(mapped);
  } catch {}
}

/**
 * Three-layer scroll strategy:
 *
 * Layer 1 — page.mouse.move + page.mouse.wheel
 *   Moves the mouse to the target coordinates first (critical — wheel fires at
 *   the last mouse position, which is (0,0) if the mouse was never moved).
 *   Works for standard overflow containers.
 *
 * Layer 2 — WheelEvent dispatch via page.evaluate
 *   Dispatches a native WheelEvent on the element under the pointer.
 *   Catches React/Vue synthetic scroll handlers used by Instagram, TikTok, etc.
 *
 * Layer 3 — scrollBy on the nearest scrollable ancestor
 *   Walks up the DOM from the target element and calls .scrollBy() on the first
 *   ancestor with overflow:auto/scroll/overlay and scrollable content.
 *   Most reliable catch-all for custom scroll containers.
 */
async function handleScroll(page, data) {
  const dx = data.deltaX || 0;
  const dy = data.deltaY || 0;
  // Use provided coordinates or default to viewport centre
  const x = typeof data.x === "number" ? data.x : 195;
  const y = typeof data.y === "number" ? data.y : 422;

  // Layer 1: position mouse then fire CDP wheel
  await page.mouse.move(x, y);
  await page.mouse.wheel(dx, dy);

  // Layers 2 & 3: JS-level scroll
  await page.evaluate(
    ({ x, y, dx, dy }) => {
      // Layer 2: synthetic WheelEvent (React/Vue handlers)
      const target = document.elementFromPoint(x, y);
      if (target) {
        target.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: dx,
            deltaY: dy,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          }),
        );
      }

      // Layer 3: direct .scrollBy on nearest scrollable ancestor
      function findScrollable(el) {
        if (!el || el === document.body || el === document.documentElement)
          return null;
        const { overflowY } = window.getComputedStyle(el);
        if (
          (overflowY === "auto" ||
            overflowY === "scroll" ||
            overflowY === "overlay") &&
          el.scrollHeight > el.clientHeight
        )
          return el;
        return findScrollable(el.parentElement);
      }

      const scrollable = target ? findScrollable(target) : null;
      if (scrollable) {
        scrollable.scrollBy({ top: dy, left: dx, behavior: "auto" });
      } else {
        window.scrollBy({ top: dy, left: dx, behavior: "auto" });
      }
    },
    { x, y, dx, dy },
  );
}

async function handleInput(page, data) {
  try {
    // Normalise key names
    if (data.key) {
      const lk = data.key.toLowerCase();
      if (lk === "backspace") data.key = "Backspace";
      else if (lk === "enter") data.key = "Enter";
    }

    switch (data.type) {
      case "click":
        await handleClick(page, data);
        break;
      case "type":
        await handleType(page, data);
        break;
      case "key":
        await handleKey(page, data);
        break;
      case "keydown":
        await handleKeyDown(page, data);
        break;
      case "keyup":
        await handleKeyUp(page, data);
        break;
      case "keypress":
        await handleKeyPress(page, data);
        break;
      case "scroll":
        await handleScroll(page, data);
        break;
      case "mousemove":
        await handleMouseMove(page, data);
        break;
      default:
        console.warn("[Input] Unknown type:", data.type);
    }
  } catch (err) {
    console.error(`[Input] Error (${data.type}):`, err.message);
  }
}

module.exports = { handleInput };
