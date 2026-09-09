// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The toolbar icon is the progress indicator. With no popup there is nowhere
// else to report from at the moment the user clicks, and the icon is already
// where they are looking.
//
// The frames are pre-rendered by tools/make-icons.mjs from the same geometry as
// the icon itself: the page fills with the accent colour as tiles land. Nothing
// is drawn at runtime, so this file stays small and the frames stay verifiable
// (CI asserts they match the design source).

// Must match PROGRESS_STEPS in tools/icon-design.mjs.
const STEPS = 8;

const RESTING = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

// setIcon reads the file each time it is called. Firing one per screenful makes
// those reads overlap and cancel each other, so only actual frame changes are
// sent, at most STEPS of them for a whole capture.
let shownStep = 0;

/** @param {number} fraction 0..1 */
export function showProgress(fraction) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const step = Math.max(1, Math.ceil(clamped * STEPS));

  if (step !== shownStep) {
    shownStep = step;
    chrome.action
      .setIcon({
        path: { 16: `icons/progress/p${step}-16.png`, 32: `icons/progress/p${step}-32.png` },
      })
      // A failed icon update must never take the capture down with it.
      .catch(() => {});
  }

  // The frames are coarse on purpose; the badge carries the exact number.
  chrome.action.setBadgeText({ text: `${Math.round(clamped * 100)}%` }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#4338CA' }).catch(() => {});
}

export function showFailure() {
  shownStep = 0;
  chrome.action.setIcon({ path: RESTING }).catch(() => {});
  chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#DC2626' }).catch(() => {});
}

export function clearProgress() {
  shownStep = 0;
  chrome.action.setIcon({ path: RESTING }).catch(() => {});
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}
