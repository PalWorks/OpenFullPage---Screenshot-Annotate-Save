// SPDX-License-Identifier: GPL-3.0-only
//
// The editing model. Shapes are live objects that can be selected, moved,
// resized and deleted, so the risky parts are hit testing, handle maths and
// undo across all of those, not just across drawing.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CROP_HANDLES,
  DEFAULT_FILL_OPACITY,
  MIN_WRAP,
  PAINTS,
  PAINT_KINDS,
  MAX_TEXT_SIZE,
  MIN_CROP,
  MIN_TEXT_SIZE,
  TEXT_ALIGNS,
  TEXT_LINE_RATIO,
  alignOf,
  linesOf,
  wrapLine,
  wrapOf,
  wrappedLinesOf,
  measureText,
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
  glyphBoxOf,
  handleAt,
  handlesFor,
  fillAlphaOf,
  inkAlphaOf,
  inkOf,
  strokeAlphaOf,
  isFramedText,
  strokeOf,
  textPadding,
  textRadius,
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
  moveShapes,
  removeShapes,
  selectedIds,
  selectedShape,
  selectedShapes,
  shapesInMarquee,
  toggleSelected,
  shapeAt,
  undo,
  reorderShapes,
  wouldReorder,
} from '../src/lib/edit.js';

const doc = () => createDocument(1000, 4000);
const box = (id, x, y, w = 100, h = 60) => ({
  id, kind: 'rect', rect: { x, y, w, h }, colour: '#ef4444', width: 4,
});
const arrow = (id, ax, ay, bx, by) => ({
  id, kind: 'arrow', from: { x: ax, y: ay }, to: { x: bx, y: by }, colour: '#ef4444', width: 4,
});
const withShapes = (...shapes) => commit(doc(), { shapes, crop: null, selection: [] });

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
  d = amend(d, { ...d.present, selection: ['a'] });
  d = amend(d, { ...d.present, selection: [] });
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
  assert.equal(shapeAt([under, over], { x: 60, y: 60 }, 4).id, 'over');
  assert.equal(shapeAt([under, over], { x: 10, y: 10 }, 4).id, 'under');
  assert.equal(shapeAt([under, over], { x: 900, y: 900 }, 4), null);
});

test('a thin line is still clickable near it, not only exactly on it', () => {
  const line = arrow('a', 0, 0, 200, 0);
  assert.ok(hits(line, { x: 100, y: 4 }, 9));
  assert.ok(!hits(line, { x: 100, y: 60 }, 9));
  // Past the end of the segment, not just off its axis.
  assert.ok(!hits(line, { x: 400, y: 0 }, 9));
});

test('hit testing has no default tolerance, because there is no safe one', () => {
  // DECISIONS.md D19: chrome is divided by the screen scale because a fixed
  // count of image pixels is a different distance under the pointer at every
  // display scale. A default here would work at 100% and fail on a capture
  // shown at 12%, which is the case this extension exists for. A caller that
  // forgets selects nothing, which is visible, instead of selecting almost
  // right, which is not.
  const line = arrow('a', 0, 0, 200, 0);
  assert.equal(hits(line, { x: 100, y: 4 }, undefined), false);
  assert.equal(hits(box('a', 0, 0, 100, 60), { x: 104, y: 30 }, undefined), false);
  // The tolerance genuinely scales: what misses at 2 hits at 40.
  assert.equal(hits(box('a', 0, 0, 100, 60), { x: 130, y: 30 }, 2), false);
  assert.equal(hits(box('a', 0, 0, 100, 60), { x: 130, y: 30 }, 40), true);
});

test('a click inside an unfilled shape selects it, and the empty corner does not', () => {
  // The rhombus is the reason the geometry table exists: a bounding box test
  // says its empty corner is a hit, and every user who clicks there disagrees.
  const rhombus = { ...box('a', 0, 0, 200, 200), kind: 'rhombus' };
  assert.ok(hits(rhombus, { x: 100, y: 100 }, 4), 'centre should hit');
  assert.equal(hits(rhombus, { x: 4, y: 4 }, 4), false, 'empty corner should miss');
  // A rectangle of the same bounds does take the corner, so this is testing the
  // shape and not just an unreachable point.
  assert.ok(hits(box('a', 0, 0, 200, 200), { x: 4, y: 4 }, 4));
});

