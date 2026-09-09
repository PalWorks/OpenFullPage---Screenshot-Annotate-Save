// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The editing model. Pure functions, no canvas and no DOM, so the parts that
// are easy to get subtly wrong are unit tested rather than eyeballed.
//
// Shapes are live objects, not committed strokes: once drawn, a shape can be
// selected, moved, resized, restyled and deleted, which is the convention across
// general purpose annotation tools and what people already expect from one
// tool. That is why history is a stack of whole snapshots rather than a list of
// draw commands, moving and resizing are edits to existing objects, and
// snapshots make undo uniform across every kind of change.
//
// Every coordinate is in pixels of the *original* capture, never of the cropped
// view, so cropping twice, or cropping and undoing, moves nothing.

export const TOOLS = [
  'select',
  'arrow',
  'line',
  'rect',
  'ellipse',
  'highlight',
  'pixelate',
  'text',
  'counter',
  'crop',
];

/** Tools whose shape is defined by a dragged box. */
export const BOX_TOOLS = ['rect', 'ellipse', 'highlight', 'pixelate'];
/** Tools whose shape is defined by two endpoints. */
export const LINE_TOOLS = ['arrow', 'line'];
/** Tools that place something at a single point. */
export const POINT_TOOLS = ['text', 'counter'];

// STYLE
//
// Every key below is optional on a shape. A shape saved before these existed
// renders exactly as it did, which is why each reader has a default rather than
// the shapes being migrated.

export const DASH_STYLES = ['solid', 'dashed', 'dotted'];
/** Which ends of a line carry an arrowhead. */
export const LINE_ENDS = ['none', 'start', 'end', 'both'];
/**
 * Font stacks that resolve without a network request. A webfont would be a
 * remote subresource, which the CSP forbids and the project's first rule bans,
 * so the choice is between families the operating system already has.
 */
export const TEXT_FAMILIES = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  sans: 'Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

export const DEFAULT_FILL_OPACITY = 0.35;
export const MIN_STROKE = 1;
export const MAX_STROKE = 64;
export const MIN_TEXT_SIZE = 8;
export const MAX_TEXT_SIZE = 200;

const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export const dashOf = (shape) =>
  (DASH_STYLES.includes(shape.dash) ? shape.dash : 'solid');

/**
 * Arrow and line are one shape drawn two ways. The tool a user picked only sets
 * the default ending, so an existing arrow keeps its head and an existing line
 * keeps its bare ends without either being rewritten.
 */
export function endsOf(shape) {
  if (LINE_ENDS.includes(shape.ends)) return shape.ends;
  return shape.kind === 'arrow' ? 'end' : 'none';
}

export const hasEnd = (shape, which) => {
  const ends = endsOf(shape);
  return ends === which || ends === 'both';
};

/** Dash lengths scale with the stroke, so a thick dashed line still reads. */
export function dashPattern(style, width) {
  const w = Math.max(1, width);
  if (style === 'dashed') return [w * 2.6, w * 2];
  if (style === 'dotted') return [0.01, w * 2];
  return [];
}

/** The fill colour of a box shape, or null when it is an outline. */
export const fillOf = (shape) => (isHex(shape.fill) ? shape.fill : null);

export function fillAlphaOf(shape) {
  const raw = shape.fillOpacity;
  if (!Number.isFinite(raw)) return DEFAULT_FILL_OPACITY;
  return Math.min(1, Math.max(0, raw));
}

/** The resolved CSS font for a text shape, defaults included. */
export function fontOf(shape) {
  const family = TEXT_FAMILIES[shape.family] ?? TEXT_FAMILIES.system;
  const weight = shape.bold === false ? '400' : '600';
  const style = shape.italic === true ? 'italic ' : '';
  return `${style}${weight} ${shape.size}px ${family}`;
}

const HISTORY_LIMIT = 60;

export function createDocument(width, height) {
  return {
    width,
    height,
    past: [],
    present: { shapes: [], crop: null, selected: null },
    future: [],
  };
}

/** Record a new state, making the previous one undoable. */
export function commit(doc, present) {
  return {
    ...doc,
    past: [...doc.past, doc.present].slice(-HISTORY_LIMIT),
    present,
    future: [],
  };
}

/** Change the present without touching history, used for live selection. */
export function amend(doc, present) {
  return { ...doc, present };
}

export const canUndo = (doc) => doc.past.length > 0;
export const canRedo = (doc) => doc.future.length > 0;

