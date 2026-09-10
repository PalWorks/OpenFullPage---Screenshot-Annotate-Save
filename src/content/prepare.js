// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// Page preparation and scrolling, injected by chrome.scripting.executeScript.
// Same rule as measure.js: every exported function must be self-contained.
//
// Nothing here injects a <script> element into the page. Element marking is
// done with data attributes and the visual change is done entirely by
// chrome.scripting.insertCSS (SECURITY-AUDIT finding 7).

/** CSS inserted for the whole capture. Sticky elements return to normal flow so
 *  they appear once, at their real position, instead of riding down every tile. */
export const PREPARE_CSS = `
  html, body, * { scroll-behavior: auto !important; }
  *, *::before, *::after {
    animation-play-state: paused !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  [data-fpc-sticky] { position: static !important; }
`;

/** Inserted only after the first tile: keeps the header in the screenshot once,
 *  then stops it repeating down the page. */
export const HIDE_FIXED_CSS = `
  [data-fpc-fixed] { visibility: hidden !important; }
`;

/**
 * Tag every fixed and sticky element so the stylesheets above can reach them.
 * Runs before measuring, because unsticking changes the page's height.
 * @returns {{fixed:number, sticky:number}}
 */
export function markSpecialElements() {
  let fixed = 0;
  let sticky = 0;

  for (const el of document.querySelectorAll('*')) {
    const position = getComputedStyle(el).position;
    if (position === 'fixed') {
      el.setAttribute('data-fpc-fixed', '');
      fixed += 1;
    } else if (position === 'sticky') {
      el.setAttribute('data-fpc-sticky', '');
      sticky += 1;
    }
  }

  return { fixed, sticky };
}

/**
 * Pause anything that is playing, and remember only what we paused.
 *
 * A full page walk takes seconds, sometimes tens of them. A video playing
 * through it is photographed at a different frame in every screenful it spans,
 * so a player that straddles a seam shows two moments of the same video with a
 * hard line between them. Audio is the other half: the capture manipulates the
 * page under a reader who is listening to it, and leaving it playing while the
 * page scrolls itself is worse than pausing for a moment.
 *
 * `data-fpc-playing`, not a list held in this function, because the mark has to
 * survive the round trip: this runs in the page through executeScript and the
 * worker gets back a number, not a reference to a video element.
 *
 * Only what was playing is marked, so a video the reader had already paused is
 * still paused when they get their tab back.
 *
 * @returns {number} how many were paused
 */
export function pauseMedia() {
  let paused = 0;
  for (const el of document.querySelectorAll('video, audio')) {
    if (el.paused) continue;
    el.setAttribute('data-fpc-playing', '');
    el.pause();
    paused += 1;
  }
  return paused;
}

/**
 * Start again exactly what `pauseMedia` stopped.
 *
 * `play()` returns a promise that rejects when the browser declines, which it
 * does when the element needs a user gesture it no longer has. There is nothing
 * useful to do about that and it must not become an unhandled rejection inside
 * somebody else's page, so it is swallowed deliberately: the reader is left
 * looking at a paused video, which is the state their own browser chose.
 */
export function resumeMedia() {
  for (const el of document.querySelectorAll('[data-fpc-playing]')) {
    el.removeAttribute('data-fpc-playing');
    const resumed = el.play();
    if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
  }
}

/**
 * Scroll to a tile position, wait for what that reveals to actually load, and
 * report where the page landed and how tall it now is.
 *
 * This is the whole lazy-loading strategy, and it is deliberately one pass. The
 * obvious alternative: race down the page to trigger every lazy image, come
 * back to the top, then photograph it: scrolls the user's page twice and still
 * loses a race on anything slower than the warm-up budget. Waiting here instead
 * costs nothing on pages with no lazy content (the loop exits immediately) and
 * is correct on pages that have it, because the wait is for the images actually
 * in shot rather than for a fixed timer.
 *
 * The returned height is what lets the caller notice a page that grew while it
 * was being walked, which is normal on feeds and live blogs.
 */
export async function scrollAndSettle(x, y, budgetMs) {
  window.scrollTo(x, y);

  const startedAt = Date.now();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // requestAnimationFrame does not fire in a tab that is not being painted, so a
  // bare await on it hangs forever the moment the user switches tabs or another
  // window covers this one. Racing it against a timer keeps the capture moving:
  // the frame is the fast path, the timer is the guarantee.
  const nextFrame = () =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 60);
    });

  // Lazy loaders react either to the scroll event or to an IntersectionObserver
  // callback, and both need a rendered frame before they run at all.
  await nextFrame();

  // Images in shot, plus one viewport of lookahead so the next stop has a head
  // start. Anything further away is not this tile's problem.
  const stillLoading = () => {
    const vh = document.documentElement.clientHeight;
    const vw = document.documentElement.clientWidth;
    let waiting = 0;

    for (const img of document.images) {
      if (img.complete) continue;
      const box = img.getBoundingClientRect();
      if (box.bottom < 0 || box.top > vh * 2) continue;
      if (box.right < 0 || box.left > vw) continue;
      waiting += 1;
    }

    return waiting;
  };

  while (Date.now() - startedAt < budgetMs && stillLoading() > 0) {
    await pause(40);
  }

  // One more frame so a just-decoded image is painted before it is photographed.
  await nextFrame();

  return {
    x: window.scrollX,
    y: window.scrollY,
    waited: Date.now() - startedAt,
    fullHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    ),
  };
}

