/**
 * inputHandler.js
 */

// Serialise all input events through a per-page queue so rapid char-by-char
// typing never interleaves or races with itself.
const pageQueues = new WeakMap(); // page → Promise chain

function enqueue(page, fn) {
  const prev = pageQueues.get(page) || Promise.resolve();
  const next = prev.then(fn).catch(err => {
    if (!err.message?.includes('Target closed') && !err.message?.includes('navigating')) {
      console.error('[InputQueue]', err.message);
    }
  });
  pageQueues.set(page, next);
  return next;
}

async function handleInput(page, data) {
  enqueue(page, () => dispatch(page, data));
}

async function dispatch(page, data) {
  switch (data.type) {
    case 'click': return handleClick(page, data);
    case 'scroll': return handleScroll(page, data);
    case 'type': return handleType(page, data);
    case 'keypress': return page.keyboard.press(mapKey(data.key));
    case 'keydown': return page.keyboard.down(mapKey(data.key));
    case 'keyup': return page.keyboard.up(mapKey(data.key));
  }
}

// ── Click ────────────────────────────────────────────────────────────────────

async function handleClick(page, data) {
  const x = Math.round(data.x);
  const y = Math.round(data.y);

  // touchscreen.tap fires the full touch event sequence mobile sites expect
  await page.touchscreen.tap(x, y);

  // Force-focus the nearest editable element at the tap point.
  // This is the step that makes Instagram / React inputs actually receive keys.
  await page.evaluate(({ px, py }) => {
    const hit = document.elementFromPoint(px, py);
    if (!hit) return;

    let el = hit;
    while (el && el !== document.body) {
      const tag = el.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
        el.focus();
        if (el.isContentEditable) {
          // Place cursor at end for contentEditable (Instagram comment/DM box)
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return;
      }
      el = el.parentElement;
    }
    hit.focus?.();
  }, { px: x, py: y });

  await sleep(80); // let focus + React state settle
}

// ── Type ─────────────────────────────────────────────────────────────────────

async function handleType(page, data) {
  const text = data.text || '';
  if (!text) return;

  // NO delay — the queue above serialises calls so there is no race.
  // page.keyboard.type fires keydown+keypress+input+keyup per character,
  // which is exactly what React controlled inputs need.
  await page.keyboard.type(text, { delay: 0 });
}

// ── Scroll ───────────────────────────────────────────────────────────────────

async function handleScroll(page, data) {
  const x = Math.round(data.x);
  const y = Math.round(data.y);
  const dy = Math.round(data.deltaY ?? 0);
  const dx = Math.round(data.deltaX ?? 0);

  // Strategy:
  // 1. Try a synthetic touch-swipe sequence — this is what Instagram/TikTok
  //    virtual scrollers actually respond to.
  // 2. Also call scrollBy on the scrollable ancestor as a fallback for
  //    standard web pages (Google, LinkedIn, etc.)

  await page.evaluate(({ px, py, deltax, deltay }) => {
    // ── Find scrollable ancestor ──────────────────────────────────────────
    function getScrollable(el) {
      while (el && el !== document.documentElement) {
        const s = window.getComputedStyle(el);
        const ov = s.overflow + s.overflowY;
        if (/auto|scroll/.test(ov) && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }
      return document.documentElement;
    }

    const target = document.elementFromPoint(px, py) || document.body;
    const scrollable = getScrollable(target);

    // ── Touch swipe (Instagram, TikTok, Reels) ────────────────────────────
    // Simulate finger moving from (px, py) upward by deltay pixels.
    // A positive deltay means "scroll down" so the finger moves UP.
    const startY = py;
    const endY = py - deltay;   // finger end position (opposite of scroll dir)
    const steps = 6;
    const stepDelay = 8;           // ms between touch moves

    function fireTouch(type, cx, cy, el) {
      const touch = new Touch({
        identifier: Date.now(),
        target: el,
        clientX: cx, clientY: cy,
        screenX: cx, screenY: cy,
        pageX: cx + window.scrollX,
        pageY: cy + window.scrollY,
        radiusX: 10, radiusY: 10,
        force: 0.5,
      });
      el.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [touch],
        targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch],
      }));
    }

    fireTouch('touchstart', px, startY, target);

    // Dispatch touchmove steps with tiny timeouts (best-effort in evaluate)
    let step = 0;
    function nextMove() {
      if (step >= steps) {
        fireTouch('touchend', px, endY, target);
        return;
      }
      const t = (step + 1) / steps;
      const curY = startY + (endY - startY) * t;
      fireTouch('touchmove', px, curY, target);
      step++;
      setTimeout(nextMove, stepDelay);
    }
    nextMove();

    // ── Also scrollBy as fallback for non-touch-scroll containers ─────────
    if (scrollable === document.documentElement) {
      window.scrollBy({ left: deltax, top: deltay, behavior: 'auto' });
    } else {
      scrollable.scrollBy({ left: deltax, top: deltay, behavior: 'auto' });
    }

  }, { px: x, py: y, deltax: dx, deltay: dy });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mapKey(key) {
  if (!key) return '';
  const map = {
    'Enter': 'Enter', 'enter': 'Enter',
    'Backspace': 'Backspace', 'backspace': 'Backspace',
    'Delete': 'Delete', 'Escape': 'Escape',
    'Tab': 'Tab',
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'PageUp': 'PageUp', 'PageDown': 'PageDown',
    'Home': 'Home', 'End': 'End',
    ' ': 'Space', 'Space': 'Space',
    'Shift': 'Shift', 'Control': 'Control',
    'Alt': 'Alt', 'Meta': 'Meta',
  };
  return map[key] || key;
}

module.exports = { handleInput };