export function undo(doc) {
  if (!canUndo(doc)) return doc;
  return {
    ...doc,
    past: doc.past.slice(0, -1),
    present: doc.past.at(-1),
    future: [doc.present, ...doc.future],
  };
}

export function redo(doc) {
  if (!canRedo(doc)) return doc;
  return {
    ...doc,
    past: [...doc.past, doc.present],
    present: doc.future[0],
    future: doc.future.slice(1),
  };
}

export function reset(doc) {
  return commit(doc, { shapes: [], crop: null, selected: null });
}

export const isEdited = (doc) => doc.present.shapes.length > 0 || doc.present.crop !== null;

/** The visible window onto the original image. */
export function effectiveCrop(doc) {
  return doc.present.crop ?? { x: 0, y: 0, w: doc.width, h: doc.height };
}

export const selectedShape = (doc) =>
  doc.present.shapes.find((s) => s.id === doc.present.selected) ?? null;

// GEOMETRY

export function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function clampRect(rect, bounds) {
  const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.w));
  const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.h));
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(Math.min(rect.w, bounds.x + bounds.w - x)),
    h: Math.round(Math.min(rect.h, bounds.y + bounds.h - y)),
  };
}

export const MIN_CROP = 12;

// CROP GEOMETRY
//
// A crop is not a shape. It has no colour, it is never in the shapes list, and
// exactly one can exist at a time, so it gets its own small set of functions
// rather than being bent into the shape model. They are here, with the rest of
// the arithmetic, because this is where the tests are: an off-by-one in a resize
// is invisible on screen and permanent in the saved file.

/** Corners first, then edge midpoints. The order the handles are drawn in. */
export const CROP_HANDLES = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'];

const CROP_CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

export const cropCursor = (handleId) => CROP_CURSORS[handleId] ?? 'move';

export function cropHandlesFor(rect) {
  const midX = rect.x + rect.w / 2;
  const midY = rect.y + rect.h / 2;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  return [
    { id: 'nw', x: rect.x, y: rect.y },
    { id: 'ne', x: right, y: rect.y },
    { id: 'se', x: right, y: bottom },
    { id: 'sw', x: rect.x, y: bottom },
    { id: 'n', x: midX, y: rect.y },
    { id: 'e', x: right, y: midY },
    { id: 's', x: midX, y: bottom },
    { id: 'w', x: rect.x, y: midY },
  ];
}

/** The handle under the pointer, corners winning over edges where they overlap. */
export function cropHandleAt(rect, point, tolerance) {
  for (const handle of cropHandlesFor(rect)) {
    if (Math.abs(point.x - handle.x) <= tolerance && Math.abs(point.y - handle.y) <= tolerance) {
      return handle.id;
    }
  }
  return null;
}

export const insideRect = (rect, point) =>
  point.x >= rect.x && point.x <= rect.x + rect.w &&
  point.y >= rect.y && point.y <= rect.y + rect.h;

const between = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Drag one handle.
 *
 * Only the edges that handle owns move, the rest stay put, and nothing leaves
 * `bounds` or crosses its opposite edge. Edges clamp rather than flip: a crop
 * that turns inside out when you drag past the far side is a party trick, and
 * every time it happens by accident the user has lost their rectangle.
 */
export function resizeCrop(rect, handleId, point, bounds, min = MIN_CROP) {
  const lowX = bounds.x;
  const highX = bounds.x + bounds.w;
  const lowY = bounds.y;
  const highY = bounds.y + bounds.h;

  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;

  if (handleId.includes('w')) left = between(point.x, lowX, right - min);
  if (handleId.includes('e')) right = between(point.x, left + min, highX);
  if (handleId.includes('n')) top = between(point.y, lowY, bottom - min);
  if (handleId.includes('s')) bottom = between(point.y, top + min, highY);

  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  };
}

/** Slide the whole rectangle, keeping every edge inside `bounds`. */
export function moveCrop(rect, dx, dy, bounds) {
  const x = between(rect.x + dx, bounds.x, bounds.x + bounds.w - rect.w);
  const y = between(rect.y + dy, bounds.y, bounds.y + bounds.h - rect.h);
  return { x: Math.round(x), y: Math.round(y), w: rect.w, h: rect.h };
}

export const MIN_DRAG = 4;

export const isUsableCrop = (rect) => rect.w >= MIN_CROP && rect.h >= MIN_CROP;
export const isUsableDrag = (a, b) => Math.hypot(b.x - a.x, b.y - a.y) >= MIN_DRAG;

