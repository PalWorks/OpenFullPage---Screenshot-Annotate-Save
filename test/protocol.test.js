// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  sealed,
  speaksOurProtocol,
} from '../src/lib/protocol.js';

test('a sealed message carries the version and keeps everything else', () => {
  const message = { type: 'tile', index: 3, data: 'x' };
  assert.deepEqual(sealed(message), { ...message, protocol: PROTOCOL_VERSION });
  // The original is untouched: the worker seals the same object more than once
  // on the progress path, where lastProgress is kept and replayed.
  assert.deepEqual(message, { type: 'tile', index: 3, data: 'x' });
});

test('sealing twice is the same as sealing once', () => {
  assert.deepEqual(sealed(sealed({ type: 'progress' })), sealed({ type: 'progress' }));
});

test('our own messages are accepted', () => {
  assert.equal(speaksOurProtocol(sealed({ type: 'plan' })), true);
});

test('a message from a build that does not stamp at all is refused', () => {
  // The case this exists for: an extension updated while a result tab stayed
  // open. The tab is running the old code, which sends nothing and expects
  // nothing, and the new worker posts to it anyway.
  assert.equal(speaksOurProtocol({ type: 'plan' }), false);
});

test('a message from another version is refused, in both directions', () => {
  assert.equal(speaksOurProtocol({ type: 'plan', protocol: PROTOCOL_VERSION + 1 }), false);
  assert.equal(speaksOurProtocol({ type: 'plan', protocol: PROTOCOL_VERSION - 1 }), false);
});

test('nothing at all is refused rather than throwing', () => {
  // Ports deliver whatever the other end sent, and a reader that throws inside
  // an onMessage listener loses the message and every check after it.
  for (const junk of [null, undefined, 0, '', 'plan', []]) {
    assert.equal(speaksOurProtocol(junk), false, String(junk));
  }
});

test('a version that is only nearly right is refused', () => {
  // Strict equality, not ==. "1" arriving as a string would mean the message
  // crossed something that stringifies, which is exactly when to stop.
  assert.equal(speaksOurProtocol({ protocol: String(PROTOCOL_VERSION) }), false);
});

test('the mismatch message tells the reader what to do about it', () => {
  assert.match(PROTOCOL_MISMATCH, /updated/i);
  assert.match(PROTOCOL_MISMATCH, /again/i);
  // And says nothing was lost, because the reader's first fear is their page.
  assert.match(PROTOCOL_MISMATCH, /nothing was lost/i);
});
