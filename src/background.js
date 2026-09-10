// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// Capture orchestration: measure the page, prepare it, walk it a screenful at a
// time, then hand the finished set of screenfuls to a result tab.
//
// Clicking the toolbar button captures immediately, there is no popup and no
// second button. Progress is reported on the toolbar icon itself.
//
// The result tab is opened only once the capture is finished, so the user is not
// staring at an empty tab while their page scrolls. That means the screenfuls
// are held here until then; the alternative, stitching as they arrive, needs a
// document open from the start, which is what it used to do.
//
// NOTHING HERE MAY WAIT FOREVER
//
// Holding the screenfuls until the end also means a step that never settles
// destroys them. That is not hypothetical: a page whose scripts never go quiet
// (a live feed, an advertising frame that keeps spinning) can leave
// chrome.scripting.executeScript pending indefinitely, and the capture then sits
// at 100% with every screenful in hand and no way to deliver them. So every
// await that crosses into a page, a frame or a new tab is bounded, and a step
// that times out after the walk has begun ends the walk rather than the capture:
// a short image is worth more than none.

import {
  HIDE_FIXED_CSS,
  PREPARE_CSS,
  expandSameOriginFrames,
  markSpecialElements,
  pauseMedia,
  remarkFixed,
  resumeMedia,
  repaintAt,
  reportFrameHeights,
  restorePage,
  scrollAndSettle,
  stopFrameReporting,
  waitForStableHeight,
} from './content/prepare.js';
import { DEEP_FRAMES, loadSettings } from './lib/settings.js';
import { clearProgress, showFailure, showProgress } from './lib/badge.js';
import { sealed, speaksOurProtocol } from './lib/protocol.js';
import { planCapture } from './lib/plan.js';
import { measurePage } from './content/measure.js';
import { pickElement } from './content/pick.js';

// captureVisibleTab is quota-limited to a couple of calls per second. Start
// optimistically and back off only when Chrome actually complains.
const CAPTURE_DELAY_MIN_MS = 180;
const CAPTURE_DELAY_MAX_MS = 1200;
const CAPTURE_RETRIES = 6;

// How many times a screenful that arrived identical to the one before it is
// photographed again. Three, because the repair is cheap and the alternative is
// losing a screenful of the page silently, and because a page that has produced
// no frame after three forced repaints is not going to produce one.
const STALE_RETAKES = 3;

// Spent per tile, and only while something in shot is still loading. Pages
// with no lazy content never wait at all.
const SETTLE_BUDGET_MS = 700;

// A live blog or feed can append content faster than we can photograph it. The
// canvas limits already bound the output; this bounds the walk itself so an
// endlessly-growing page cannot capture forever.
const MAX_TILES = 400;
const RESULT_TAB_TIMEOUT_MS = 10000;

// One injected script, one screenful, or one new tab. Generous, because a slow
// page is not a broken one: this is the point at which we stop believing the
// step will ever answer, not the point at which it is late.
const STEP_TIMEOUT_MS = 20000;

// Putting the page back is courtesy. The capture is already in hand by then, so
// tidying gets a short budget and is never allowed to hold the result up.
const RESTORE_TIMEOUT_MS = 5000;

// How long preparation is given to stop moving the page before it is measured.
// Spent only while the height is still changing.
const LAYOUT_SETTLE_MS = 2000;

// Past this a frame is bigger than any canvas can hold; growing it just makes
// the capture slower before it is truncated anyway.
const MAX_FRAME_HEIGHT = 20000;

let running = false;

// Set by the Finish now button in the progress popup. Read at the top of each
// screenful, so a stop always lands between two of them and never mid-photograph.
let stopRequested = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raised when a step was still pending at its deadline, never when it failed. */
export class StepTimeout extends Error {}

