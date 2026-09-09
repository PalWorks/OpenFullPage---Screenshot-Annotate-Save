// SPDX-License-Identifier: GPL-3.0-only
//
// The editing model. Shapes are live objects that can be selected, moved,
// resized and deleted, so the risky parts are hit testing, handle maths and
// undo across all of those, not just across drawing.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CROP_HANDLES,
  MIN_CROP,
  amend,
  arrowGeometry,
  boundsOf,
  canRedo,
  canUndo,
  clampRect,
  commit,
  constrain,
  createDocument,
  cropCursor,
  cropHandleAt,
  cropHandlesFor,
  effectiveCrop,
  insideRect,
  moveCrop,
  resizeCrop,
  handleAt,
  handlesFor,
  hits,
  isEdited,
  isUsableCrop,
  isUsableDrag,
  moveShape,
  nextCounterNumber,
  normalizeRect,
  redo,
  removeShape,
  replaceShape,
  reset,
  resizeShape,
  selectedShape,
  shapeAt,
  undo,
} from '../src/lib/edit.js';

const doc = () => createDocument(1000, 4000);
const box = (id, x, y, w = 100, h = 60) => ({
  id, kind: 'rect', rect: { x, y, w, h }, colour: '#ef4444', width: 4,
});
const arrow = (id, ax, ay, bx, by) => ({
  id, kind: 'arrow', from: { x: ax, y: ay }, to: { x: bx, y: by }, colour: '#ef4444', width: 4,
});
const withShapes = (...shapes) => commit(doc(), { shapes, crop: null, selected: null });

// HISTORY

test('a fresh document is unedited and shows the whole image', () => {
  const d = doc();
  assert.deepEqual(effectiveCrop(d), { x: 0, y: 0, w: 1000, h: 4000 });
  assert.equal(isEdited(d), false);
  assert.equal(canUndo(d), false);
  assert.equal(canRedo(d), false);
});

test('undo and redo walk the history without losing it', () => {
  let d = withShapes(box('a', 10, 10));
  d = commit(d, { ...d.present, shapes: [...d.present.shapes, box('b', 20, 20)] });
  assert.equal(d.present.shapes.length, 2);

  d = undo(d);
  assert.equal(d.present.shapes.length, 1);
  assert.ok(canRedo(d));

  d = redo(d);
  assert.equal(d.present.shapes.length, 2);
  assert.equal(canRedo(d), false);
});

test('a new edit after an undo discards the redo branch', () => {
  let d = withShapes(box('a', 10, 10));
  d = commit(d, { ...d.present, shapes: [...d.present.shapes, box('b', 20, 20)] });
  d = undo(d);
  d = commit(d, { ...d.present, shapes: [...d.present.shapes, box('c', 30, 30)] });

  assert.equal(canRedo(d), false);
  assert.deepEqual(d.present.shapes.map((s) => s.id), ['a', 'c']);
});

test('undoing past the start is a no-op', () => {
  const d = undo(undo(doc()));
  assert.deepEqual(d.present.shapes, []);
});

test('selection changes do not pile up in the undo history', () => {
  // Clicking around must not fill undo with nothing; only real edits do.
  let d = withShapes(box('a', 10, 10));
  const depth = d.past.length;
  d = amend(d, { ...d.present, selected: 'a' });
  d = amend(d, { ...d.present, selected: null });
  assert.equal(d.past.length, depth);
});

test('a crop is undoable and reveals what came before', () => {
  let d = withShapes(box('a', 10, 10));
  d = commit(d, { ...d.present, crop: { x: 100, y: 200, w: 400, h: 500 } });
  assert.deepEqual(effectiveCrop(d), { x: 100, y: 200, w: 400, h: 500 });

  d = undo(d);
  assert.deepEqual(effectiveCrop(d), { x: 0, y: 0, w: 1000, h: 4000 });
});

test('shapes keep original-image coordinates across a crop', () => {
  let d = withShapes(box('a', 500, 500));
  d = commit(d, { ...d.present, crop: { x: 400, y: 400, w: 200, h: 200 } });
  assert.deepEqual(d.present.shapes[0].rect, { x: 500, y: 500, w: 100, h: 60 });
  assert.deepEqual(undo(d).present.shapes[0].rect, { x: 500, y: 500, w: 100, h: 60 });
});

