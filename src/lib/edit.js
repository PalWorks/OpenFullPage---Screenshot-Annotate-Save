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

import {
  CORNERS,
  CORNERED_KINDS,
  cornerOf,
  outlineHit,
} from './geometry.js';

export { CORNERS, CORNERED_KINDS, cornerOf };

export const TOOLS = [
  'select',
  'arrow',
  'line',
  'rect',
  'rounded',
  'stadium',
  'ellipse',
  'rhombus',
  'hexagon',
  'parallelogram',
  'triangle',
  'cylinder',
  'callout',
  'loupe',
  'highlight',
  'pixelate',
  'text',
  'counter',
  'crop',
];

/**
 * The shapes behind the Shapes chevron, in the order the popover lists them.
 *
 * Derived from one list rather than repeated in the markup and in result.js,
 * because two hand maintained lists of fourteen shapes will drift. The groups are
 * the headings the popover draws.
 */
export const SHAPE_GROUPS = [
  ['Lines', ['arrow', 'line']],
  ['Boxes', ['rect', 'rounded', 'stadium', 'ellipse', 'callout', 'loupe', 'highlight']],
  ['Flowchart', ['rhombus', 'hexagon', 'parallelogram', 'triangle', 'cylinder']],
];

/**
 * Shape tools that draw a kind that already exists with one property set.
 *
 * The corner radius is a property of the Box rather than three separate tools
 * (D33), and after this it still is: both entries draw a `rect` and set its
 * corner, so the corner row in the Stroke popover goes on reading and writing
 * them and no saved shape gained a new kind. What changed is the way to one:
 * reaching a rounded box meant opening two popovers, and readers asked for the
 * shape they could see rather than the property they could not.
 */
export const TOOL_PRESETS = {
  rounded: { kind: 'rect', corner: CORNERS.rounded },
  stadium: { kind: 'rect', corner: CORNERS.pill },
};

/** What a tool actually draws. The same name, unless it is a preset. */
export const kindOfTool = (tool) => TOOL_PRESETS[tool]?.kind ?? tool;

export const SHAPE_TOOLS = SHAPE_GROUPS.flatMap(([, kinds]) => kinds);

/**
 * Box shapes that can carry a fill.
 *
 * A highlighter is already a fill, a redaction has to stay opaque to be a
 * redaction, and a loupe shows what is under it, so filling any of the three
 * would either do nothing or break the thing they exist for.
 */
export const FILLABLE_TOOLS = [
  'rect', 'rounded', 'stadium', 'ellipse', 'rhombus', 'hexagon',
  'parallelogram', 'triangle', 'cylinder', 'callout',
];

/** Tools whose shape is defined by a dragged box. */
export const BOX_TOOLS = [
  'rect', 'rounded', 'stadium', 'ellipse', 'rhombus', 'hexagon', 'parallelogram',
  'triangle', 'cylinder', 'callout', 'loupe', 'highlight', 'pixelate',
];
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

/**
 * How the lines of a text block sit relative to each other.
 *
 * Meaningless while the entry box held one line, which is why this was taken out
 * once and is back now that it holds many. `justify` spreads the words of every
 * line except the last across the width of the widest line, because a text block
 * drawn straight onto a screenshot has no column to justify to except itself.
 */
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'];

/** Line height as a multiple of the point size. Shared by drawing and measuring. */
export const TEXT_LINE_RATIO = 1.25;

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

/** The stroke colour of any shape, or null when it has none. */
export const strokeOf = (shape) => (isHex(shape.colour) ? shape.colour : null);

/**
 * The colour of the glyphs in a text shape.
 *
 * Its own property, because `colour` is the STROKE on every shape and for text
 * the stroke is the frame around it. Before this existed, `colour` meant the
 * glyphs on a text shape and the stroke on everything else, so choosing a
 * border colour with a caption selected silently recoloured the words.
 *
 * Not called `textColour`: that name is already a settings key, and the same
 * name meaning a stored setting at one layer and a shape property at another is
 * how a silent seeding bug gets written. `ink` is the glyphs, `colour` is the
 * frame, `fill` is the plate behind them.
 */