/**
 * Bound a promise that has no deadline of its own.
 *
 * Chrome's extension APIs reject when they fail and simply never settle when the
 * thing they are waiting on has gone quiet, which is the case this guards.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`${label} did not answer within ${ms}ms.`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// THE PROGRESS POPUP

// The toolbar popup, when the user has it switched on.
//
// It cannot be an overlay drawn into the page: the page is what we photograph, so
// an in-page indicator would have to be hidden for every screenful and would
// strobe. The popup is browser chrome and never reaches the image.
//
// default_popup is left empty in the manifest so that a click fires onClicked and
// captures immediately. It is set only for the duration of a capture, and set
// back in the finally, so a second click during a capture shows progress instead
// of doing nothing. It is also cleared whenever the worker starts, in case a
// capture was interrupted by the worker being shut down.
const PROGRESS_PAGE = 'src/ui/progress.html';

// A set rather than one port. Chrome can have more than one of these documents
// alive at a time: the popup is opened, closed and reopened freely, and a
// short-lived second connection used to overwrite the reference to the live one,
// whose disconnect then silently stopped all further updates. Every panel that is
// listening gets told, and a panel that goes away removes only itself.
const progressPorts = new Set();
let lastProgress = null;

chrome.action.setPopup({ popup: '' }).catch(() => {});

function tellProgress(message) {
  if (message.type === 'progress') lastProgress = message;
  for (const port of progressPorts) {
    try {
      port.postMessage(sealed(message));
    } catch {
      progressPorts.delete(port);
    }
  }
}

async function openProgressPopup() {
  await chrome.action.setPopup({ popup: PROGRESS_PAGE });
  try {
    await chrome.action.openPopup();
  } catch (error) {
    // Chrome refuses this when no window is focused, which is transient: the
    // click that started the capture is usually the thing that focuses it. One
    // retry catches that case, and the failure is reported rather than
    // swallowed, because a panel that silently never opens is indistinguishable
    // from a panel that was removed. The toolbar icon is still counting either
    // way, so a capture must never fail over this.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await chrome.action.openPopup().catch(() => {
      console.warn('OpenFullPage: could not open the progress popup:', error.message);
    });
  }
}

async function closeProgressPopup() {
  await chrome.action.setPopup({ popup: '' }).catch(() => {});
  progressPorts.clear();
  lastProgress = null;
}

// THE RESULT TAB

const awaitingTab = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'progress') {
    progressPorts.add(port);
    port.onDisconnect.addListener(() => progressPorts.delete(port));
    // Finish now. The walk checks this between screenfuls, so the user gets the
    // part of the page that was reached rather than losing the lot. The panel is
    // the only thing that can send it, and only an extension page can open this
    // port at all.
    port.onMessage.addListener((message) => {
      // A command from a panel that does not agree with us about what messages
      // mean is refused rather than guessed at. The only command there is is
      // Finish now, so refusing it means the capture runs to the end, which
      // costs the user nothing they had.
      if (!speaksOurProtocol(message)) return;
      if (message.type === 'stop') stopRequested = true;
    });
    // The popup connects after the capture has already started, so replay where
    // things stand rather than showing 0% until the next screenful lands.
    if (lastProgress) port.postMessage(sealed(lastProgress));
    return;
  }

  const [kind, id] = port.name.split(':');
  if (kind !== 'capture') return;

  const arrived = awaitingTab.get(id);
  if (!arrived) return;
  awaitingTab.delete(id);
  arrived(port);
});

async function openResultTab(captureId, sourceTab, { active = true } = {}) {
  const connected = new Promise((resolve) => awaitingTab.set(captureId, resolve));
  const url = chrome.runtime.getURL(`src/ui/result.html#${captureId}`);

  // Placed next to the page it came from, in the same window. If that window has
  // gone (the user closed it while the page was being walked) the capture still
  // exists, so fall back to wherever Chrome will put a tab rather than throwing
  // the screenfuls away.
  await withTimeout(
    chrome.tabs.create({ url, active, windowId: sourceTab.windowId, index: sourceTab.index + 1 }),
    STEP_TIMEOUT_MS,
    'opening the result tab',
  ).catch(() => withTimeout(chrome.tabs.create({ url, active }), STEP_TIMEOUT_MS, 'opening the result tab'));

  const port = await Promise.race([connected, wait(RESULT_TAB_TIMEOUT_MS).then(() => null)]);
  awaitingTab.delete(captureId);
  if (!port) throw new Error('The result tab did not open.');
  return port;
}

// THE PAGE

async function inPage(tabId, func, args = [], extra = {}) {
  const results = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId, ...extra }, func, args }),
    STEP_TIMEOUT_MS,
    func.name || 'a page script',
  );
  return results[0]?.result;
}

/**
 * The same, across every frame in the tab.
 *
 * This is the step most likely to hang: Chrome waits for all of them, and one
 * advertising frame that never goes idle is enough. Bounded, and failure here is
 * never fatal, because everything it does is preparation or tidying.
 */
async function inAllFrames(tabId, func, args = []) {
  return withTimeout(
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args }),
    STEP_TIMEOUT_MS,
    `${func.name || 'a page script'} in every frame`,
  ).catch(() => []);
}