test('reset clears shapes and crop together', () => {
  let d = withShapes(box('a', 10, 10));
  d = commit(d, { ...d.present, crop: { x: 1, y: 1, w: 9, h: 9 } });
  const cleared = reset(d);
  assert.equal(isEdited(cleared), false);
  assert.deepEqual(effectiveCrop(cleared), { x: 0, y: 0, w: 1000, h: 4000 });
  assert.ok(canUndo(cleared), 'reset itself must be undoable');
});

// MANIPULATION

test('clicking picks the topmost shape under the point', () => {
  const under = box('under', 0, 0, 200, 200);
  const over = box('over', 50, 50, 50, 50);
  assert.equal(shapeAt([under, over], { x: 60, y: 60 }).id, 'over');
  assert.equal(shapeAt([under, over], { x: 10, y: 10 }).id, 'under');
  assert.equal(shapeAt([under, over], { x: 900, y: 900 }), null);
});

test('a thin line is still clickable near it, not only exactly on it', () => {
  const line = arrow('a', 0, 0, 200, 0);
  assert.ok(hits(line, { x: 100, y: 4 }));
  assert.ok(!hits(line, { x: 100, y: 60 }));
  // Past the end of the segment, not just off its axis.
  assert.ok(!hits(line, { x: 400, y: 0 }));
});

test('moving a shape shifts every part of it', () => {
  assert.deepEqual(moveShape(box('a', 10, 20), 5, 7).rect, { x: 15, y: 27, w: 100, h: 60 });

  const moved = moveShape(arrow('a', 0, 0, 10, 10), 3, 4);
  assert.deepEqual(moved.from, { x: 3, y: 4 });
  assert.deepEqual(moved.to, { x: 13, y: 14 });
});

test('a box has four corner handles, a line has its two ends', () => {
  assert.deepEqual(handlesFor(box('a', 0, 0, 100, 60)).map((h) => h.id), ['nw', 'ne', 'sw', 'se']);
  assert.deepEqual(handlesFor(arrow('a', 1, 2, 3, 4)).map((h) => h.id), ['from', 'to']);
});

test('handles are only picked up when the pointer is near them', () => {
  const shape = box('a', 0, 0, 100, 60);
  assert.equal(handleAt(shape, { x: 100, y: 60 }, 10), 'se');
  assert.equal(handleAt(shape, { x: 50, y: 30 }, 10), null);
});

test('dragging a corner resizes against the opposite corner', () => {
  const resized = resizeShape(box('a', 0, 0, 100, 60), 'se', { x: 200, y: 150 });
  assert.deepEqual(resized.rect, { x: 0, y: 0, w: 200, h: 150 });
});

test('a box dragged inside out stays a valid rectangle', () => {
  const resized = resizeShape(box('a', 0, 0, 100, 60), 'se', { x: -40, y: -30 });
  assert.ok(resized.rect.w >= 0 && resized.rect.h >= 0);
  assert.deepEqual(resized.rect, { x: -40, y: -30, w: 40, h: 30 });
});

test('dragging an arrow endpoint moves only that end', () => {
  const resized = resizeShape(arrow('a', 0, 0, 10, 10), 'to', { x: 99, y: 5 });
  assert.deepEqual(resized.from, { x: 0, y: 0 });
  assert.deepEqual(resized.to, { x: 99, y: 5 });
});

test('replacing a shape leaves the others and the order alone', () => {
  const present = { shapes: [box('a', 0, 0), box('b', 5, 5)], crop: null, selected: 'b' };
  const next = replaceShape(present, { ...present.shapes[1], colour: '#000000' });
  assert.deepEqual(next.shapes.map((s) => s.id), ['a', 'b']);
  assert.equal(next.shapes[1].colour, '#000000');
});

test('deleting a shape also clears the selection pointing at it', () => {
  const present = { shapes: [box('a', 0, 0), box('b', 5, 5)], crop: null, selected: 'b' };
  const next = removeShape(present, 'b');
  assert.deepEqual(next.shapes.map((s) => s.id), ['a']);
  assert.equal(next.selected, null);
});

