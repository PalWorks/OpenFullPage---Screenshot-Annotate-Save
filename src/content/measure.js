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