/**
 * Wait until the document stops changing height, or give up.
 *
 * Preparation moves the page around: sticky headers rejoin the flow, frames are
 * expanded, and cross-origin frames only report their height over an
 * asynchronous postMessage round trip. Measuring before that settles plans the
 * walk against a page that no longer exists, and the walk then photographs
 * content that shifts underneath it.
 *
 * Polling for a stable height rather than sleeping a fixed amount is what makes
 * this both correct and cheap: a page that was never going to move exits in
 * under 200ms, and a page still settling gets as long as it needs up to the
 * budget.
 */
export async function waitForStableHeight(budgetMs) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const measure = () =>
    Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0,
    );

  const startedAt = Date.now();
  let height = measure();
  let unchanged = 0;

  while (Date.now() - startedAt < budgetMs) {
    await pause(60);
    const now = measure();
    if (now === height) {
      unchanged += 1;
      if (unchanged >= 3) break;
    } else {
      unchanged = 0;
      height = now;
    }
  }

  return { height, waited: Date.now() - startedAt };
}

/**
 * Lay same-origin iframes out at their full height, so their content is on the
 * page rather than behind their own scrollbar.
 *
 * This only works same-origin: reaching a cross-origin frame's contentDocument
 * throws, and there is no way to learn its height from the parent. Scrolling
 * those would mean injecting into each frame, which needs webNavigation and
 * <all_urls>: permanent access to every site the user visits. That trade is
 * refused; see docs/ROADMAP.md.
 *
 * @returns {{sameOrigin:number, crossOrigin:number, expanded:number}}
 */
export function expandSameOriginFrames(maxHeight) {
  const report = { sameOrigin: 0, crossOrigin: 0, expanded: 0 };

  for (const frame of document.querySelectorAll('iframe')) {
    let doc = null;
    try {
      doc = frame.contentDocument;
    } catch {
      doc = null;
    }
    if (!doc) {
      report.crossOrigin += 1;
      continue;
    }
    report.sameOrigin += 1;

    const content = Math.max(
      doc.documentElement ? doc.documentElement.scrollHeight : 0,
      doc.body ? doc.body.scrollHeight : 0,
    );
    // Growing past the canvas limit only makes the capture slower before it is
    // truncated anyway.
    if (content <= frame.clientHeight + 4 || content > maxHeight) continue;

    frame.setAttribute('data-fpc-frame', frame.style.height || '');
    frame.style.height = `${content}px`;
    report.expanded += 1;
  }

  return report;
}

/**
 * Expand frames of *any* origin, by cooperation rather than inspection.
 *
 * A parent cannot read a cross-origin frame's height, but it can compare
 * `event.source` against `iframe.contentWindow`: identity comparison is allowed
 * across origins even though property access is not. So every frame reports its
 * own content height upward, and each parent matches the reporter to the element
 * that holds it.
 *
 * Injected into every frame at once, so nesting works: a frame is both a
 * reporter to its parent and a listener for its own children.
 *
 * Requires <all_urls>, which is opt-in. See docs/ADVANCED-ACCESS.md.
 */
export function reportFrameHeights(maxHeight) {
  if (window.__fpcFrameListener) {
    window.removeEventListener('message', window.__fpcFrameListener);
  }

  window.__fpcFrameListener = (event) => {
    const height = event.data && event.data.__fpcFrameHeight;
    if (!Number.isFinite(height) || height <= 0 || height > maxHeight) return;

    for (const frame of document.querySelectorAll('iframe')) {
      if (frame.contentWindow !== event.source) continue;
      if (height <= frame.clientHeight + 4) return;
      if (!frame.hasAttribute('data-fpc-frame')) {
        frame.setAttribute('data-fpc-frame', frame.style.height || '');
      }
      frame.style.height = `${height}px`;
      return;
    }
  };

  window.addEventListener('message', window.__fpcFrameListener);

  if (window === window.top) return { role: 'listener' };

  const content = Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0,
  );
  window.parent.postMessage({ __fpcFrameHeight: content }, '*');
  return { role: 'reporter', content };
}

/** Take the message listener back out of every frame it was installed in. */
export function stopFrameReporting() {
  if (!window.__fpcFrameListener) return;
  window.removeEventListener('message', window.__fpcFrameListener);
  delete window.__fpcFrameListener;
}

/** Undo marking and put the viewport back where the user left it. */
export function restorePage(x, y) {
  for (const el of document.querySelectorAll('[data-fpc-fixed], [data-fpc-sticky]')) {
    el.removeAttribute('data-fpc-fixed');
    el.removeAttribute('data-fpc-sticky');
  }
  for (const frame of document.querySelectorAll('[data-fpc-frame]')) {
    frame.style.height = frame.getAttribute('data-fpc-frame');
    frame.removeAttribute('data-fpc-frame');
  }
  window.scrollTo(x, y);
}