test('a counter is a circle, not the square it sits in', () => {
  const counter = {
    id: 'c', kind: 'counter', at: { x: 100, y: 100 }, radius: 20, colour: '#ef4444', width: 4,
  };
  assert.ok(hits(counter, { x: 100, y: 100 }, 0));
  assert.ok(hits(counter, { x: 118, y: 100 }, 0));
  // The corner of its bounding box is outside the circle by about 8 pixels.
  assert.equal(hits(counter, { x: 84, y: 84 }, 0), false);
});

// TEXT FRAME
//
// A framed caption is a box with type in it, built out of controls that already
// exist: the border colour is the frame, the fill is the plate, the stroke width
// and dash reach both. The only new property is `ink`, the glyph colour, which
// exists because `colour` is the stroke on every other shape and text was the
// one exception.

const caption = (extra = {}) => ({
  id: 't', kind: 'text', at: { x: 100, y: 50 }, w: 200, h: 40,
  text: 'hello', size: 20, width: 4, ink: '#18181b', ...extra,
});

test('a caption is framed by having a colour, not by a switch', () => {
  assert.equal(isFramedText(caption()), false);
  assert.equal(isFramedText(caption({ colour: '#ef4444' })), true);
  // A plate with no border is still a frame as far as the bounds are concerned,
  // because there is still something drawn around the words.
  assert.equal(isFramedText(caption({ fill: '#ef4444' })), true);
  // Turning it off is picking no colour, exactly how a fill already works.
  assert.equal(isFramedText(caption({ colour: null, fill: null })), false);
  assert.equal(isFramedText(caption({ colour: 'not a colour' })), false);
});

test('a framed caption is bigger than its words, an unframed one is not', () => {
  const plain = caption();
  assert.deepEqual(boundsOf(plain), { x: 100, y: 50, w: 200, h: 40 });

  const framed = caption({ colour: '#ef4444' });
  const pad = textPadding(framed);
  assert.ok(pad > 0);
  assert.deepEqual(boundsOf(framed), {
    x: 100 - pad, y: 50 - pad, w: 200 + pad * 2, h: 40 + pad * 2,
  });
  // Everything that has to agree with what is drawn reads boundsOf: the
  // selection outline, the hover outline, hit testing and the export.
  assert.ok(hits(framed, { x: 100 - pad + 1, y: 50 - pad + 1 }, 0));
  assert.equal(hits(plain, { x: 100 - pad + 1, y: 50 - pad + 1 }, 0), false);
});

test('clearing the frame colour returns the caption to its own size', () => {
  const framed = caption({ colour: '#ef4444' });
  const cleared = { ...framed, colour: null };
  assert.deepEqual(boundsOf(cleared), glyphBoxOf(cleared));
});

test('padding and radius scale with the type, so no one has to set them', () => {
  const small = caption({ size: 10 });
  const large = caption({ size: 40 });
  assert.ok(textPadding(large) > textPadding(small));
  assert.equal(textPadding(large) / textPadding(small), 4);
  assert.equal(textRadius(large) / textRadius(small), 4);
});

test('scaling a framed caption solves from the words, not from the padding', () => {
  // The landmine this guards: padding is a function of the size being solved
  // for, so scaling from the padded box feeds the answer back into the
  // question. resizeText reads glyphBoxOf, which never includes padding.
  const framed = caption({ colour: '#ef4444' });
  const plain = caption();
  const drag = { x: 500, y: 170 };
  assert.equal(
    resizeShape(framed, 'se', drag).size,
    resizeShape(plain, 'se', drag).size,
    'a frame must not change how far a corner drag scales the type',
  );
});

test('ink is the glyphs and colour is the frame, on every shape the same way', () => {
  // The bug this closes: `colour` used to mean the glyphs on a text shape and
  // the stroke on everything else, so picking a border colour with a caption
  // selected silently recoloured the words.
  const framed = caption({ ink: '#00ff00', colour: '#ef4444' });
  assert.equal(inkOf(framed), '#00ff00');
  assert.equal(strokeOf(framed), '#ef4444');
  // A shape saved before `ink` existed still reads: it falls back to colour.
  assert.equal(inkOf({ kind: 'text', colour: '#123456' }), '#123456');
  // And a text shape with neither is legible rather than invisible.
  assert.equal(inkOf({ kind: 'text' }), '#18181b');
  assert.equal(strokeOf({ kind: 'text' }), null);
});