test('selectedShape returns null rather than throwing when nothing is selected', () => {
  assert.equal(selectedShape(withShapes(box('a', 0, 0))), null);
  const d = amend(withShapes(box('a', 0, 0)), { shapes: [box('a', 0, 0)], crop: null, selected: 'a' });
  assert.equal(selectedShape(d).id, 'a');
});

// GEOMETRY

test('Shift makes boxes square and lines snap to 45 degrees', () => {
  const square = constrain({ x: 0, y: 0 }, { x: 100, y: 30 }, 'rect');
  assert.deepEqual(square, { x: 100, y: 100 });

  const snapped = constrain({ x: 0, y: 0 }, { x: 100, y: 8 }, 'arrow');
  assert.ok(Math.abs(snapped.y) < 1e-9, 'a near-horizontal drag should snap flat');
});

test('a rectangle comes out the same whichever way it was dragged', () => {
  const expected = { x: 10, y: 20, w: 30, h: 40 };
  assert.deepEqual(normalizeRect({ x: 10, y: 20 }, { x: 40, y: 60 }), expected);
  assert.deepEqual(normalizeRect({ x: 40, y: 60 }, { x: 10, y: 20 }), expected);
});

test('a selection dragged off the edge is trimmed, never negative', () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 4000 };
  assert.deepEqual(clampRect({ x: 900, y: 3900, w: 500, h: 500 }, bounds),
    { x: 900, y: 3900, w: 100, h: 100 });
  const outside = clampRect({ x: -50, y: -50, w: 20, h: 20 }, bounds);
  assert.ok(outside.x >= 0 && outside.y >= 0 && outside.w >= 0 && outside.h >= 0);
});

test('stray clicks are not shapes or crops', () => {
  assert.equal(isUsableDrag({ x: 0, y: 0 }, { x: 1, y: 1 }), false);
  assert.equal(isUsableDrag({ x: 0, y: 0 }, { x: 40, y: 0 }), true);
  assert.equal(isUsableCrop({ x: 0, y: 0, w: 4, h: 400 }), false);
});

test('an arrow head sits at the tip, square to the shaft', () => {
  const { shaft, head } = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
  assert.deepEqual(head[2], { x: 100, y: 0 });
  assert.ok(shaft[1].x < 100 && shaft[1].x > 0);
  assert.ok(Math.abs(head[0].y + head[1].y) < 1e-9);
});

test('the head never grows longer than the arrow, and never produces NaNs', () => {
  const short = arrowGeometry({ x: 0, y: 0 }, { x: 6, y: 0 }, 20);
  assert.ok(short.shaft[1].x >= 0);
  for (const p of [...short.shaft, ...short.head]) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  const zero = arrowGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, 4);
  for (const p of [...zero.shaft, ...zero.head]) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test('bounds cover each kind of shape', () => {
  assert.deepEqual(boundsOf(box('a', 10, 20)), { x: 10, y: 20, w: 100, h: 60 });
  assert.deepEqual(boundsOf(arrow('a', 30, 10, 10, 40)), { x: 10, y: 10, w: 20, h: 30 });
  assert.deepEqual(
    boundsOf({ kind: 'counter', at: { x: 50, y: 50 }, radius: 12 }),
    { x: 38, y: 38, w: 24, h: 24 },
  );
});

test('counters number themselves in placement order', () => {
  assert.equal(nextCounterNumber([]), 1);
  assert.equal(nextCounterNumber([box('a', 0, 0), { kind: 'counter' }]), 2);
});

// CROP GEOMETRY
//
// A crop is committed once and cannot be undone by dragging, so the arithmetic
// that decides where the edges land is worth more tests than it looks.

test('a crop offers four corners and four edge midpoints', () => {
  const handles = cropHandlesFor({ x: 10, y: 20, w: 100, h: 60 });
  assert.deepEqual(handles.map((h) => h.id).sort(), [...CROP_HANDLES].sort());
  const at = Object.fromEntries(handles.map((h) => [h.id, h]));
  assert.deepEqual({ ...at.nw }, { id: 'nw', x: 10, y: 20 });
  assert.deepEqual({ ...at.se }, { id: 'se', x: 110, y: 80 });
  assert.deepEqual({ ...at.n }, { id: 'n', x: 60, y: 20 });
  assert.deepEqual({ ...at.w }, { id: 'w', x: 10, y: 50 });
});

test('a corner wins over the edge it sits on', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(cropHandleAt(rect, { x: 0, y: 0 }, 6), 'nw');
  assert.equal(cropHandleAt(rect, { x: 50, y: 0 }, 6), 'n');
  assert.equal(cropHandleAt(rect, { x: 50, y: 50 }, 6), null);
});

