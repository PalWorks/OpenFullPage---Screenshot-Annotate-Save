// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// Opening an image the reader already has, rather than one we captured.
//
// The editor is a base canvas plus a list of shapes, and nothing below that
// line knows where the base came from. So an imported file is the same product
// with a different first step, and the only new thinking is what may be opened
// and what to say when something may not.
//
// Pure: no DOM, no chrome.*, so every refusal below is a unit test rather than
// a thing somebody has to reproduce by hand with an odd file.

import { LIMITS } from './plan.js';

/**
 * The types a base may be built from.
 *
 * Named rather than matched with `image/*`, which is the obvious shortcut and
 * the wrong one: the wildcard admits SVG, and an SVG is a document rather than
 * a picture. It has no intrinsic pixel size, it can reference other files, and
 * "open this and draw on it" means something different for a thing that is
 * already a drawing. Raster only, listed, so the list is the contract.
 */
export const IMPORT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
];

/** What the file dialog should accept. Derived, so it cannot drift from the list. */
export const IMPORT_ACCEPT = IMPORT_TYPES.join(',');

/** Readable names for the same list, for the one message that has to list them. */
const IMPORT_NAMES = 'PNG, JPEG, WebP, GIF, BMP and AVIF';

/**
 * Why this file cannot be opened, or null if it can.
 *
 * Checked before decoding, because the cheapest refusal is the one that never
 * allocates anything.
 *
 * @param {{name?: string, type?: string, size?: number}} file
 * @returns {string|null} a sentence for the status line, or null
 */
export function refuseFile(file) {
  if (!file) return null;

  const type = String(file.type ?? '').toLowerCase();
  const name = String(file.name ?? '');

  if (type === 'image/svg+xml' || /\.svgz?$/i.test(name)) {
    return 'An SVG is a drawing rather than a picture, so it cannot be opened here. Save it as a PNG first.';
  }

  if (!IMPORT_TYPES.includes(type)) {
    // A type of nothing is what Chrome reports for a file it does not
    // recognise, and it is worth saying so differently from a wrong type: one
    // is "this is not an image", the other is "this is the wrong image".
    return type
      ? `That file is a ${type}. Images can be opened as ${IMPORT_NAMES}.`
      : `That file is not an image. Images can be opened as ${IMPORT_NAMES}.`;
  }

  if (file.size === 0) return 'That file is empty.';

  return null;
}

/**
 * Why an image this size cannot be held, or null if it can.
 *
 * Two limits, not one, and the area limit binds first on anything close to
 * square: a 16384 square image is inside `maxSide` on both axes and still 268
 * million pixels, more than twice `maxArea` and over a gigabyte before the
 * editor makes a single copy of it.
 *
 * Refused rather than downscaled. A capture is downscaled because the
 * alternative is not having the page at all, and the reader is told. An import
 * already exists at a size the reader chose, so quietly returning a smaller one
 * would be answering a question nobody asked.
 *
 * @param {number} width
 * @param {number} height
 * @param {{maxSide:number, maxArea:number}} [limits]
 * @returns {string|null}
 */
export function refuseDimensions(width, height, limits = LIMITS) {
  const w = Number(width);
  const h = Number(height);

  if (!(w > 0) || !(h > 0)) return 'That image has no size.';

  if (w > limits.maxSide || h > limits.maxSide) {
    return `That image is ${w} by ${h} pixels. The widest or tallest that can be opened is ${limits.maxSide}.`;
  }

  if (w * h > limits.maxArea) {
    const millions = Math.round(limits.maxArea / 1e6);
    return `That image is ${w} by ${h} pixels, which is more than one canvas can hold. The limit is about ${millions} million pixels in total.`;
  }

  return null;
}

/**
 * The name to put in the filename box for an opened file.
 *
 * The reader's own name for the picture, minus its extension, because the
 * extension is chosen again on the way out and showing two of them reads as a
 * mistake. Falls back to the same word a capture with no page title uses.
 *
 * Not a sanitiser: `applyFilename` in plan.js is the one place that treats a
 * filename as hostile, and it still runs on the way to `chrome.downloads`.
 * This only has to be a sensible default in a box the reader can edit.
 *
 * @param {string} name the file's own name
 * @returns {string}
 */
export function importBasename(name) {
  const withoutExtension = String(name ?? '').replace(/\.[^.\\/]{1,12}$/, '');
  const trimmed = withoutExtension.trim();
  return trimmed || 'image';
}
