// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_TYPES,
  IMPORT_ACCEPT,
  refuseFile,
  refuseDimensions,
  importBasename,
} from '../src/lib/open.js';
import { LIMITS } from '../src/lib/plan.js';

test('a raster image the editor understands is not refused', () => {
  for (const type of IMPORT_TYPES) {
    assert.equal(refuseFile({ name: `a.${type.split('/')[1]}`, type, size: 10 }), null, type);
  }
});

test('the file dialog accepts exactly the types the code accepts', () => {
  // Derived rather than typed twice: a dialog that offers a format the decoder
  // refuses is a dialog that lets the reader pick a file and then says no.
  assert.equal(IMPORT_ACCEPT, IMPORT_TYPES.join(','));
  assert.ok(!IMPORT_ACCEPT.includes('image/*'));
  assert.ok(!IMPORT_ACCEPT.includes('svg'));
});

test('SVG is refused by type and by extension, and the reason says what to do', () => {
  const byType = refuseFile({ name: 'logo', type: 'image/svg+xml', size: 10 });
  const byName = refuseFile({ name: 'logo.svg', type: '', size: 10 });
  const zipped = refuseFile({ name: 'logo.svgz', type: '', size: 10 });

  for (const message of [byType, byName, zipped]) {
    assert.match(message, /SVG/);
    assert.match(message, /PNG/);
  }
});

test('a file that is not an image reads differently from an image of the wrong kind', () => {
  const notAnImage = refuseFile({ name: 'notes.txt', type: 'text/plain', size: 10 });
  const noTypeAtAll = refuseFile({ name: 'mystery', type: '', size: 10 });

  assert.match(notAnImage, /text\/plain/);
  assert.match(noTypeAtAll, /not an image/);
  assert.notEqual(notAnImage, noTypeAtAll);
});

test('an empty file is refused, and it is not confused with a missing one', () => {
  assert.match(refuseFile({ name: 'a.png', type: 'image/png', size: 0 }), /empty/);
  // No file at all is not an error. Pasting text is not a failed image paste.
  assert.equal(refuseFile(null), null);
  assert.equal(refuseFile(undefined), null);
});

test('both canvas limits are enforced, not just the side one', () => {
  // The trap this test exists for: 16384 square is inside maxSide on both axes
  // and still more than twice maxArea.
  const square = refuseDimensions(LIMITS.maxSide, LIMITS.maxSide);
  assert.ok(square, 'a 16384 square image must be refused');
  assert.match(square, /million pixels/);

  assert.equal(refuseDimensions(LIMITS.maxSide, 4000), null);
  assert.match(refuseDimensions(LIMITS.maxSide + 1, 10), /widest or tallest/);
  assert.match(refuseDimensions(10, LIMITS.maxSide + 1), /widest or tallest/);
});

test('the area limit is reported when the sides alone would have passed', () => {
  const wide = 16000;
  const tall = Math.ceil(LIMITS.maxArea / wide) + 1;
  assert.ok(tall < LIMITS.maxSide, 'the fixture must stay inside the side limit');

  const message = refuseDimensions(wide, tall);
  assert.match(message, /million pixels/);
  assert.doesNotMatch(message, /widest or tallest/);
});

test('an image with no size is refused rather than dividing by nothing', () => {
  assert.match(refuseDimensions(0, 10), /no size/);
  assert.match(refuseDimensions(10, 0), /no size/);
  assert.match(refuseDimensions(NaN, NaN), /no size/);
});

test('the filename box opens on the reader own name for the picture, without its extension', () => {
  assert.equal(importBasename('holiday.png'), 'holiday');
  assert.equal(importBasename('a.file.with.dots.jpeg'), 'a.file.with.dots');
  assert.equal(importBasename('no-extension'), 'no-extension');
  assert.equal(importBasename('  spaced.webp  '), 'spaced');
});

test('a name that is nothing but an extension still produces a filename', () => {
  assert.equal(importBasename('.png'), 'image');
  assert.equal(importBasename(''), 'image');
  assert.equal(importBasename(null), 'image');
});
