// SPDX-License-Identifier: GPL-3.0-only
//
// The shipped icons are binaries, and binaries are where a reviewer stops
// reading. This asserts every one of them is exactly what tools/icon-design.mjs
// draws, including the toolbar progress frames, so they cannot be quietly
// swapped for something else.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { PROGRESS_SIZES, PROGRESS_STEPS, render } from '../tools/icon-design.mjs';
import { decodePng } from '../tools/lib/png.mjs';
import { REPO_ROOT, readManifest, shippedFiles } from './lib/scan.js';

const SIZES = [16, 32, 48, 128];

/** Every icon the design is supposed to produce, and what it should contain. */
function expectedIcons() {
  const expected = new Map();
  for (const size of SIZES) {
    expected.set(`icons/icon${size}.png`, { size, progress: 0 });
  }
  for (let step = 1; step <= PROGRESS_STEPS; step += 1) {
    for (const size of PROGRESS_SIZES) {
      expected.set(`icons/progress/p${step}-${size}.png`, { size, progress: step / PROGRESS_STEPS });
    }
  }
  return expected;
}

// Pixels, not file bytes. Deflate output at a given level differs between zlib
// versions, so comparing whole files asserts which machine generated the icon
// rather than what it draws, and fails on a runner whose zlib differs from the
// author's. Decoding both sides keeps the claim, and drops the false negative.
test('every committed icon is reproducible from the design source', () => {
  for (const [path, { size, progress }] of expectedIcons()) {
    const onDisk = decodePng(readFileSync(join(REPO_ROOT, path)));
    assert.equal(onDisk.width, size, `${path} is not ${size}px wide`);
    assert.equal(onDisk.height, size, `${path} is not ${size}px tall`);
    assert.deepEqual(
      Buffer.from(onDisk.rgba),
      Buffer.from(render(size, progress)),
      `${path} does not match tools/icon-design.mjs, re-run tools/make-icons.mjs`,
    );
  }
});

test('no unexplained image ships alongside them', () => {
  const shipped = shippedFiles().filter((p) => p.startsWith('icons/'));
  assert.deepEqual(shipped.sort(), [...expectedIcons().keys()].sort());
});

test('the manifest points at icons that exist', () => {
  const manifest = readManifest();
  for (const set of [manifest.icons, manifest.action.default_icon]) {
    assert.deepEqual(Object.keys(set).map(Number).sort((a, b) => a - b), SIZES);
    for (const path of Object.values(set)) {
      assert.ok(readFileSync(join(REPO_ROOT, path)).length > 0, `${path} is empty`);
    }
  }
});

test('the progress frames the badge module asks for all exist', () => {
  const present = new Set(readdirSync(join(REPO_ROOT, 'icons/progress')));
  for (let step = 1; step <= PROGRESS_STEPS; step += 1) {
    for (const size of PROGRESS_SIZES) {
      assert.ok(present.has(`p${step}-${size}.png`), `missing progress frame p${step}-${size}.png`);
    }
  }
  // src/lib/badge.js hard-codes the step count; drift would silently 404.
  const badge = readFileSync(join(REPO_ROOT, 'src/lib/badge.js'), 'utf8');
  assert.match(badge, new RegExp(`const STEPS = ${PROGRESS_STEPS};`));
});