/** Hold Shift to constrain: squares for boxes, 45° steps for lines. */
export function constrain(from, to, kind) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  if (BOX_TOOLS.includes(kind)) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: from.x + Math.sign(dx) * size, y: from.y + Math.sign(dy) * size };
  }

  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const length = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

export function arrowGeometry(from, to, width) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) return { shaft: [from, from], head: [to, to, to], length: 0 };

  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.min(Math.max(width * 3.5, 12), length);
  const half = headLength * 0.42;

  const baseX = to.x - ux * headLength;
  const baseY = to.y - uy * headLength;

  return {
    shaft: [from, { x: baseX, y: baseY }],
    head: [
      { x: baseX - uy * half, y: baseY + ux * half },
      { x: baseX + uy * half, y: baseY - ux * half },
      to,
    ],
    length,
  };
}

// SHAPES

let nextId = 1;
export const newId = () => `s${nextId++}`;

/** The axis-aligned box a shape occupies, used for hit testing and handles. */
export function boundsOf(shape) {
  if (shape.rect) return { ...shape.rect };
  if (shape.from && shape.to) return normalizeRect(shape.from, shape.to);
  if (shape.kind === 'counter') {
    const r = shape.radius;
    return { x: shape.at.x - r, y: shape.at.y - r, w: r * 2, h: r * 2 };
  }
  // Text is measured when it is created; without that we cannot know its box.
  return { x: shape.at.x, y: shape.at.y, w: shape.w ?? 0, h: shape.h ?? 0 };
}

const distanceToSegment = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

export function hits(shape, point) {
  if (LINE_TOOLS.includes(shape.kind)) {
    return distanceToSegment(point, shape.from, shape.to) <= Math.max(shape.width * 2, 10);
  }
  const box = boundsOf(shape);
  const pad = shape.kind === 'counter' ? 0 : 4;
  return (
    point.x >= box.x - pad &&
    point.x <= box.x + box.w + pad &&
    point.y >= box.y - pad &&
    point.y <= box.y + box.h + pad
  );
}

/** Topmost shape under the point, later shapes are drawn over earlier ones. */
export function shapeAt(shapes, point) {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (hits(shapes[i], point)) return shapes[i];
  }
  return null;
}

/** Draggable handles. Lines get their endpoints; boxes get their corners. */
export function handlesFor(shape) {
  if (LINE_TOOLS.includes(shape.kind)) {
    return [
      { id: 'from', x: shape.from.x, y: shape.from.y },
      { id: 'to', x: shape.to.x, y: shape.to.y },
    ];
  }
  if (POINT_TOOLS.includes(shape.kind)) return [];

  const b = boundsOf(shape);
  return [
    { id: 'nw', x: b.x, y: b.y },
    { id: 'ne', x: b.x + b.w, y: b.y },
    { id: 'sw', x: b.x, y: b.y + b.h },
    { id: 'se', x: b.x + b.w, y: b.y + b.h },
  ];
}

export function handleAt(shape, point, tolerance) {
  for (const handle of handlesFor(shape)) {
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= tolerance) return handle.id;
  }
  return null;
}

export function moveShape(shape, dx, dy) {
  const moved = { ...shape };
  if (shape.rect) moved.rect = { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy };
  if (shape.from) moved.from = { x: shape.from.x + dx, y: shape.from.y + dy };
  if (shape.to) moved.to = { x: shape.to.x + dx, y: shape.to.y + dy };
  if (shape.at) moved.at = { x: shape.at.x + dx, y: shape.at.y + dy };
  return moved;
}

/** Drag a handle to a new position. Boxes may be dragged inside out. */
export function resizeShape(shape, handleId, point) {
  if (handleId === 'from') return { ...shape, from: point };
  if (handleId === 'to') return { ...shape, to: point };

  const b = boundsOf(shape);
  const anchor = {
    nw: { x: b.x + b.w, y: b.y + b.h },
    ne: { x: b.x, y: b.y + b.h },
    sw: { x: b.x + b.w, y: b.y },
    se: { x: b.x, y: b.y },
  }[handleId];
  if (!anchor) return shape;

  return { ...shape, rect: normalizeRect(anchor, point) };
}

export function replaceShape(present, shape) {
  return { ...present, shapes: present.shapes.map((s) => (s.id === shape.id ? shape : s)) };
}

export function removeShape(present, id) {
  return {
    ...present,
    shapes: present.shapes.filter((s) => s.id !== id),
    selected: present.selected === id ? null : present.selected,
  };
}

/** Counters number themselves in the order they were placed. */
export function nextCounterNumber(shapes) {
  return shapes.filter((s) => s.kind === 'counter').length + 1;
}