export const inkOf = (shape) => (isHex(shape.ink) ? shape.ink : strokeOf(shape) ?? '#18181b');

/**
 * The padding and corner radius of a text frame, both derived from the type
 * size rather than exposed as controls.
 *
 * A framed label has to look right at 12pt and at 96pt, and deriving both from
 * the size is what makes that happen without anyone touching a second control.
 * A padding slider is a control almost nobody moves.
 */
export const textPadding = (shape) => shape.size * 0.4;
export const textRadius = (shape) => shape.size * 0.35;

/**
 * Does this text shape have anything drawn around it?
 *
 * A frame is on when it has a colour and off when it does not, which is exactly
 * how a fill already works. That is the "enable and disable" without a switch to
 * explain: the border colour popover already has a no-colour state and the
 * button already carries a slash glyph for it.
 *
 * Fully transparent counts as off, and it has to. A caption's plate keeps its
 * colour while its opacity is zero, so that turning it on is one drag of a
 * slider rather than a hunt for a colour first. If a colour alone made a caption
 * framed, every caption would carry the frame's padding in its selection box,
 * its hover outline and its hit test while showing nothing at all.
 */
export const isFramedText = (shape) =>
  shape.kind === 'text'
  && ((strokeOf(shape) !== null && strokeAlphaOf(shape) > 0)
    || (fillOf(shape) !== null && fillAlphaOf(shape) > 0));

/** A stored opacity, clamped, or the default when the shape carries none. */
const alphaOr = (raw, fallback) =>
  (Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : fallback);

export const fillAlphaOf = (shape) => alphaOr(shape.fillOpacity, DEFAULT_FILL_OPACITY);

/**
 * The opacity of a stroke, and of the glyphs in a caption.
 *
 * Both default to 1, which is what every shape drawn before they existed had,
 * so an opacity nobody has touched is indistinguishable from one that was never
 * stored. That is the whole migration: no shape has to be converted, and a
 * capture annotated last week draws exactly as it did.
 *
 * A fill defaults to 0.35 instead, because a fill is drawn over the picture and
 * an opaque one hides what it is pointing at. A stroke is a line around
 * something, and a translucent line by default would just look like a mistake.
 */
export const strokeAlphaOf = (shape) => alphaOr(shape.strokeOpacity, 1);
export const inkAlphaOf = (shape) => alphaOr(shape.inkOpacity, 1);

/**
 * The colour controls, described once.
 *
 * There are five wells in the toolbar and they were five hand-written copies of
 * the same panel: a row of quick colours, a grid of shades, a system picker and
 * a hex field. Adding opacity to all of them would have made that five copies of
 * a bigger panel, which is exactly the shape of the bug D52 removed from the
 * output formats: three lists that could disagree in either direction with
 * nothing failing.
 *
 * So the panel is built from this table and the markup is checked against it.
 * `property` is the shape property the swatches write, `opacity` the one the
 * slider writes, and `none` says whether the well offers a no-colour state.
 *
 * Border and Frame write the same two properties on purpose. `colour` is the
 * stroke of every shape, and the stroke of a text shape is the frame around it,
 * so they are one property reached from two places rather than two properties
 * that have to be kept in step. Fill and Plate are the same pair again.
 */
export const PAINTS = {
  // A stroke has no no-colour state. Every shape that carries one is drawn with
  // it, and a box with neither stroke nor fill is a box nobody can see.
  border: { title: 'Border colour', property: 'colour', opacity: 'strokeOpacity', none: false },
  fill: { title: 'Fill colour', property: 'fill', opacity: 'fillOpacity', none: true },
  text: { title: 'Text colour', property: 'ink', opacity: 'inkOpacity', none: false },
  // The frame does have one, and it is how the frame is switched off. That is
  // the switch that used to sit beside it, moved into the control it was
  // describing.
  frame: { title: 'Frame colour', property: 'colour', opacity: 'strokeOpacity', none: true },
  // No "no plate" swatch. Off is nought per cent, and one way to say a thing is
  // invisible is enough: two would let the well and the slider disagree about
  // whether a plate is there.
  plate: { title: 'Plate colour', property: 'fill', opacity: 'fillOpacity', none: false },
};

