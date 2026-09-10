// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// F3. Every rule here is a promise made in docs/ROADMAP.md, so every one of them
// is a test: the counting, the cap, the permanence of a dismissal, and the
// refusal to ask after a capture that came out short.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIRST_NUDGE_AT,
  MAX_NUDGES,
  SECOND_NUDGE_AT,
  captureWasClean,
  reviewsUrl,
  shouldNudge,
} from '../src/lib/nudge.js';

const clean = { clean: true };
const fresh = { captureCount: 0, nudgesShown: 0, nudgeDone: false };

test('nothing is asked before the fifth capture, and then it is', () => {
  for (let n = 0; n < FIRST_NUDGE_AT; n += 1) {
    assert.equal(shouldNudge({ ...fresh, captureCount: n }, clean), false, `after ${n}`);
  }
  assert.equal(shouldNudge({ ...fresh, captureCount: FIRST_NUDGE_AT }, clean), true);
});

test('the second ask waits for the twenty fifth capture', () => {
  const once = { ...fresh, nudgesShown: 1 };
  assert.equal(shouldNudge({ ...once, captureCount: FIRST_NUDGE_AT }, clean), false);
  assert.equal(shouldNudge({ ...once, captureCount: SECOND_NUDGE_AT - 1 }, clean), false);
  assert.equal(shouldNudge({ ...once, captureCount: SECOND_NUDGE_AT }, clean), true);
});

test('twice, ever', () => {
  const many = { ...fresh, nudgesShown: MAX_NUDGES, captureCount: 5000 };
  assert.equal(shouldNudge(many, clean), false);
  assert.equal(shouldNudge({ ...many, nudgesShown: MAX_NUDGES + 7 }, clean), false);
});

test('a dismissal is permanent, whatever else is true', () => {
  const done = { captureCount: 5000, nudgesShown: 0, nudgeDone: true };
  assert.equal(shouldNudge(done, clean), false);
});

test('a capture that came out short is not the moment to ask', () => {
  const due = { ...fresh, captureCount: FIRST_NUDGE_AT };
  assert.equal(shouldNudge(due, { clean: false }), false);
  assert.equal(shouldNudge(due, {}), false);
  assert.equal(shouldNudge(due, undefined), false);
});

test('whole means not truncated and not ended early', () => {
  assert.equal(captureWasClean({}), true);
  assert.equal(captureWasClean({ truncated: false, endedEarly: null }), true);
  assert.equal(captureWasClean({ truncated: true }), false);
  assert.equal(captureWasClean({ endedEarly: 'stopped' }), false);
  assert.equal(captureWasClean({ endedEarly: 'stalled' }), false);
});

test('a store address is built only from an id that is really one', () => {
  const real = 'a'.repeat(32);
  assert.equal(reviewsUrl(real), `https://chromewebstore.google.com/detail/${real}/reviews`);

  // Anything else sends someone to a page that is not ours.
  for (const junk of [
    '', null, undefined, 'abc',
    'a'.repeat(31), 'a'.repeat(33),
    'a'.repeat(31) + 'z',
    'a'.repeat(31) + '/',
    '../../evil',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/../x',
  ]) {
    assert.equal(reviewsUrl(junk), null, String(junk));
  }
});

test('history that is missing or nonsense is treated as a fresh install', () => {
  // Storage can come back empty, and a NaN compared with a number is false in
  // both directions, which would make the nudge unreachable rather than eager.
  assert.equal(shouldNudge({}, clean), false);
  assert.equal(shouldNudge(undefined, clean), false);
  assert.equal(shouldNudge({ captureCount: 'lots', nudgesShown: null }, clean), false);
  assert.equal(shouldNudge({ captureCount: 9, nudgesShown: null }, clean), true);
});
