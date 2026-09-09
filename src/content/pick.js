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
export function pickElement() {
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
      event.preventDefault();
      finish(null);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') onCancel(event);
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onCancel, true);
  });
}