export const PAINT_KINDS = Object.keys(PAINTS);

/** The resolved CSS font for a text shape, defaults included. */
export const alignOf = (shape) =>
  (TEXT_ALIGNS.includes(shape.align) ? shape.align : 'left');

/** The lines of a text shape, always at least one so callers need no guard. */
export const linesOf = (shape) => String(shape.text ?? '').split('\n');

/** The narrowest a caption may be set to, in image pixels. */
export const MIN_WRAP = 24;

/** The wrap width of a text shape, or 0 for a shape that has never been given one. */
export const wrapOf = (shape) =>
  (Number.isFinite(shape?.wrap) && shape.wrap >= MIN_WRAP ? shape.wrap : 0);

/**
 * Break one line into the lines it becomes at a given width.
 *
 * Word boundaries only, which is what breaking on anything else is called and is
 * not what a screenshot caption wants.
 *
 * Two cases are the whole reason this is a function with tests rather than three
 * lines inside the renderer.
 *
 * A word that exactly fills the width stays on its line: the comparison is
 * strictly greater, so equal fits. Off by one here shows up as a caption that
 * wraps one word early on some sizes and not others, which reads as a rendering
 * fault rather than a rule.
 *
 * A single word wider than the width cannot be broken at all, and must be
 * allowed to overflow. Anything that instead tries again with a smaller
 * remainder never terminates, because there is no smaller remainder to try.
 *
 * @param {string} line
 * @param {number} width in image pixels
 * @param {(text: string) => number} measure the width of a string in this font
 */
export function wrapLine(line, width, measure) {
  if (!(width > 0)) return [line];

  const words = String(line).split(' ');
  const out = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    // `current === ''` is the guard that makes an unbreakable word terminate:
    // with nothing on the line yet there is nothing to push, so the long word is
    // taken and overflows rather than being reconsidered for ever.
    if (current !== '' && measure(candidate) > width) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  out.push(current);
  return out;
}

/**
 * The lines a text shape actually draws: its own, then broken to its width.
 *
 * A shape with no wrap returns its own lines untouched, which is every caption
 * written before this existed. That is the migration, and there is nothing else
 * to it: `wrap` is optional and its absence means what it always meant.
 */
export function wrappedLinesOf(shape, measure) {
  const width = wrapOf(shape);
  const lines = linesOf(shape);
  if (!width) return lines;
  return lines.flatMap((line) => wrapLine(line, width, measure));
}

/**
 * Measure a text shape into `w` and `h`.
 *
 * The stored box is what hit testing, the selection outline and the resize
 * handles all read, so it has to be recomputed whenever the words, the size or
 * anything about the type changes. `measure` is a function that returns the width
 * of a string in the shape's own font, which is `ctx.measureText` in the browser
 * and anything at all in a test.
 *
 * @param {object} shape
 * @param {(line: string) => number} measure
 */
export function measureText(shape, measure) {
  const lines = wrappedLinesOf(shape, measure);
  const width = wrapOf(shape);
  return {
    // A caption that has been given a width is that width, even when the words
    // inside it come up short. That is what makes the two side handles stay
    // where they were put rather than springing back to the longest line.
    w: width || Math.max(0, ...lines.map((line) => measure(line))),
    h: lines.length * shape.size * TEXT_LINE_RATIO,
  };
}

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
    present: { shapes: [], crop: null, selection: [] },
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
  return commit(doc, { shapes: [], crop: null, selection: [] });
}

export const isEdited = (doc) => doc.present.shapes.length > 0 || doc.present.crop !== null;

/** The visible window onto the original image. */
export function effectiveCrop(doc) {
  return doc.present.crop ?? { x: 0, y: 0, w: doc.width, h: doc.height };
}

// SELECTION
//
// `present.selection` is a list of ids, because a selection of one is just the
// common case of a selection of several. Order is the order they were added and
// carries no meaning; z-order stays the order of the shapes array.
//
// Nothing is persisted between sessions except style keys, and a document lives
// only for the life of one result tab, so there is no stored format to migrate.