async function captureViewport(windowId, delay) {
  let current = delay;

  for (let attempt = 0; attempt <= CAPTURE_RETRIES; attempt += 1) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      return { dataUrl, delay: current };
    } catch (error) {
      const message = String(error?.message ?? error);
      const throttled = message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
      if (!throttled || attempt === CAPTURE_RETRIES) throw error;

      current = Math.min(current * 2, CAPTURE_DELAY_MAX_MS);
      await wait(current);
    }
  }

  throw new Error('Capture was rate limited repeatedly.');
}

/**
 * Photograph the tile again when Chrome handed back the frame it already had.
 *
 * captureVisibleTab does not photograph the page. It hands back the last frame
 * the compositor presented, and a capture stops every animation and transition
 * before it starts walking, so on most pages the scroll is the only thing
 * producing frames at all. Lose the race with one and the screenful that
 * arrives is the previous one, placed at the new scroll position, because the
 * page really did move. The output then repeats one screenful and drops the one
 * that should have been there, and nothing in the pipeline notices: the tile
 * is the right size, lands at the right offset, and is a photograph of the
 * right page.
 *
 * Two screenfuls can be identical honestly, on a long blank stretch, which is
 * why this repairs rather than fails: a forced repaint and another photograph
 * costs one capture, and a stretch that really is identical simply arrives
 * identical again and is kept.
 */
async function retakeIfStale(tabId, windowId, previous, at, shot) {
  // Nothing to compare against, or the page did not move, in which case an
  // identical screenful is the only correct answer.
  if (!previous || (previous.x === at.x && previous.y === at.y)) return shot;

  let taken = shot;
  for (let attempt = 0; attempt < STALE_RETAKES; attempt += 1) {
    if (taken.dataUrl !== previous.dataUrl) break;
    await inPage(tabId, repaintAt, [at.x, at.y]);
    await wait(taken.delay);
    taken = await captureViewport(windowId, taken.delay);
  }
  return taken;
}

/** Turn the failure into something a person can act on. */
export function explain(error) {
  const message = String(error?.message ?? error);

  if (/chrome:\/\/|chrome-extension:\/\/|chrome\.google\.com|Web Store/i.test(message)) {
    return 'Chrome does not allow capturing this kind of page. Try an ordinary http(s) page.';
  }
  if (/Cannot access contents|must request permission|activeTab/i.test(message)) {
    return 'Chrome did not grant access to this tab. Open the page you want, then click the toolbar button on it.';
  }
  if (message.includes('MAX_CAPTURE')) {
    return 'Chrome rate limited the capture. Try again in a moment.';
  }
  return message;
}

// RUN