test('moving a shape shifts every part of it', () => {
  assert.deepEqual(moveShape(box('a', 10, 20), 5, 7).rect, { x: 15, y: 27, w: 100, h: 60 });

  const moved = moveShape(arrow('a', 0, 0, 10, 10), 3, 4);
  assert.deepEqual(moved.from, { x: 3, y: 4 });
  assert.deepEqual(moved.to, { x: 13, y: 14 });
});

test('a box has eight handles, a line has its two ends', () => {
  assert.deepEqual(
    handlesFor(box('a', 0, 0, 100, 60), 40).map((h) => h.id),
    ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'],
  );
  assert.deepEqual(handlesFor(arrow('a', 1, 2, 3, 4), 40).map((h) => h.id), ['from', 'to']);
});

test('a shape too small for eight handles keeps its corners and drops the midpoints', () => {
  // Whether a shape is small is a fact about the screen, so the caller passes
  // the threshold in image pixels. The same 100 by 60 box is roomy at one
  // display scale and cramped at another, and only the corners survive.
  const small = box('a', 0, 0, 100, 60);
  assert.deepEqual(handlesFor(small, 61).map((h) => h.id), ['nw', 'ne', 'se', 'sw']);
  assert.deepEqual(handlesFor(small, 60).map((h) => h.id).length, 8);
  // It is the short side that decides, not the long one.
  assert.deepEqual(handlesFor(box('a', 0, 0, 900, 10), 40).map((h) => h.id), ['nw', 'ne', 'se', 'sw']);
});

test('text gets four corners and two sides, never a top or a bottom', () => {
  // The sides set the width the words wrap inside. There is no top or bottom
  // handle because the height of a caption is not a thing anyone sets: it is the
  // line count times the line height, and a handle claiming to change it would
  // be lying about what it did. F43, D60.
  const text = {
    id: 't', kind: 'text', at: { x: 0, y: 0 }, w: 400, h: 300, text: 'hello',
    size: 24, colour: '#18181b', width: 4,
  };
  const ids = handlesFor(text, 1).map((h) => h.id);
  assert.deepEqual(ids, ['nw', 'ne', 'se', 'sw', 'e', 'w']);
  assert.ok(!ids.includes('n') && !ids.includes('s'), 'a caption has no top or bottom handle');

  // And they are offered however small it is: the sides are how a caption is
  // given a width in the first place, so they cannot wait for it to be roomy.
  assert.deepEqual(handlesFor({ ...text, w: 8, h: 8 }, 200).map((h) => h.id), ids);
});

test('handleAt and handlesFor agree about which handles exist', () => {
  // Two functions deciding separately is how you get a handle you can see and
  // cannot grab, so they take the same threshold and one calls the other.
  const shape = box('a', 0, 0, 100, 60);
  for (const minEdge of [10, 60, 61, 200]) {
    for (const handle of handlesFor(shape, minEdge)) {
      assert.equal(handleAt(shape, { x: handle.x, y: handle.y }, 6, minEdge), handle.id);
    }
  }
  // The midpoint is not grabbable once it is not offered.
  assert.equal(handleAt(shape, { x: 50, y: 0 }, 6, 61), null);
  assert.equal(handleAt(shape, { x: 50, y: 0 }, 6, 60), 'n');
});

test('an edge handle moves one edge and leaves the other three alone', () => {
  const start = box('a', 10, 20, 100, 60);
  assert.deepEqual(resizeShape(start, 'n', { x: 999, y: 0 }).rect, { x: 10, y: 0, w: 100, h: 80 });
  assert.deepEqual(resizeShape(start, 's', { x: 999, y: 200 }).rect, { x: 10, y: 20, w: 100, h: 180 });
  assert.deepEqual(resizeShape(start, 'e', { x: 200, y: 999 }).rect, { x: 10, y: 20, w: 190, h: 60 });
  assert.deepEqual(resizeShape(start, 'w', { x: 0, y: 999 }).rect, { x: 0, y: 20, w: 110, h: 60 });
});

test('a side handle sets the wrap and never the type size', () => {
  const text = {
    id: 't', kind: 'text', at: { x: 0, y: 0 }, w: 100, h: 30, text: 'hello',
    size: 24, colour: '#18181b', width: 4,
  };
  const wider = resizeShape(text, 'e', { x: 400, y: 0 });
  assert.equal(wider.wrap, 400);
  assert.equal(wider.size, text.size, 'the type must not change size when the width does');
  assert.deepEqual(wider.at, text.at, 'dragging the east side leaves the west edge alone');

  // A corner still scales the type, which is the other half of the same rule.
  assert.notEqual(resizeShape(text, 'se', { x: 400, y: 120 }).size, text.size);

  // A top or bottom handle is still refused. handlesFor does not offer one, so
  // this is the second lock on the same door.
  assert.equal(resizeShape(text, 'n', { x: 0, y: -50 }), text);
  assert.equal(resizeShape(text, 's', { x: 0, y: 400 }), text);
});