export const selectedIds = (doc) => doc.present.selection ?? [];

/** Every selected shape, in z-order rather than selection order. */
export const selectedShapes = (doc) =>
  doc.present.shapes.filter((s) => selectedIds(doc).includes(s.id));

/**
 * The one selected shape, or null when it is not exactly one.
 *
 * Kept as its own function because most callers genuinely mean "the single
 * thing being edited": the handles, the resize, the text box, the style
 * swatches. Returning null for a multi-selection is what lets those keep
 * working unchanged rather than each growing a length check.
 */
export const selectedShape = (doc) => {
  const ids = selectedIds(doc);
  if (ids.length !== 1) return null;
  return doc.present.shapes.find((s) => s.id === ids[0]) ?? null;
};

export const isSelected = (doc, id) => selectedIds(doc).includes(id);

/** Shift click semantics: in the set becomes out of it, and the reverse. */
export const toggleSelected = (selection, id) =>
  (selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);

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

/**
 * The cursor a handle should show, by handle id.
 *
 * Shared by the crop region and by shape selection, because they use the same
 * handle ids and mean the same thing by them. The double headed arrow points
 * along the axis the handle actually moves, which is the whole information the
 * cursor carries: `nwse-resize` on a corner says this corner travels diagonally,
 * and getting the diagonal backwards is worse than showing nothing.
 *
 * Anything not in the map, which is the two endpoints of a line, falls back to
 * `move`: an endpoint is not constrained to an axis, it goes wherever it is put.
 */
const HANDLE_CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

export const handleCursor = (handleId) => HANDLE_CURSORS[handleId] ?? 'move';

/** The crop region's handles use the same map. Kept as its own name for callers. */
export const cropCursor = handleCursor;

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
  // Text is measured when it is created and re-measured on every restyle, because
  // the box cannot be derived here: only a canvas knows how wide a string is.
  const glyphs = glyphBoxOf(shape);
  if (!isFramedText(shape)) return glyphs;
  // A framed caption is visibly bigger than its words by the padding, and the
  // selection outline, the hover outline, hit testing and the export all have
  // to agree with what is on screen.
  const pad = textPadding(shape);
  return { x: glyphs.x - pad, y: glyphs.y - pad, w: glyphs.w + pad * 2, h: glyphs.h + pad * 2 };
}

/**
 * The block the glyphs themselves occupy, without any frame padding.
 *
 * Separate from `boundsOf` on purpose. `resizeText` solves for a new type size
 * from the ratio between the box it is given and the box it wants, and the
 * padding is itself a function of the size being solved for. Feeding it the
 * padded box makes the first frame of a drag wrong, so it gets this one.
 */
export function glyphBoxOf(shape) {
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

/**
 * Is the point on this shape?
 *
 * `tolerance` is required and is in pixels of the original capture. It is not
 * optional and it has no default on purpose. Chrome is divided by the screen
 * scale (DECISIONS.md D19) precisely because a fixed count of image pixels is a
 * different distance under the pointer at every display scale: on a capture
 * shown at 12%, four image pixels of slop is less than half a screen pixel, and
 * selection stops working. A default here would be correct at 100% zoom and
 * quietly useless on exactly the long captures this extension exists to take,
 * so the caller has to convert from screen space and say what it means.
 *
 * Passing `undefined` compares against NaN, which is false everywhere. That is
 * the intended behaviour: a caller that forgot the tolerance selects nothing,
 * which is obvious, rather than selecting slightly wrongly, which is not.
 */
export function hits(shape, point, tolerance) {
  if (LINE_TOOLS.includes(shape.kind)) {
    return distanceToSegment(point, shape.from, shape.to) <= shape.width / 2 + tolerance;
  }
  if (shape.kind === 'counter') {
    return Math.hypot(point.x - shape.at.x, point.y - shape.at.y) <= shape.radius + tolerance;
  }
  // Text is a run of glyphs, not an outline: its box is the thing you click.
  if (shape.kind === 'text') {
    const box = boundsOf(shape);
    return (
      point.x >= box.x - tolerance &&
      point.x <= box.x + box.w + tolerance &&
      point.y >= box.y - tolerance &&
      point.y <= box.y + box.h + tolerance
    );
  }
  // Everything else has an outline in the geometry table, so the empty corner
  // of a rhombus is a miss and clicking inside an unfilled box is a hit.
  return outlineHit(shape.kind, boundsOf(shape), point, tolerance, shape);
}

/** Topmost shape under the point, later shapes are drawn over earlier ones. */
export function shapeAt(shapes, point, tolerance) {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (hits(shapes[i], point, tolerance)) return shapes[i];
  }
  return null;
}