async function runCapture(tab, mode, settings) {
  const tabId = tab.id;
  const captureId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let prepared = false;
  let fixedHidden = false;
  let deepFrames = false;
  // Whether anything was playing when the capture started. Nothing is resumed
  // that this capture did not pause.
  let mediaPaused = false;
  let restored = false;
  let origin = { x: 0, y: 0 };

  const restore = async () => {
    if (restored) return;
    restored = true;
    const tidy = (async () => {
      // First, because it is the one piece of tidying the reader can hear.
      if (mediaPaused) await inAllFrames(tabId, resumeMedia);
      if (fixedHidden) {
        await chrome.scripting.removeCSS({ target: { tabId }, css: HIDE_FIXED_CSS }).catch(() => {});
      }
      if (prepared) {
        await chrome.scripting.removeCSS({ target: { tabId }, css: PREPARE_CSS }).catch(() => {});
      }
      // The top frame on its own, first. It is the only one the user scrolls, and
      // restoring every frame at once means one advertising frame that never
      // answers takes the page's own scroll position down with it. restorePage is
      // idempotent, so the pass below repeats it harmlessly.
      await inPage(tabId, restorePage, [origin.x, origin.y]).catch(() => {});
      if (deepFrames) await inAllFrames(tabId, stopFrameReporting);
      await inAllFrames(tabId, restorePage, [origin.x, origin.y]);
    })();
    // A page that will not put itself back is a nuisance the user can fix with a
    // reload. A capture that never arrives is not. Give up on the tidying.
    await withTimeout(tidy, RESTORE_TIMEOUT_MS, 'putting the page back').catch((error) => {
      console.warn('OpenFullPage:', error.message);
    });
  };

  let pageTitle = '';
  // One call so the toolbar icon and the popup can never disagree. canStop turns
  // the panel's Finish now button on: there is nothing to finish with until at
  // least one screenful has landed.
  const report = (fraction, what, canStop = false) => {
    showProgress(fraction);
    tellProgress({ type: 'progress', fraction, what, title: pageTitle, canStop });
  };

  try {
    report(0, 'Measuring the page');

    // Before the delay and before anything is measured, so a capture delay is
    // not spent with the video still running. Every mode, not only the full page
    // walk: a visible-area shot of a playing video is a frame nobody chose, and
    // the audio is playing either way.
    await inAllFrames(tabId, pauseMedia);
    mediaPaused = true;

    let metrics = await inPage(tabId, measurePage);
    pageTitle = metrics.title;
    origin = { x: metrics.scrollX, y: metrics.scrollY };

    // Where the user points, before anything on the page is disturbed.
    let region = null;
    if (mode === 'element') {
      region = await inPage(tabId, pickElement);
      if (!region) {
        clearProgress();
        return;
      }
    }

    if (settings.captureDelay > 0) await wait(settings.captureDelay * 1000);

    const wholePage = mode === 'full';
    if (wholePage && metrics.fullHeight > metrics.viewportHeight) {
      // Order matters: unsticking headers changes the document height, so the
      // page must be prepared before it is measured for real.
      await inPage(tabId, markSpecialElements);
      await chrome.scripting.insertCSS({ target: { tabId }, css: PREPARE_CSS });
      prepared = true;

      await inPage(tabId, expandSameOriginFrames, [MAX_FRAME_HEIGHT]);

      // Cross-origin frames only if the user has turned that on.
      if (await chrome.permissions.contains(DEEP_FRAMES)) {
        await inAllFrames(tabId, reportFrameHeights, [MAX_FRAME_HEIGHT]);
        deepFrames = true;
      }

      // Only now is the page the shape it will be photographed in. Measuring
      // any earlier plans the walk against a layout that is still moving, and
      // the first screenfuls then disagree with the last.
      report(0, 'Preparing the page');
      await inPage(tabId, waitForStableHeight, [LAYOUT_SETTLE_MS]);
      metrics = await inPage(tabId, measurePage);
    }

    if (mode === 'visible') {
      region = { x: metrics.scrollX, y: metrics.scrollY, w: metrics.viewportWidth, h: metrics.viewportHeight };
    }

    let plan = planCapture(metrics, region ? { region } : {});
    const shots = [];
    let delay = CAPTURE_DELAY_MIN_MS;
    // Why the walk ended, when it was not simply the bottom of the page.
    let endedEarly = null;

    // One pass down the page. Each stop waits only for what it revealed, so
    // lazy images are loaded by the time they are photographed without a
    // separate warm-up run down the page first.
    for (let index = 0; index < plan.tiles.length && index < MAX_TILES; index += 1) {
      const target = plan.tiles[index];

      // Checked between screenfuls, and on a wide page only at the start of a
      // row, so a stop always lands on a whole photograph and the image never
      // ends with half a row missing down its right-hand side.
      if (stopRequested && shots.length > 0 && target.x === plan.originX) {
        endedEarly = 'stopped';
        break;
      }

      let at;
      let shot;
      try {
        at = await inPage(tabId, scrollAndSettle, [target.x, target.y, SETTLE_BUDGET_MS]);
        // Only once the hiding stylesheet is in, which is also only once we have
        // scrolled at all. A page that makes its header fixed the moment you
        // move was not fixed when the page was tagged, so what is fixed is asked
        // again here rather than assumed to be what it was at the top. Never at
        // the cost of the capture: a page that has stopped answering loses its
        // repeated banner, not the screenful it was sitting on.
        if (fixedHidden) await inPage(tabId, remarkFixed).catch(() => {});
        shot = await captureViewport(tab.windowId, delay);
        shot = await retakeIfStale(tabId, tab.windowId, shots[shots.length - 1], at, shot);
      } catch (error) {
        // With nothing in hand there is no capture to salvage, so this is a
        // genuine failure. With screenfuls already taken, a page that has stopped
        // answering costs the user the rest of the image, not all of it.
        if (!(error instanceof StepTimeout) || shots.length === 0) throw error;
        console.warn('OpenFullPage:', error.message);
        endedEarly = 'stalled';
        break;
      }
      delay = shot.delay;

      // Record where the page actually landed, not where we asked it to go:
      // the final row and column clamp against the document edge.
      shots.push({ dataUrl: shot.dataUrl, x: at.x, y: at.y });
      report(
        (index + 1) / plan.tiles.length,
        plan.tiles.length > 1
          ? `Screen ${index + 1} of ${plan.tiles.length}`
          : 'Capturing',
        true,
      );

      if (index === 0 && plan.tiles.length > 1 && wholePage) {
        // Keep the sticky header in the first screenful, then stop it repeating.
        await chrome.scripting.insertCSS({ target: { tabId }, css: HIDE_FIXED_CSS });
        fixedHidden = true;
      }

      // Loading the tile may have appended more page below it. Re-plan rather
      // than stopping at a height that was only ever true before the walk
      // started; already-captured tiles keep their document coordinates, so
      // nothing behind us moves.
      if (wholePage && at.fullHeight > metrics.fullHeight) {
        metrics = { ...metrics, fullHeight: at.fullHeight };
        plan = planCapture(metrics, region ? { region } : {});
      }

      if (index < plan.tiles.length - 1) await wait(delay);
    }

    if (plan.tiles.length > MAX_TILES) plan = { ...plan, truncated: true };

    // A walk that ended early planned a canvas for the whole page. Handing that
    // over would produce an image the height of the page with the part nobody
    // photographed left blank, which reads as a broken capture rather than a
    // short one. Trim to what was actually reached.
    if (endedEarly) {
      const bottom = Math.max(...shots.map((shot) => shot.y)) + metrics.viewportHeight;
      const covered = Math.round(bottom - plan.originY);
      plan = { ...plan, height: Math.max(1, Math.min(plan.height, covered)) };
    }

    // Put the page back before anything else: the user gets their tab returned
    // to them at the same moment the capture stops, not after the stitching.
    await restore();

    const port = await openResultTab(captureId, tab, { active: !settings.directDownload });
    const send = (message) => port.postMessage(sealed(message));
    send({
      type: 'plan',
      title: metrics.title,
      url: metrics.url,
      mode,
      total: shots.length,
      truncated: plan.truncated,
      endedEarly,
      width: plan.width,
      height: plan.height,
      originX: plan.originX,
      originY: plan.originY,
      outputScale: plan.outputScale,
      innerWidth: metrics.innerWidth,
      viewportWidth: metrics.viewportWidth,
      viewportHeight: metrics.viewportHeight,
      settings,
    });
    for (const shot of shots) send({ type: 'tile', ...shot });
    send({ type: 'finish' });

    shots.length = 0;
    clearProgress();
    tellProgress({ type: 'done' });
  } catch (error) {
    showFailure();
    tellProgress({ type: 'failed', reason: explain(error) });
    throw error;
  } finally {
    await restore();
    await closeProgressPopup();
  }
}