test('dragging the west side moves the block and keeps its right edge', () => {
  const text = {
    id: 't', kind: 'text', at: { x: 100, y: 50 }, w: 200, h: 30, text: 'hello',
    size: 24, colour: '#18181b', width: 4,
  };
  // The right edge is at 300. Dragging the west handle to 150 leaves it there.
  const narrower = resizeShape(text, 'w', { x: 150, y: 50 });
  assert.equal(narrower.wrap, 150);
  assert.equal(narrower.at.x, 150);
  assert.equal(narrower.at.x + narrower.wrap, 300, 'the side that was not dragged moved');
});

test('a caption cannot be dragged narrower than a word', () => {
  const text = {
    id: 't', kind: 'text', at: { x: 0, y: 0 }, w: 200, h: 30, text: 'hello',
    size: 24, colour: '#18181b', width: 4,
  };
  // Past the opposite edge, which is what a fast drag does.
  assert.equal(resizeShape(text, 'e', { x: -500, y: 0 }).wrap, MIN_WRAP);
  assert.equal(resizeShape(text, 'w', { x: 5000, y: 0 }).wrap, MIN_WRAP);
});

test('handles are only picked up when the pointer is near them', () => {
  const shape = box('a', 0, 0, 100, 60);
  assert.equal(handleAt(shape, { x: 100, y: 60 }, 10, 40), 'se');
  assert.equal(handleAt(shape, { x: 50, y: 30 }, 10, 40), null);
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
  const present = { shapes: [box('a', 0, 0), box('b', 5, 5)], crop: null, selection: ['b'] };
  const next = removeShape(present, 'b');
  assert.deepEqual(next.shapes.map((s) => s.id), ['a']);
  assert.deepEqual(next.selection, []);
});

test('selectedShape returns null rather than throwing when nothing is selected', () => {
  assert.equal(selectedShape(withShapes(box('a', 0, 0))), null);
  const d = amend(withShapes(box('a', 0, 0)), { shapes: [box('a', 0, 0)], crop: null, selection: ['a'] });
  assert.equal(selectedShape(d).id, 'a');
});

// MULTI-SELECT
//
// A selection of one is the common case of a selection of several, so the model
// holds a list of ids and `selectedShape` is the convenience that returns the
// single one. Everything that genuinely means "the one thing being edited", the
// handles and the resize and the text box, keeps reading that.

const selectionOf = (...ids) => (d) =>
  amend(d, { ...d.present, selection: ids });

test('selectedShape is null for a set, and selectedShapes is the set', () => {
  const d = selectionOf('a', 'b')(withShapes(box('a', 0, 0), box('b', 300, 300)));
  assert.equal(selectedShape(d), null, 'a set has no single selected shape');
  assert.deepEqual(selectedShapes(d).map((s) => s.id), ['a', 'b']);
  assert.deepEqual(selectedIds(d), ['a', 'b']);

  const one = selectionOf('b')(withShapes(box('a', 0, 0), box('b', 300, 300)));
  assert.equal(selectedShape(one).id, 'b');
});

test('selectedShapes comes back in z-order, not in the order they were clicked', () => {
  // The order shapes were added to the selection carries no meaning, and the
  // order they are drawn in does, so anything iterating the set gets that one.
  const d = selectionOf('b', 'a')(withShapes(box('a', 0, 0), box('b', 300, 300)));
  assert.deepEqual(selectedShapes(d).map((s) => s.id), ['a', 'b']);
});