/** The corner handles, in the order the crop region already uses them. */
export const CORNER_HANDLES = ['nw', 'ne', 'se', 'sw'];
/** The four edge midpoints, which only a box shape gets. */
export const EDGE_HANDLES = ['n', 'e', 's', 'w'];

/**
 * Draggable handles.
 *
 * Boxes get eight, the four corners and the four edge midpoints, which is what
 * the crop region has always had and what makes it possible to change one edge
 * without touching the other three.
 *
 * `minEdge` is in image pixels and is required for the same reason `tolerance`
 * is on `hits`: eight handles on a shape that is thirty screen pixels wide is
 * four overlapping targets, and whether a shape is small is a fact about the
 * screen, not about the image. Below it the midpoints are dropped and the
 * corners stay, so a small shape is still resizable, just less finely.
 *
 * Text keeps its four corners only. Dragging a corner scales the type, and an
 * edge handle would have to stretch the glyphs, which type editors never do.
 * A numbered step is a fixed radius circle, so a handle would have nothing to
 * change.
 */
export function handlesFor(shape, minEdge) {
  if (LINE_TOOLS.includes(shape.kind)) {
    return [
      { id: 'from', x: shape.from.x, y: shape.from.y },
      { id: 'to', x: shape.to.x, y: shape.to.y },
    ];
  }
  if (shape.kind === 'counter') return [];

  const b = boundsOf(shape);
  const right = b.x + b.w;
  const bottom = b.y + b.h;
  const midX = b.x + b.w / 2;
  const midY = b.y + b.h / 2;
  const corners = [
    { id: 'nw', x: b.x, y: b.y },
    { id: 'ne', x: right, y: b.y },
    { id: 'se', x: right, y: bottom },
    { id: 'sw', x: b.x, y: bottom },
  ];
  // A caption gets its two side midpoints and never the top and bottom ones.
  // The height of a caption is not a thing anyone sets: it is the line count
  // times the line height, and a handle that claimed to change it would be
  // lying about what it did. The sides set the width the words wrap inside,
  // which is the shape of it in every type tool there has ever been.
  if (shape.kind === 'text') {
    return corners.concat([
      { id: 'e', x: right, y: midY },
      { id: 'w', x: b.x, y: midY },
    ]);
  }
  if (!(Math.min(b.w, b.h) >= minEdge)) return corners;
  return corners.concat([
    { id: 'n', x: midX, y: b.y },
    { id: 'e', x: right, y: midY },
    { id: 's', x: midX, y: bottom },
    { id: 'w', x: b.x, y: midY },
  ]);
}

/** The handle under the pointer. Takes the same `minEdge` as `handlesFor`, so
    the two can never disagree about which handles exist. */
