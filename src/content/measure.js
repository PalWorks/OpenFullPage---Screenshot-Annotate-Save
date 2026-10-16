// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// Functions injected into the page by chrome.scripting.executeScript.
//
// IMPORTANT: each exported function is serialised with Function.prototype
// toString() and evaluated in the page's isolated world. It therefore cannot
// reference anything outside its own body, no imports, no module constants.
// They are kept in a module purely so the background worker can name them.

/**
 * Page geometry in CSS pixels.
 *
 * Widths come from documentElement.clientWidth (which excludes a classic
 * scrollbar) while the captured bitmap spans window.innerWidth (which includes
 * it). Every tile is cropped to the client box on the way onto the canvas, so
 * the scrollbar never reaches the output.
 */
export function measurePage() {
  const doc = document.documentElement;
  const body = document.body;
  const widest = (prop) => Math.max(doc[prop] || 0, body ? body[prop] || 0 : 0);

  // A page whose content scrolls inside a box, marked by findScroller(). The
  // window never moves on such a page, so the walk is planned in the box's own
  // terms: its visible area is the screenful, its content is the page, and
  // clipX and clipY say where on screen the screenful is to be cut from.
  const scroller = document.querySelector('[data-fpc-scroller]');
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    // In a reversed column the scroll offset runs from minus the range up to
    // zero, with zero at the bottom. Offsets reported here are always measured
    // from the top of the content, whichever way the box counts.
    const reversed = scroller.getAttribute('data-fpc-scroller') === 'reverse';
    const least = reversed ? -(scroller.scrollHeight - scroller.clientHeight) : 0;
    return {
      fullWidth: scroller.clientWidth,
      fullHeight: scroller.scrollHeight,
      viewportWidth: scroller.clientWidth,
      viewportHeight: scroller.clientHeight,
      clipX: box.left + scroller.clientLeft,
      clipY: box.top + scroller.clientTop,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: 0,
      scrollY: scroller.scrollTop - least,
      title: document.title,
      url: location.href,
    };
  }

  return {
    fullWidth: Math.max(widest('scrollWidth'), widest('offsetWidth'), doc.clientWidth),
    fullHeight: Math.max(widest('scrollHeight'), widest('offsetHeight'), doc.clientHeight),
    viewportWidth: doc.clientWidth,
    viewportHeight: doc.clientHeight,
    // The captured bitmap spans innerWidth, so this is what the stitcher
    // divides by to recover the exact CSS-pixel -> captured-pixel scale.
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    // Chrome folds browser zoom into devicePixelRatio, so this single number is
    // the full CSS-pixel -> captured-pixel scale.
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    title: document.title,
    // Read here rather than from tab.url, which is undefined without host
    // permissions. The download filename is built from it.
    url: location.href,
  };
}

/**
 * Find the box a page actually scrolls in, when the page itself does not.
 *
 * Chat applications and many other web apps are exactly one window tall. The
 * document never scrolls; the conversation scrolls inside a panel beside a
 * sidebar. Measured as a document, such a page is one screenful, and that is
 * all a capture of it ever held.
 *
 * The box chosen is the largest one on screen that scrolls vertically and has
 * more content than it shows. It must be big enough to be the page's main
 * content rather than a sidebar or a menu (at least two fifths of the window's
 * width and half its height), and it must sit wholly inside the window, because
 * the walk photographs it in place and cannot photograph what is off screen.
 *
 * The box is marked with a data attribute, the same way sticky and fixed
 * elements are, so every later step can find it without being told. The mark
 * says which way the box counts: a reversed column, the usual layout for a chat
 * that opens at its newest message, has scroll offsets that run negative. Where
 * the reader had scrolled it to is kept beside the mark, so the box is put back.
 *
 * Called only when the document itself does not scroll, so an ordinary long
 * page never reaches this and behaves exactly as it always has.
 *
 * @returns {{found:boolean, width?:number, height?:number, content?:number, reversed?:boolean}}
 */
export function findScroller() {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const vh = doc.clientHeight;
  let best = null;
  let bestArea = 0;

  for (const el of document.querySelectorAll('body *')) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const style = getComputedStyle(el);
    if (!/^(auto|scroll|overlay)$/.test(style.overflowY)) continue;
    if (style.visibility !== 'visible') continue;
    if (el.clientWidth < vw * 0.4 || el.clientHeight < vh * 0.5) continue;

    const box = el.getBoundingClientRect();
    const left = box.left + el.clientLeft;
    const top = box.top + el.clientTop;
    if (left < -1 || top < -1) continue;
    if (left + el.clientWidth > vw + 1 || top + el.clientHeight > vh + 1) continue;

    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }

  if (!best) return { found: false };

  const style = getComputedStyle(best);
  const reversed = /flex/.test(style.display) && style.flexDirection === 'column-reverse';
  best.setAttribute('data-fpc-scroller', reversed ? 'reverse' : '');
  best.setAttribute('data-fpc-scroller-from', String(best.scrollTop));

  return {
    found: true,
    width: best.clientWidth,
    height: best.clientHeight,
    content: best.scrollHeight,
    reversed,
  };
}

/**
 * Find the frame a page is shown in, when the page itself does not scroll.
 *
 * Some pages are a shell one window tall around a single frame that fills it,
 * and the content scrolls inside the frame's own document. Google serves its
 * forms this way, from a sandbox domain. Measured from outside, such a page is
 * one screenful, the frame is not a box that scrolls, and that is all a capture
 * of it ever held.
 *
 * The frame chosen is the largest one on screen big enough to be the page
 * rather than an embed in it: the same two fifths of the window's width and
 * half its height that findScroller() asks of a box. Whether it can be read
 * from here decides how it is grown, and the site it comes from is what the
 * reader is told about when it cannot be grown at all.
 *
 * Called only when the document does not scroll and no box was found, so an
 * ordinary page with a map or a video embedded in it never reaches this.
 *
 * @returns {{found:boolean, sameOrigin?:boolean, host?:string}}
 */
export function findPageFrame() {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const vh = doc.clientHeight;
  let best = null;
  let bestArea = 0;

  for (const frame of document.querySelectorAll('iframe')) {
    if (getComputedStyle(frame).visibility !== 'visible') continue;
    const box = frame.getBoundingClientRect();
    const width = Math.min(box.right, vw) - Math.max(box.left, 0);
    const height = Math.min(box.bottom, vh) - Math.max(box.top, 0);
    if (width < vw * 0.4 || height < vh * 0.5) continue;

    const area = width * height;
    if (area > bestArea) {
      best = frame;
      bestArea = area;
    }
  }

  if (!best) return { found: false };

  let sameOrigin = false;
  try {
    sameOrigin = Boolean(best.contentDocument);
  } catch {
    sameOrigin = false;
  }
  let host = '';
  try {
    host = new URL(best.src, location.href).host;
  } catch {
    host = '';
  }

  return { found: true, sameOrigin, host };
}
