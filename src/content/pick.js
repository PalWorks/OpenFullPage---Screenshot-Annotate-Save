// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The element picker, injected by chrome.scripting.executeScript. Same rule as
// the other injected functions: entirely self-contained, because it is
// serialised with toString() and evaluated in the page.

/**
 * Let the user point at part of the page and return its box in document
 * coordinates. Resolves with null if they press Escape or right-click.
 *
 * The highlight is a single absolutely-positioned element rather than an
 * outline on the page's own nodes: touching the page's styles would change the
 * very layout we are about to photograph.
 */
export function pickElement(budgetMs = 0) {
  return new Promise((resolve) => {
    const highlight = document.createElement('div');
    highlight.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'border:2px solid #6366f1',
      'background:rgba(99,102,241,0.14)',
      'box-shadow:0 0 0 9999px rgba(0,0,0,0.28)',
      'transition:none',
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'padding:3px 7px',
      'border-radius:4px',
      'background:#18181b',
      'color:#fff',
      'font:600 11px/1.4 system-ui,sans-serif',
      'white-space:nowrap',
    ].join(';');

    document.documentElement.append(highlight, label);

    let current = null;

    const paint = (element) => {
      current = element;
      const box = element.getBoundingClientRect();
      highlight.style.left = `${box.left}px`;
      highlight.style.top = `${box.top}px`;
      highlight.style.width = `${box.width}px`;
      highlight.style.height = `${box.height}px`;

      const name =
        element.tagName.toLowerCase() +
        (element.id ? `#${element.id}` : '') +
        `  ${Math.round(box.width)} x ${Math.round(box.height)}`;
      label.textContent = name;
      label.style.left = `${Math.max(4, box.left)}px`;
      label.style.top = `${box.top > 24 ? box.top - 22 : box.bottom + 6}px`;
    };

    const onMove = (event) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (element && element !== highlight && element !== label) paint(element);
    };

    const finish = (result) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onCancel, true);
      highlight.remove();
      label.remove();
      resolve(result);
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!current) return finish(null);

      const box = current.getBoundingClientRect();
      // Document coordinates: the capture scrolls the page, so a viewport-
      // relative box would point at the wrong thing by the time it is used.
      finish({
        x: box.left + window.scrollX,
        y: box.top + window.scrollY,
        w: box.width,
        h: box.height,
      });
    };

    const onCancel = (event) => {
      // Called with nothing when the budget runs out, so the guard is not
      // defensive dressing: it is the timeout path.
      if (event) event.preventDefault();
      finish(null);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') onCancel(event);
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onCancel, true);
    // Its own deadline, shorter than the caller's. Being abandoned mid-promise
    // would leave these four listeners swallowing every click on the page.
    if (budgetMs > 0) setTimeout(() => onCancel(null), budgetMs);
  });
}

/**
 * Let the reader take things out of the shot before it is taken.
 *
 * Shares its chrome with `pickElement` above but differs in the one way that
 * matters: it does not resolve on the first click. Cookie bars travel in packs,
 * and a picker that closed after one would mean running the capture four times.
 *
 * Nothing is deleted. Each pick gets an attribute, and a stylesheet the caller
 * inserts is what actually hides it, so `restorePage()` puts the page back by
 * removing the attribute. A capture that throws halfway still leaves the
 * reader's own page exactly as it was found.
 *
 * Self-contained, like every other injected function here: it is serialised
 * with toString() and evaluated in the page, so it can close over nothing.
 *
 * @returns {Promise<number|null>} how many were hidden, or null if cancelled
 */
export function pickForRemoval(budgetMs = 0) {
  return new Promise((resolve) => {
    const chrome_ = [];
    const make = (css) => {
      const el = document.createElement('div');
      el.style.cssText = css;
      chrome_.push(el);
      document.documentElement.append(el);
      return el;
    };

    const highlight = make([
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'border:2px solid #dc2626',
      'background:rgba(220,38,38,0.14)',
      'transition:none',
    ].join(';'));

    const label = make([
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'padding:3px 7px',
      'border-radius:4px',
      'background:#18181b',
      'color:#fff',
      'font:600 11px/1.4 system-ui,sans-serif',
      'white-space:nowrap',
    ].join(';'));

    // What the keys do, on screen, for as long as the picker is up. Without it
    // the reader is left clicking things and guessing how to finish.
    const bar = make([
      'position:fixed',
      'left:50%',
      'bottom:18px',
      'transform:translateX(-50%)',
      'pointer-events:none',
      'z-index:2147483647',
      'padding:8px 14px',
      'border-radius:8px',
      'background:#18181b',
      'color:#fff',
      'font:600 12px/1.5 system-ui,sans-serif',
      'white-space:nowrap',
      'box-shadow:0 6px 22px rgba(0,0,0,0.35)',
    ].join(';'));

    let current = null;
    let hidden = 0;
    const undoStack = [];

    const say = () => {
      const count = hidden === 0 ? 'Nothing hidden yet' : `${hidden} hidden`;
      bar.textContent =
        `${count}  ·  Click to hide  ·  Z to put the last one back  ·  Enter to capture  ·  Esc to cancel`;
    };

    const paint = (element) => {
      current = element;
      const box = element.getBoundingClientRect();
      highlight.style.left = `${box.left}px`;
      highlight.style.top = `${box.top}px`;
      highlight.style.width = `${box.width}px`;
      highlight.style.height = `${box.height}px`;
      label.textContent =
        element.tagName.toLowerCase() +
        (element.id ? `#${element.id}` : '') +
        `  ${Math.round(box.width)} x ${Math.round(box.height)}`;
      label.style.left = `${Math.max(4, box.left)}px`;
      label.style.top = `${box.top > 24 ? box.top - 22 : box.bottom + 6}px`;
    };

    const onMove = (event) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (element && !chrome_.includes(element)) paint(element);
    };

    const finish = (result) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onCancel, true);
      for (const el of chrome_) el.remove();
      resolve(result);
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!current) return;
      // The page itself is not an element you can take out of the page.
      if (current === document.body || current === document.documentElement) return;
      current.setAttribute('data-fpc-hidden', '');
      undoStack.push(current);
      hidden += 1;
      current = null;
      highlight.style.width = '0px';
      highlight.style.height = '0px';
      label.textContent = '';
      say();
    };

    const onCancel = (event) => {
      if (event) event.preventDefault();
      // Cancelling puts everything back before it resolves, so the caller does
      // not have to know whether anything was hidden.
      for (const el of undoStack) el.removeAttribute('data-fpc-hidden');
      finish(null);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') return onCancel(event);
      if (event.key === 'Enter') {
        event.preventDefault();
        return finish(hidden);
      }
      if (event.key === 'z' || event.key === 'Z') {
        event.preventDefault();
        const last = undoStack.pop();
        if (last) {
          last.removeAttribute('data-fpc-hidden');
          hidden -= 1;
          say();
        }
      }
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onCancel, true);
    // As above: give up before the caller does, putting back anything hidden,
    // rather than being left running with the page's clicks still captured.
    if (budgetMs > 0) setTimeout(() => onCancel(null), budgetMs);
    say();
  });
}