export function handleAt(shape, point, tolerance, minEdge) {
  for (const handle of handlesFor(shape, minEdge)) {
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

/**
 * Drag a handle to a new position. Boxes may be dragged inside out.
 *
 * A corner moves two edges, an edge midpoint moves exactly one and leaves the
 * other three where they were. That is the whole point of the midpoints: today
 * making a box shorter without also making it narrower means dragging a corner
 * and then dragging it back.
 */
export function resizeShape(shape, handleId, point) {
  if (handleId === 'from') return { ...shape, from: point };
  if (handleId === 'to') return { ...shape, to: point };

  const b = boundsOf(shape);

  if (shape.kind === 'text') {
    // The two side handles set the width the words wrap inside. They are the
    // only edge handles a caption has, and they change no glyph: the type stays
    // the size it was and the block grows downwards instead.
    if (handleId === 'e' || handleId === 'w') return rewrapText(shape, handleId, point);
    // A corner still scales the type. An edge handle that set one axis of a
    // glyph would be stretching it, which is a thing bitmap editors do and type
    // editors never do, so the top and bottom handles do not exist.
    if (!CORNER_HANDLES.includes(handleId)) return shape;
    // From the glyph box, never the padded one. See glyphBoxOf.
    const g = glyphBoxOf(shape);
    const anchor = {
      nw: { x: g.x + g.w, y: g.y + g.h },
      ne: { x: g.x, y: g.y + g.h },
      sw: { x: g.x + g.w, y: g.y },
      se: { x: g.x, y: g.y },
    }[handleId];
    return resizeText(shape, handleId, point, g, anchor);
  }

  if (!CORNER_HANDLES.includes(handleId) && !EDGE_HANDLES.includes(handleId)) return shape;

  let left = b.x;
  let top = b.y;
  let right = b.x + b.w;
  let bottom = b.y + b.h;
  if (handleId.includes('w')) left = point.x;
  if (handleId.includes('e')) right = point.x;
  if (handleId.includes('n')) top = point.y;
  if (handleId.includes('s')) bottom = point.y;

  return { ...shape, rect: normalizeRect({ x: left, y: top }, { x: right, y: bottom }) };
}

/**
 * Set the width a caption's words wrap inside, by dragging one of its sides.
 *
 * The opposite side stays where it is, which is what a handle means. Dragging
 * the west one therefore moves `at`, and dragging the east one does not, exactly
 * as the corners already behave.
 *
 * `w` is set here so that the frame and the selection outline are right during
 * the drag. The height is not: only a canvas can say how many lines the words
 * take at the new width, so the caller re-measures, and every caller already
 * does because that has been true of every restyle since text became a shape.
 */
function rewrapText(shape, handleId, point) {
  const g = glyphBoxOf(shape);
  const right = g.x + g.w;
  const wrap = Math.max(MIN_WRAP, handleId === 'e' ? point.x - g.x : right - point.x);
  return {
    ...shape,
    wrap,
    w: wrap,
    at: { x: handleId === 'w' ? right - wrap : g.x, y: g.y },
  };
}

/**
 * Scale text by dragging a corner.
 *
 * Text is not a box, it is a point and a font size, so a corner drag cannot set
 * two dimensions independently: stretching a glyph is a thing image editors do to
 * bitmaps and type editors never do to type. The drag therefore sets one number,
 * the point size, from whichever axis moved further in proportion. The corner
 * opposite the one being dragged stays put, which is the behaviour a person
 * expects from a handle.
 *
 * The caller re-measures afterwards, because only a canvas knows the new width.
 * `w` and `h` are scaled here so that a caller which cannot measure, and a frame
 * drawn mid-drag, both still have a box that is about right.
 */
function resizeText(shape, handleId, point, bounds, anchor) {
  if (!(bounds.w > 0) || !(bounds.h > 0)) return shape;

  const wanted = normalizeRect(anchor, point);
  // The larger of the two ratios, so the type follows the corner rather than
  // lagging behind whichever axis the pointer happened to move less on.
  const factor = Math.max(wanted.w / bounds.w, wanted.h / bounds.h);
  const size = Math.round(clampSize(shape.size * factor));
  if (size === shape.size) return shape;

  const scale = size / shape.size;
  const w = bounds.w * scale;
  const h = bounds.h * scale;
  // Anchor the corner opposite the handle. `at` is the top left of the block, so
  // dragging a west handle moves it and dragging an east one does not.
  const west = handleId === 'nw' || handleId === 'sw';
  const north = handleId === 'nw' || handleId === 'ne';
  return {
    ...shape,
    size,
    w,
    h,
    at: {
      x: west ? bounds.x + bounds.w - w : bounds.x,
      y: north ? bounds.y + bounds.h - h : bounds.y,
    },
  };
}

const clampSize = (size) => Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size));

