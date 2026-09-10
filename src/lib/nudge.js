// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// F3, the rating nudge. Pure, so the rules can be tested without a browser.
//
// The rules exist because three things in this area are Chrome Web Store policy
// or close enough that the distinction is not worth testing: no incentive, no
// repetition, and no review gating. The third is the one worth naming. The
// common pattern is a sentiment fork, "Enjoying it?", with Yes going to the
// store and No going to a feedback form. It measurably lifts the average score,
// which is why it is popular, and that is exactly why it is refused here: it
// filters unhappy users out of the public record, and a product sold on being
// checkable does not get to quietly curate its own reviews.
//
// So there is one ask, both answers go to the same place, and the feedback link
// sits beside it rather than behind it.

/** The capture on which the question is first worth asking. */
export const FIRST_NUDGE_AT = 5;

/** And the earliest the second one may come. */
export const SECOND_NUDGE_AT = 25;

/** Twice, ever. "Repeatedly asking users to rate" is a listed abuse. */
export const MAX_NUDGES = 2;

/**
 * Whether to ask, given what has happened so far and how this capture went.
 *
 * @param {{captureCount:number, nudgesShown:number, nudgeDone:boolean}} history
 * @param {{clean:boolean}} capture whether this capture came out whole
 */
export function shouldNudge(history, capture) {
  // A dismissal is permanent. It is the only answer this thing takes that it
  // never asks about again.
  if (history?.nudgeDone === true) return false;

  const shown = Number(history?.nudgesShown) || 0;
  if (shown >= MAX_NUDGES) return false;

  // Asking for five stars immediately after handing someone a short image is
  // asking to be told exactly what they think. A capture that was truncated, cut
  // short, or ended by a stalled page is not the moment.
  if (capture?.clean !== true) return false;

  const count = Number(history?.captureCount) || 0;
  return count >= (shown === 0 ? FIRST_NUDGE_AT : SECOND_NUDGE_AT);
}

/**
 * Did this capture come out whole?
 *
 * Written from the plan the result tab already has, rather than from a new flag
 * the worker would have to send, so it cannot disagree with what the tab is
 * showing the user.
 */
export const captureWasClean = (plan) =>
  plan?.truncated !== true && !plan?.endedEarly;

/**
 * The reviews page for this extension, or null.
 *
 * Chrome extension ids are exactly thirty two letters from a to p. Anything else
 * means the id is not what we think it is, and building a store address out of
 * it would send someone to a page that is not ours. The nudge simply does not
 * appear in that case, which is the right answer: there is nothing to rate.
 */
export function reviewsUrl(id) {
  return /^[a-p]{32}$/.test(String(id ?? ''))
    ? `https://chromewebstore.google.com/detail/${id}/reviews`
    : null;
}