test('shift clicking adds and removes', () => {
  assert.deepEqual(toggleSelected([], 'a'), ['a']);
  assert.deepEqual(toggleSelected(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleSelected(['a', 'b'], 'a'), ['b']);
});

test('a marquee catches what it touches, not only what it swallows whole', () => {
  // Containment would mean that clipping the edge of the thing you dragged
  // around selects nothing, and people reliably clip the edge.
  const shapes = [box('a', 0, 0, 100, 100), box('b', 400, 400, 100, 100)];
  assert.deepEqual(shapesInMarquee(shapes, { x: 50, y: 50, w: 100, h: 100 }), ['a']);
  assert.deepEqual(shapesInMarquee(shapes, { x: 0, y: 0, w: 600, h: 600 }), ['a', 'b']);
  assert.deepEqual(shapesInMarquee(shapes, { x: 900, y: 900, w: 10, h: 10 }), []);

  // A click is not a marquee. This has to be checked from INSIDE a shape's
  // bounding box, not from its corner: a zero area rectangle at the corner
  // misses for the trivial reason that nothing overlaps a zero width edge, and
  // a test that passes for that reason proves nothing. From the middle of the
  // box it would catch the shape, which is bounding box selection returning
  // through the back door.
  assert.deepEqual(shapesInMarquee(shapes, { x: 50, y: 50, w: 0, h: 0 }), []);
  assert.deepEqual(shapesInMarquee(shapes, { x: 50, y: 50, w: 1, h: 1 }), []);
  // And a real sweep from the same point still works.
  assert.deepEqual(shapesInMarquee(shapes, { x: 50, y: 50, w: 40, h: 40 }), ['a']);
});

test('moving a set moves every member by the same amount and nothing else', () => {
  const present = {
    shapes: [box('a', 0, 0), box('b', 300, 300), box('c', 600, 600)],
    crop: null,
    selection: ['a', 'c'],
  };
  const moved = moveShapes(present, ['a', 'c'], 10, 20);
  assert.deepEqual(moved.shapes.map((s) => s.rect.x), [10, 300, 610]);
  assert.deepEqual(moved.shapes.map((s) => s.rect.y), [20, 300, 620]);
});

test('deleting a set is one step and leaves nothing selected', () => {
  let d = withShapes(box('a', 0, 0), box('b', 300, 300), box('c', 600, 600));
  d = selectionOf('a', 'c')(d);
  const before = d.past.length;
  d = commit(d, removeShapes(d.present, selectedIds(d)));
  assert.deepEqual(d.present.shapes.map((s) => s.id), ['b']);
  assert.deepEqual(d.present.selection, []);
  assert.equal(d.past.length, before + 1, 'deleting two shapes is one undo step, not two');
  assert.deepEqual(undo(d).present.shapes.map((s) => s.id), ['a', 'b', 'c']);
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

// TEXT
//
// Text is the one shape that is a point plus a font rather than a box, so every
// piece of geometry around it is a special case: the box has to be measured
// rather than derived, and a corner drag has to become a point size.

// A stand-in for ctx.measureText. Six pixels a character is nothing like a real
// font, and it does not need to be: what is under test is what the model does
// with the widths, not what the widths are.
const fakeMeasure = (line) => line.length * 6;

const someText = (over = {}) => ({
  id: 't1', kind: 'text', at: { x: 100, y: 50 }, text: 'Hello', size: 20,
  colour: '#ef4444', w: 30, h: 25, ...over,
});

test('alignment falls back to left, and only the four we can draw are kept', () => {
  for (const align of TEXT_ALIGNS) assert.equal(alignOf({ align }), align);
  for (const junk of ['start', 'end', 'JUSTIFY', '', null, undefined, 7]) {
    assert.equal(alignOf({ align: junk }), 'left', String(junk));
  }
});

test('a text shape always has at least one line, whatever it holds', () => {
  assert.deepEqual(linesOf({ text: 'one\ntwo' }), ['one', 'two']);
  assert.deepEqual(linesOf({ text: '' }), ['']);
  assert.deepEqual(linesOf({}), ['']);
});

test('a text box is as wide as its widest line and as tall as all of them', () => {
  const shape = someText({ text: 'ab\nabcdef\nabc', size: 20 });
  const box = measureText(shape, fakeMeasure);
  assert.equal(box.w, 36, 'the widest line, not the last one and not the sum');
  assert.equal(box.h, 3 * 20 * TEXT_LINE_RATIO);
});

test('text carries resize handles and a numbered step does not', () => {
  // Bundling the two point tools together is what left text with no handles at
  // all, so this asserts they are treated separately.
  assert.equal(handlesFor(someText()).length, 6);
  assert.equal(handlesFor({ kind: 'counter', at: { x: 0, y: 0 }, radius: 12 }).length, 0);
});

test('dragging a text corner changes the point size, never the aspect', () => {
  const shape = someText({ w: 100, h: 25, size: 20 });
  // The south east corner is at (200, 75). Drag it to double the width.
  const bigger = resizeShape(shape, 'se', { x: 300, y: 75 });
  assert.equal(bigger.size, 40, 'the size follows the axis that moved further');
  assert.equal(bigger.w / bigger.h, shape.w / shape.h, 'the block keeps its proportions');
});

test('scaling text anchors the corner opposite the one being dragged', () => {
  const shape = someText({ at: { x: 100, y: 50 }, w: 100, h: 25, size: 20 });

  // Dragging the south east corner leaves the north west one where it was.
  const se = resizeShape(shape, 'se', { x: 300, y: 75 });
  assert.deepEqual(se.at, { x: 100, y: 50 });

  // Dragging the north west corner moves the origin instead, so the south east
  // corner stays put: 200, 75 before and after.
  const nw = resizeShape(shape, 'nw', { x: 0, y: 50 });
  assert.equal(Math.round(nw.at.x + nw.w), 200);
  assert.equal(Math.round(nw.at.y + nw.h), 75);
});

test('text cannot be scaled outside the size the inspector allows', () => {
  const shape = someText({ w: 100, h: 25, size: 20 });
  assert.equal(resizeShape(shape, 'se', { x: 100000, y: 75 }).size, MAX_TEXT_SIZE);
  assert.equal(resizeShape(shape, 'se', { x: 100.5, y: 50.5 }).size, MIN_TEXT_SIZE);
});

test('a text shape with no measured box is left alone by a resize', () => {
  // It cannot be scaled by a ratio of its own width when that width is zero, and
  // returning NaN here would put the shape beyond recovery.
  const shape = someText({ w: 0, h: 0 });
  assert.deepEqual(resizeShape(shape, 'se', { x: 300, y: 75 }), shape);
});

test('undo puts back the size a text shape had before it was scaled', () => {
  let doc = createDocument(800, 600);
  const shape = someText({ w: 100, h: 25 });
  doc = commit(doc, { ...doc.present, shapes: [shape], selection: [shape.id] });
  doc = commit(doc, replaceShape(doc.present, resizeShape(shape, 'se', { x: 300, y: 75 })));
  assert.equal(doc.present.shapes[0].size, 40);
  assert.equal(undo(doc).present.shapes[0].size, 20);
});


// THE PAINT ORDER
//
// Shapes are drawn in array order, so the last one is on top. Every case below
// is one a reader can produce with two clicks, and the ones with a block of
// several selected are the ones a naive loop gets wrong: a single pass in the
// wrong direction carries a shape to the front in one press, and a pass that
// does not check its neighbour lets one member of a selection leapfrog another.

const ordered = (...ids) => ({ shapes: ids.map((id) => ({ id })), selection: [] });
const idsOf = (present) => present.shapes.map((s) => s.id);

test('one shape moves one step through the paint order', () => {
  const present = ordered('a', 'b', 'c');
  assert.deepEqual(idsOf(reorderShapes(present, ['a'], 'forward')), ['b', 'a', 'c']);
  assert.deepEqual(idsOf(reorderShapes(present, ['c'], 'backward')), ['a', 'c', 'b']);
});

test('front and back move a shape all the way, in one step', () => {
  const present = ordered('a', 'b', 'c');
  assert.deepEqual(idsOf(reorderShapes(present, ['a'], 'front')), ['b', 'c', 'a']);
  assert.deepEqual(idsOf(reorderShapes(present, ['c'], 'back')), ['c', 'a', 'b']);
});

test('a shape already at one end does not move, and says so', () => {
  const present = ordered('a', 'b', 'c');
  for (const [id, where] of [['c', 'forward'], ['c', 'front'], ['a', 'backward'], ['a', 'back']]) {
    assert.deepEqual(idsOf(reorderShapes(present, [id], where)), ['a', 'b', 'c'], where);
    assert.equal(wouldReorder(present, [id], where), false, where);
  }
});

test('a selection moves as a block and keeps its own order', () => {
  // The bug this exists to catch: stepping through the list in the wrong
  // direction moves `a` up, meets it again at the next index, and carries it to
  // the front in a single press.
  const present = ordered('a', 'b', 'c', 'd');
  assert.deepEqual(idsOf(reorderShapes(present, ['a', 'b'], 'forward')), ['c', 'a', 'b', 'd']);
  assert.deepEqual(idsOf(reorderShapes(present, ['c', 'd'], 'backward')), ['a', 'c', 'd', 'b']);
});

test('a block already at the top is blocked by its own members, not by nothing', () => {
  // `b` cannot move because `c` is selected too, and `c` cannot move because it
  // is at the top. Without the neighbour check `b` would jump over `c`.
  const present = ordered('a', 'b', 'c');
  assert.deepEqual(idsOf(reorderShapes(present, ['b', 'c'], 'forward')), ['a', 'b', 'c']);
  assert.equal(wouldReorder(present, ['b', 'c'], 'forward'), false);
  assert.equal(wouldReorder(present, ['b', 'c'], 'backward'), true);
});

test('front and back keep the selection in the order it was drawn', () => {
  const present = ordered('a', 'b', 'c', 'd');
  assert.deepEqual(idsOf(reorderShapes(present, ['a', 'c'], 'front')), ['b', 'd', 'a', 'c']);
  assert.deepEqual(idsOf(reorderShapes(present, ['b', 'd'], 'back')), ['b', 'd', 'a', 'c']);
});

test('reordering nothing, or everything, changes nothing', () => {
  const present = ordered('a', 'b', 'c');
  for (const ids of [[], ['a', 'b', 'c']]) {
    for (const where of ['front', 'back', 'forward', 'backward']) {
      assert.deepEqual(idsOf(reorderShapes(present, ids, where)), ['a', 'b', 'c']);
      assert.equal(wouldReorder(present, ids, where), false);
    }
  }
});

test('a reorder leaves every other part of the document alone', () => {
  const present = { ...ordered('a', 'b'), selection: ['a'], crop: { x: 1, y: 2, w: 3, h: 4 } };
  const next = reorderShapes(present, ['a'], 'front');
  assert.deepEqual(next.selection, ['a']);
  assert.deepEqual(next.crop, present.crop);
  assert.equal(next.shapes.length, 2);
});

test('an unknown direction is refused rather than guessed at', () => {
  const present = ordered('a', 'b');
  assert.equal(reorderShapes(present, ['a'], 'sideways'), present);
});

// OPACITY
//
// Three properties, one rule: a shape that has never been given one draws
// exactly as it did before they existed. That is the whole migration, and it is
// the thing worth a test, because the alternative is every capture annotated
// before today opening slightly wrong.

test('a shape with no opacity of its own is fully opaque', () => {
  assert.equal(strokeAlphaOf({}), 1);
  assert.equal(inkAlphaOf({}), 1);
  // A fill is the exception, and stays where it was: it sits over the thing it
  // is pointing at, so it starts translucent.
  assert.equal(fillAlphaOf({}), DEFAULT_FILL_OPACITY);
});

test('a stored opacity is clamped rather than trusted', () => {
  for (const [given, want] of [[0, 0], [0.5, 0.5], [1, 1], [-3, 0], [9, 1]]) {
    assert.equal(strokeAlphaOf({ strokeOpacity: given }), want, `stroke ${given}`);
    assert.equal(inkAlphaOf({ inkOpacity: given }), want, `ink ${given}`);
    assert.equal(fillAlphaOf({ fillOpacity: given }), want, `fill ${given}`);
  }
  // Anything that is not a number is not an opacity, and falls back rather than
  // becoming NaN and painting nothing at all.
  for (const junk of [null, undefined, '0.5', {}, NaN, Infinity]) {
    assert.equal(strokeAlphaOf({ strokeOpacity: junk }), 1, String(junk));
  }
});

test('a caption is framed only when something would actually be drawn', () => {
  // The plate keeps its colour at nought per cent so that one drag brings it
  // back. If a colour alone counted, every plain caption would carry the frame's
  // padding in its selection box, its hover outline and its hit test while
  // showing nothing, which is a shape you cannot click where you can see it.
  assert.equal(isFramedText({ kind: 'text' }), false);
  assert.equal(isFramedText({ kind: 'text', fill: '#ffffff', fillOpacity: 0 }), false);
  assert.equal(isFramedText({ kind: 'text', colour: '#ef4444', strokeOpacity: 0 }), false);
  assert.equal(isFramedText({ kind: 'text', fill: '#ffffff', fillOpacity: 0.4 }), true);
  assert.equal(isFramedText({ kind: 'text', colour: '#ef4444' }), true);
  // And it is still only ever true for a caption.
  assert.equal(isFramedText({ kind: 'rect', colour: '#ef4444' }), false);
});

test('every colour popover writes a property and an opacity, and says if it can be none', () => {
  for (const kind of PAINT_KINDS) {
    const paint = PAINTS[kind];
    assert.ok(paint.property, `${kind} writes nothing`);
    assert.ok(paint.opacity, `${kind} has no opacity`);
    assert.equal(typeof paint.none, 'boolean', `${kind} does not say`);
    assert.ok(paint.title.length > 0, `${kind} has no title`);
  }
  // Border and Frame are one property reached from two places, and so are Fill
  // and Plate. If that ever stops being true they are two properties that have
  // to be kept in step by hand, which is the thing this table exists to avoid.
  assert.equal(PAINTS.border.property, PAINTS.frame.property);
  assert.equal(PAINTS.fill.property, PAINTS.plate.property);
});

// WRAPPING
//
// F43. The breaking is pure and takes its measurer as an argument precisely so
// it can be tested without a canvas, and the two cases worth testing are the two
// that a renderer written inline would get wrong: a word that exactly fills the
// width, and a word that cannot fit at all.

// Ten pixels a character, so a width is a character count and the arithmetic in
// these tests is readable.
const ten = (text) => text.length * 10;

test('a caption breaks on word boundaries at the width it was given', () => {
  assert.deepEqual(wrapLine('one two three four', 100, ten), ['one two', 'three four']);
  assert.deepEqual(wrapLine('one two three four', 1000, ten), ['one two three four']);
});

test('a word that exactly fills the width stays on its line', () => {
  // The comparison has to be strictly greater. Off by one here is a caption that
  // wraps a word early at some sizes and not others, which reads as a rendering
  // fault rather than as a rule.
  assert.deepEqual(wrapLine('abcde fghij', 50, ten), ['abcde', 'fghij']);
  assert.deepEqual(wrapLine('abcde', 50, ten), ['abcde']);
  assert.deepEqual(wrapLine('abcdef', 50, ten), ['abcdef'], 'and one over still cannot be broken');
});

test('a word wider than the whole width overflows rather than looping', () => {
  // There is no smaller remainder to try, so anything that tries again never
  // terminates. It takes its own line and hangs over the edge.
  assert.deepEqual(wrapLine('supercalifragilistic ok', 50, ten), ['supercalifragilistic', 'ok']);
  assert.deepEqual(wrapLine('supercalifragilistic', 50, ten), ['supercalifragilistic']);
});

test('no width means no wrapping, which is every caption written before this', () => {
  assert.deepEqual(wrapLine('one two three', 0, ten), ['one two three']);
  assert.deepEqual(wrappedLinesOf({ text: 'one two three' }, ten), ['one two three']);
  // Below the floor is not a width either, so a stored nonsense value cannot
  // turn a caption into one word per line.
  assert.equal(wrapOf({ wrap: MIN_WRAP - 1 }), 0);
  assert.equal(wrapOf({ wrap: MIN_WRAP }), MIN_WRAP);
  for (const junk of [null, undefined, '100', NaN, Infinity, -5]) {
    assert.equal(wrapOf({ wrap: junk }), 0, String(junk));
  }
});

test('the newlines someone typed survive the wrapping', () => {
  // A wrap is a display width. It never edits what was typed, so a hard line
  // break stays a hard line break and is then broken again if it is too long.
  const shape = { text: 'one two\nthree four five', wrap: 100 };
  // "three four" is ten characters, so exactly a hundred wide, so it fits.
  assert.deepEqual(wrappedLinesOf(shape, ten), ['one two', 'three four', 'five']);
  const empty = { text: 'a\n\nb', wrap: 100 };
  assert.deepEqual(wrappedLinesOf(empty, ten), ['a', '', 'b'], 'a blank line is a line');
});

test('a caption that was given a width measures as that width', () => {
  // Not as its longest line. Otherwise the side handles spring back the moment
  // the words come up short, and the box a reader set moves on its own.
  const shape = { text: 'hi', wrap: 200, size: 20 };
  assert.equal(measureText(shape, ten).w, 200);
  // And the height follows the lines, which is what makes the height not a thing
  // anyone drags.
  const two = { text: 'one two three four', wrap: 100, size: 20 };
  assert.equal(measureText(two, ten).h, 2 * 20 * TEXT_LINE_RATIO);
  const four = { text: 'one two three four', wrap: 40, size: 20 };
  assert.equal(measureText(four, ten).h, 4 * 20 * TEXT_LINE_RATIO);
});