export function replaceShape(present, shape) {
  return { ...present, shapes: present.shapes.map((s) => (s.id === shape.id ? shape : s)) };
}

export function removeShapes(present, ids) {
  const gone = new Set(ids);
  return {
    ...present,
    shapes: present.shapes.filter((s) => !gone.has(s.id)),
    selection: (present.selection ?? []).filter((id) => !gone.has(id)),
  };
}

export const removeShape = (present, id) => removeShapes(present, [id]);

/** Do two axis-aligned boxes overlap at all? */
export const rectsOverlap = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * The shapes a marquee catches.
 *
 * Intersect, not contain. Requiring full enclosure means a marquee that clips
 * the edge of the thing you were dragging around selects nothing, and people
 * reliably clip the edge.
 */
export function shapesInMarquee(shapes, rect) {
  // A marquee with no area is a click, not a sweep, and a click is answered by
  // hit testing the shape itself. Without this guard a click anywhere inside a
  // rhombus's bounding box selects it through the marquee, including the empty
  // corners that the geometry table exists to exclude, which quietly puts back
  // the bounding box selection this release removed.
  if (!(rect.w >= MIN_DRAG || rect.h >= MIN_DRAG)) return [];
  return shapes.filter((s) => rectsOverlap(boundsOf(s), rect)).map((s) => s.id);
}

/** Move several shapes by the same offset, leaving the rest untouched. */
export function moveShapes(present, ids, dx, dy) {
  const moving = new Set(ids);
  return {
    ...present,
    shapes: present.shapes.map((s) => (moving.has(s.id) ? moveShape(s, dx, dy) : s)),
  };
}

/**
 * The four ways to move a selection through the paint order.
 *
 * Shapes are drawn in array order, so the last one in the list is the one on
 * top. There has never been a way to change that order, which meant a box drawn
 * after a highlighter covered it for good and the only repair was to delete
 * both and draw them again.
 *
 * A whole selection moves as a block and keeps its own internal order, which is
 * the behaviour every drawing tool has: `front` and `back` lift the selection
 * out and put it back at one end, and `forward` and `backward` walk the list
 * from the end they are heading towards so a member never leapfrogs another
 * member of the same selection.
 *
 * Returns the present unchanged when nothing can move, so a caller can compare
 * and skip the undo step rather than asking a second question first.
 *
 * @param {object} present
 * @param {string[]} ids
 * @param {'front'|'back'|'forward'|'backward'} where
 */
export function reorderShapes(present, ids, where) {
  const moving = new Set(ids);
  const shapes = present.shapes;
  // Nothing selected, or everything selected: in both cases the order the
  // shapes are in relative to each other is the only order there is.
  if (moving.size === 0 || moving.size >= shapes.length) return present;

  if (where === 'front' || where === 'back') {
    const picked = shapes.filter((s) => moving.has(s.id));
    const rest = shapes.filter((s) => !moving.has(s.id));
    return { ...present, shapes: where === 'front' ? [...rest, ...picked] : [...picked, ...rest] };
  }

  const next = [...shapes];
  if (where === 'forward') {
    // From the top down. Going the other way would move a shape up and then
    // meet it again on the next step, carrying it to the front in one press.
    for (let i = next.length - 2; i >= 0; i -= 1) {
      if (!moving.has(next[i].id) || moving.has(next[i + 1].id)) continue;
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
    }
  } else if (where === 'backward') {
    for (let i = 1; i < next.length; i += 1) {
      if (!moving.has(next[i].id) || moving.has(next[i - 1].id)) continue;
      [next[i], next[i - 1]] = [next[i - 1], next[i]];
    }
  } else {
    return present;
  }
  return { ...present, shapes: next };
}

/** Did a reorder actually change anything? */
export const wouldReorder = (present, ids, where) => {
  const next = reorderShapes(present, ids, where);
  return next.shapes.some((shape, i) => shape !== present.shapes[i]);
};

/** Counters number themselves in the order they were placed. */
export function nextCounterNumber(shapes) {
  return shapes.filter((s) => s.kind === 'counter').length + 1;
}
