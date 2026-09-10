// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOWNLOAD_FORMATS,
  LOSSY_FORMATS,
  OUTPUT_FORMATS,
  encodeOrThrow,
  extensionOf,
} from '../src/lib/encode.js';

/**
 * A canvas is a DOM object and this suite has no DOM, but `toBlob` is the whole
 * of what `encodeOrThrow` touches, so the fake is the real interface. It also
 * lets the failing case be tested at all: a real canvas that returns null needs
 * to be larger than the encoder can hold.
 */
const fakeCanvas = (result) => ({
  calls: [],
  toBlob(callback, mime, quality) {
    this.calls.push({ mime, quality });
    callback(typeof result === 'function' ? result(mime) : result);
  },
});

test('a blob that encodes is handed straight back', async () => {
  const blob = { size: 12, type: 'image/png' };
  assert.equal(await encodeOrThrow(fakeCanvas(blob), 'image/png'), blob);
});

test('a null blob throws instead of travelling on as a download', async () => {
  // This is the whole point of T2. toBlob reports failure by calling back with
  // null: it does not throw and it does not reject, so the previous code
  // resolved null and handed it to URL.createObjectURL, which produced a
  // download of nothing and said nothing about it.
  await assert.rejects(
    () => encodeOrThrow(fakeCanvas(null), 'image/webp'),
    /could not be encoded as image\/webp/,
  );
});

test('the failure names the format and offers a way out', async () => {
  // A message that says only "encoding failed" leaves the reader with a capture
  // they cannot save and nothing to try.
  const error = await encodeOrThrow(fakeCanvas(null), 'image/jpeg').catch((e) => e);
  assert.match(error.message, /image\/jpeg/);
  assert.match(error.message, /too large|crop|PNG/i);
});

test('quality reaches the encoder exactly as given, including not at all', async () => {
  const canvas = fakeCanvas({ size: 1 });
  await encodeOrThrow(canvas, 'image/jpeg', 0.5);
  await encodeOrThrow(canvas, 'image/png', undefined);
  assert.deepEqual(canvas.calls, [
    { mime: 'image/jpeg', quality: 0.5 },
    { mime: 'image/png', quality: undefined },
  ]);
});

test('every format has a distinct extension and a mime type', () => {
  const extensions = DOWNLOAD_FORMATS.map((name) => OUTPUT_FORMATS[name].extension);
  assert.equal(new Set(extensions).size, extensions.length, 'two formats share an extension');
  for (const name of DOWNLOAD_FORMATS) {
    const spec = OUTPUT_FORMATS[name];
    assert.match(spec.mime, /^(image|application)\//, `${name} has no usable mime type`);
    assert.ok(spec.label, `${name} has no label`);
    assert.ok(spec.note, `${name} has no description for the menu`);
  }
});

test('only the formats whose encoder takes a quality are listed as lossy', () => {
  // The quality control is offered against this list, so a format that appears
  // on it without an encoder that reads a quality would give the reader a
  // control that does nothing.
  assert.deepEqual(LOSSY_FORMATS, ['jpeg', 'webp']);
  for (const name of DOWNLOAD_FORMATS) {
    assert.equal(OUTPUT_FORMATS[name].quality, LOSSY_FORMATS.includes(name), name);
  }
});

test('an unknown format names a file .png rather than .undefined', () => {
  assert.equal(extensionOf('png'), 'png');
  assert.equal(extensionOf('jpeg'), 'jpg');
  assert.equal(extensionOf('webp'), 'webp');
  for (const junk of ['gif', '', null, undefined, 7]) {
    assert.equal(extensionOf(junk), 'png', String(junk));
  }
});
