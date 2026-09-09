// SPDX-License-Identifier: GPL-3.0-only
//
// The outline vocabulary. Every closed shape is described once as a list of
// path operations, and both the canvas and the hit tester read that list, so
// these tests are the only place the shapes are checked against their own
// definition rather than against a picture of themselves.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORNERED_KINDS,
  CORNERS,
  GEOMETRY_KINDS,
  SHAPE_GEOMETRY,
  cornerOf,
  decorationOps,
  distanceToPolygon,
  flatten,
  outlineHit,
  outlineOps,
  outlinePoints,
  pointInPolygon,
} from '../src/lib/geometry.js';

const RECT = { x: 100, y: 100, w: 200, h: 120 };
const centreOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

test('every kind in the table produces a closed outline', () => {
  for (const kind of GEOMETRY_KINDS) {
    const points = outlinePoints(kind, RECT);
    assert.ok(points.length >= 3, `${kind} produced ${points.length} points`);
  }
});

test('every outline stays inside its own rect', () => {
  // A shape that escapes its rect breaks the selection box, the handles and the
  // marquee all at once, because every one of them reads the rect.
  const slack = 0.001;
  for (const kind of GEOMETRY_KINDS) {
    for (const [x, y] of outlinePoints(kind, RECT)) {
      assert.ok(x >= RECT.x - slack && x <= RECT.x + RECT.w + slack, `${kind} x=${x}`);
      assert.ok(y >= RECT.y - slack && y <= RECT.y + RECT.h + slack, `${kind} y=${y}`);
    }
  }
});

test('a point at the centre is inside every shape', () => {
  const point = centreOf(RECT);
  for (const kind of GEOMETRY_KINDS) {
    assert.ok(pointInPolygon(outlinePoints(kind, RECT), point), `${kind} missed its own centre`);
  }
});

test('a point far outside is inside nothing', () => {
  const point = { x: 5000, y: 5000 };
  for (const kind of GEOMETRY_KINDS) {
    assert.equal(pointInPolygon(outlinePoints(kind, RECT), point), false, kind);
  }
});

test('the empty corner of a rhombus and a triangle is a miss', () => {
  // The whole reason for a geometry table. A bounding box test says these hit.
  const corner = { x: RECT.x + 2, y: RECT.y + 2 };
  for (const kind of ['rhombus', 'triangle']) {
    assert.equal(outlineHit(kind, RECT, corner, 3), false, `${kind} hit its empty corner`);
  }
  // And the same click does hit a rectangle, so the test is not just asserting
  // that the point is outside everything.
  assert.equal(outlineHit('rect', RECT, corner, 3), true);
});

test('a point just outside an edge hits through the tolerance band', () => {
  const justOutside = { x: RECT.x - 2, y: RECT.y + RECT.h / 2 };
  assert.equal(outlineHit('rect', RECT, justOutside, 0.5), false);
  assert.equal(outlineHit('rect', RECT, justOutside, 4), true);
});

test('outlineHit needs a tolerance, it does not invent one', () => {
  // The defect this guards: a default tolerance is right at 100% zoom and
  // useless at 12%, where a fixed count of image pixels is a fraction of a
  // screen pixel. Passing undefined must not behave like passing a small
  // number, it must fail the comparison and return the strict answer.
  const justOutside = { x: RECT.x - 2, y: RECT.y + RECT.h / 2 };
  assert.equal(outlineHit('rect', RECT, justOutside, undefined), false);
});