/**
 * Begin a capture. The toolbar click omits `tabId` and gets the active tab;
 * passing one explicitly targets a specific tab, which is how the end-to-end
 * harness drives a capture without a click. Only extension pages can reach
 * this: there is no externally_connectable surface.
 */
export async function start({ tabId, mode } = {}) {
  if (running) return { started: false, reason: 'A capture is already running.' };

  const tab = tabId
    ? await chrome.tabs.get(tabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return { started: false, reason: 'No active tab.' };

  const settings = await loadSettings();
  // Extra modes are opt-in: with them off, everything captures the full page.
  const chosen = settings.extraModes ? (mode ?? settings.defaultMode) : 'full';

  running = true;
  stopRequested = false;
  if (settings.progressPopup) {
    // Not awaited: opening the popup must never delay or fail the capture.
    openProgressPopup().catch(() => {});
  }

  runCapture(tab, chosen, settings)
    .catch((error) => console.warn('OpenFullPage:', explain(error)))
    .finally(() => {
      running = false;
    });

  return { started: true, mode: chosen };
}

// No popup: one click on the toolbar button starts the capture.
chrome.action.onClicked.addListener((tab) => {
  start({ tabId: tab.id });
});

chrome.commands.onCommand.addListener(async (command) => {
  const modes = { 'capture-visible': 'visible', 'capture-element': 'element' };
  if (!modes[command]) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) start({ tabId: tab.id, mode: modes[command] });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'start') {
    start(message).then(sendResponse);
    return true;
  }

  // A result tab that saved itself straight to a file, asking to be tidied away,
  // or asking to be shown because it could not. Only ever the sender's own tab:
  // the id comes from Chrome, not from the message.
  const tabId = sender?.tab?.id;
  if (!tabId) return undefined;
  if (message?.type === 'closeTab') {
    chrome.tabs.remove(tabId).catch(() => {});
    return undefined;
  }
  if (message?.type === 'showTab') {
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
    return undefined;
  }
  return undefined;
});
