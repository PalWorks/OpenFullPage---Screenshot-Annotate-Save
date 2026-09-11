// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distanceToPath,
  fitPath,
  movePath,
  pathBounds,
  simplifyPath,
} from '../src/lib/geometry.js';

const wave = (n = 2000) => {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push([i * 0.5, Math.sin(i / 40) * 30]);
  return out;
};

test('a stroke of two thousand samples becomes a stroke of about a hundred points', () => {
  // The number, not the promise. A pen shape is the only one in this product
  // whose payload is unbounded, so the bound is an assertion rather than a
  // comment that stops being true.
  const raw = wave();
  const thinned = simplifyPath(raw, 0.6);

  assert.ok(thinned.length < 150, `expected under 150 points, got ${thinned.length}`);
  assert.ok(thinned.length > 20, `expected the curve to survive, got ${thinned.length}`);
});

test('simplifying never moves where a stroke starts or ends', () => {
  const raw = wave(500);
  const thinned = simplifyPath(raw, 2);

  assert.deepEqual(thinned[0], raw[0]);
  assert.deepEqual(thinned.at(-1), raw.at(-1));
});

test('a simplified stroke stays within the tolerance of the one it replaces', () => {
  const raw = wave(800);
  const tolerance = 1.5;
  const thinned = simplifyPath(raw, tolerance);

  let worst = 0;
  for (const [x, y] of raw) {
    const d = distanceToPath(thinned, { x, y });
    if (d > worst) worst = d;
  }
  assert.ok(worst <= tolerance + 1e-9, `a point strayed ${worst}, over the ${tolerance} allowed`);
});

test('collinear points collapse to the two ends', () => {
  const straight = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  assert.deepEqual(simplifyPath(straight, 0.5), [[0, 0], [4, 0]]);
});

test('a corner is never rounded away, however long the straight parts are', () => {
  const corner = [];
  for (let i = 0; i <= 50; i += 1) corner.push([i, 0]);
  for (let i = 1; i <= 50; i += 1) corner.push([50, i]);

  const thinned = simplifyPath(corner, 1);
  assert.ok(
    thinned.some(([x, y]) => x === 50 && y === 0),
    `the corner at 50,0 was dropped: ${JSON.stringify(thinned)}`,
  );
});

test('simplifying returns a new array and never touches the one it was given', () => {
  // The rule this exists to hold: history keeps references to shapes, so a
  // function that edited points in place would rewrite states already snapshot.
  const raw = wave(200);
  const copy = raw.map(([x, y]) => [x, y]);
  const thinned = simplifyPath(raw, 1);

  assert.notEqual(thinned, raw);
  assert.deepEqual(raw, copy, 'the input was modified');
  thinned[0][0] = 9999;
  assert.deepEqual(raw[0], copy[0], 'the output shares point objects with the input');
});

test('a stroke too short to simplify survives intact, as its own array', () => {
  for (const input of [[], [[1, 2]], [[1, 2], [3, 4]]]) {
    const out = simplifyPath(input, 1);
    assert.deepEqual(out, input);
    assert.notEqual(out, input, 'a copy, not the array itself');
  }
  assert.deepEqual(simplifyPath(null, 1), []);
});

test('a tolerance of nothing keeps every point rather than dropping them all', () => {
  const raw = wave(50);
  assert.equal(simplifyPath(raw, 0).length, raw.length);
  assert.equal(simplifyPath(raw, -1).length, raw.length);
});

test('bounds are the extent of the points, and empty is not infinite', () => {
  assert.deepEqual(pathBounds([[2, 3], [10, 3], [6, 11]]), { x: 2, y: 3, w: 8, h: 8 });
  assert.deepEqual(pathBounds([[5, 5]]), { x: 5, y: 5, w: 0, h: 0 });
  assert.deepEqual(pathBounds([]), { x: 0, y: 0, w: 0, h: 0 });
});

test('a stroke is measured as an open line, not a closed shape', () => {
  // Two ends far apart must not read as one long invisible side joining them.
  const hook = [[0, 0], [100, 0]];
  assert.ok(distanceToPath(hook, { x: 50, y: 0 }) < 0.001);
  assert.ok(distanceToPath(hook, { x: 50, y: 40 }) > 39);
  assert.equal(distanceToPath([], { x: 0, y: 0 }), Infinity);
  assert.equal(distanceToPath([[3, 4]], { x: 0, y: 0 }), 5);
});

test('moving a stroke shifts every point and leaves the original alone', () => {
  const raw = [[1, 1], [2, 2]];
  const moved = movePath(raw, 10, -5);
  assert.deepEqual(moved, [[11, -4], [12, -3]]);
  assert.deepEqual(raw, [[1, 1], [2, 2]]);
});

test('resizing fits a stroke into its new box', () => {
  const raw = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const from = pathBounds(raw);
  const to = { x: 100, y: 200, w: 20, h: 5 };
  const fitted = fitPath(raw, from, to);

  assert.deepEqual(pathBounds(fitted), to);
  assert.deepEqual(raw, [[0, 0], [10, 0], [10, 10], [0, 10]], 'the original was modified');
});

test('a perfectly straight stroke is moved rather than divided by nothing', () => {
  const flat = [[0, 5], [10, 5], [20, 5]];
  const from = pathBounds(flat);
  const fitted = fitPath(flat, from, { x: 0, y: 50, w: 40, h: 0 });

  assert.ok(fitted.every(([, y]) => Number.isFinite(y)), `NaN crept in: ${JSON.stringify(fitted)}`);
  assert.deepEqual(fitted.map(([, y]) => y), [50, 50, 50]);
});