test('dragging a handle moves only the edges that handle owns', () => {
  const rect = { x: 20, y: 20, w: 100, h: 100 };
  const bounds = { x: 0, y: 0, w: 400, h: 400 };

  const west = resizeCrop(rect, 'w', { x: 5, y: 999 }, bounds);
  assert.deepEqual(west, { x: 5, y: 20, w: 115, h: 100 });

  const southEast = resizeCrop(rect, 'se', { x: 200, y: 150 }, bounds);
  assert.deepEqual(southEast, { x: 20, y: 20, w: 180, h: 130 });
});

test('a crop cannot be dragged outside the image', () => {
  const rect = { x: 20, y: 20, w: 100, h: 100 };
  const bounds = { x: 0, y: 0, w: 200, h: 200 };
  assert.deepEqual(resizeCrop(rect, 'nw', { x: -50, y: -50 }, bounds), { x: 0, y: 0, w: 120, h: 120 });
  assert.deepEqual(resizeCrop(rect, 'se', { x: 900, y: 900 }, bounds), { x: 20, y: 20, w: 180, h: 180 });
});

test('an edge clamps at the opposite one rather than turning the crop inside out', () => {
  const rect = { x: 20, y: 20, w: 100, h: 100 };
  const bounds = { x: 0, y: 0, w: 400, h: 400 };
  // Drag the west edge far past the east one.
  const flipped = resizeCrop(rect, 'w', { x: 999, y: 0 }, bounds);
  assert.ok(flipped.w >= MIN_CROP, `width collapsed to ${flipped.w}`);
  assert.equal(flipped.x + flipped.w, 120, 'the east edge moved');
  assert.equal(flipped.w, MIN_CROP);
});

test('a crop slides whole and stops at the edges of the image', () => {
  const rect = { x: 20, y: 20, w: 100, h: 100 };
  const bounds = { x: 0, y: 0, w: 200, h: 200 };
  assert.deepEqual(moveCrop(rect, 10, 10, bounds), { x: 30, y: 30, w: 100, h: 100 });
  assert.deepEqual(moveCrop(rect, -999, -999, bounds), { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(moveCrop(rect, 999, 999, bounds), { x: 100, y: 100, w: 100, h: 100 });
});

test('moving never resizes: the size out is the size in', () => {
  const bounds = { x: 0, y: 0, w: 50, h: 50 };
  // Deliberately larger than the bounds it is being clamped into.
  const moved = moveCrop({ x: 0, y: 0, w: 80, h: 80 }, 10, 10, bounds);
  assert.equal(moved.w, 80);
  assert.equal(moved.h, 80);
});

test('a crop inside a crop is clamped to the visible region, not to the image', () => {
  // Cropping twice: bounds are the first crop, so the second cannot reach back
  // out into pixels the first one removed.
  const bounds = { x: 100, y: 100, w: 200, h: 200 };
  const rect = { x: 150, y: 150, w: 100, h: 100 };
  assert.deepEqual(resizeCrop(rect, 'nw', { x: 0, y: 0 }, bounds), { x: 100, y: 100, w: 150, h: 150 });
});

test('a point on the boundary of a crop counts as inside it', () => {
  const rect = { x: 10, y: 10, w: 10, h: 10 };
  assert.equal(insideRect(rect, { x: 10, y: 10 }), true);
  assert.equal(insideRect(rect, { x: 20, y: 20 }), true);
  assert.equal(insideRect(rect, { x: 21, y: 15 }), false);
});

test('every handle names a cursor, and anywhere else is a move', () => {
  for (const id of CROP_HANDLES) assert.match(cropCursor(id), /-resize$/, id);
  assert.equal(cropCursor(null), 'move');
});