test('degenerate rects produce no NaN and never throw', () => {
  const degenerate = [
    { x: 10, y: 10, w: 0, h: 0 },
    { x: 10, y: 10, w: 0, h: 50 },
    { x: 10, y: 10, w: 50, h: 0 },
    { x: 10, y: 10, w: 1, h: 1 },
    { x: 10, y: 10, w: -30, h: -30 },
  ];
  for (const kind of GEOMETRY_KINDS) {
    for (const rect of degenerate) {
      const points = outlinePoints(kind, rect);
      for (const [x, y] of points) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${kind} ${JSON.stringify(rect)}`);
      }
      assert.doesNotThrow(() => distanceToPolygon(points, { x: 0, y: 0 }));
    }
  }
});

test('hexagon and parallelogram insets stay clamped at extreme aspect ratios', () => {
  // A quarter of the width is more than half the width when the shape is
  // narrower than it is tall by enough, and an unclamped inset turns the
  // outline inside out.
  const narrow = { x: 0, y: 0, w: 4, h: 400 };
  for (const kind of ['hexagon', 'parallelogram']) {
    const points = outlinePoints(kind, narrow);
    for (const [x] of points) {
      assert.ok(x >= 0 && x <= 4, `${kind} escaped a narrow rect at x=${x}`);
    }
    assert.ok(pointInPolygon(points, { x: 2, y: 200 }), `${kind} lost its centre when narrow`);
  }
});

test('a cylinder has a lid, and the lid is decoration not outline', () => {
  // The bug this catches: sweeping the top arc the wrong way round draws it
  // through the bottom of the ellipse, leaving the cylinder open at the top.
  const points = outlinePoints('cylinder', RECT);
  const highest = Math.min(...points.map(([, y]) => y));
  assert.ok(highest <= RECT.y + 0.5, `cylinder top reached only y=${highest}`);

  const decorations = decorationOps('cylinder', RECT);
  assert.equal(decorations.length, 1);
  const seam = flatten(decorations[0]);
  const seamLow = Math.max(...seam.map(([, y]) => y));
  assert.ok(seamLow > RECT.y, 'the seam should hang below the top of the rect');
});

test('a loupe is round whatever the drag was shaped like, and its handle is not part of it', () => {
  const wide = { x: 0, y: 0, w: 400, h: 100 };
  const points = outlinePoints('loupe', wide);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(width - height) < 1, `loupe was ${width} by ${height}`);

  // A point out along the handle must miss: the handle is drawn, not hit tested.
  const handle = flatten(decorationOps('loupe', wide)[0]);
  const tip = handle.at(-1);
  assert.equal(pointInPolygon(points, { x: tip[0], y: tip[1] }), false);
});

test('a callout tail reaches the bottom of the rect', () => {
  const points = outlinePoints('callout', RECT);
  const lowest = Math.max(...points.map(([, y]) => y));
  assert.ok(lowest >= RECT.y + RECT.h - 0.5, `tail reached only y=${lowest}`);
});

test('corner radius rounds the Box and nothing else claims corners', () => {
  assert.deepEqual(CORNERED_KINDS, ['rect']);

  const square = outlineOps('rect', RECT, { corner: 0 });
  assert.ok(square.every((op) => op[0] !== 'A'), 'a square box should have no arcs');

  const rounded = outlineOps('rect', RECT, { corner: CORNERS.rounded });
  assert.ok(rounded.some((op) => op[0] === 'A'), 'a rounded box should have arcs');

  // A pill is a radius larger than the shape, clamped to half the short side,
  // so it is a stadium at every aspect ratio rather than an invalid path.
  const pill = flatten(outlineOps('rect', RECT, { corner: CORNERS.pill }));
  for (const [x, y] of pill) {
    assert.ok(x >= RECT.x - 0.001 && x <= RECT.x + RECT.w + 0.001);
    assert.ok(y >= RECT.y - 0.001 && y <= RECT.y + RECT.h + 0.001);
  }
});

test('cornerOf refuses anything that is not a positive number', () => {
  assert.equal(cornerOf({}), 0);
  assert.equal(cornerOf({ corner: -5 }), 0);
  assert.equal(cornerOf({ corner: 'pill' }), 0);
  assert.equal(cornerOf({ corner: Number.NaN }), 0);
  assert.equal(cornerOf({ corner: 12 }), 12);
  // A counter's own radius must not be mistaken for a corner radius.
  assert.equal(cornerOf({ kind: 'counter', radius: 18 }), 0);
});

test('an unknown kind returns null rather than guessing', () => {
  assert.equal(outlineOps('banana', RECT), null);
  assert.deepEqual(outlinePoints('banana', RECT), []);
  assert.equal(outlineHit('banana', RECT, centreOf(RECT), 4), false);
});

test('the table and its derived lists agree', () => {
  assert.deepEqual(GEOMETRY_KINDS, Object.keys(SHAPE_GEOMETRY));
  for (const kind of GEOMETRY_KINDS) {
    assert.equal(typeof SHAPE_GEOMETRY[kind].outline, 'function', kind);
  }
});
