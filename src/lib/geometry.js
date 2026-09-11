// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// One outline vocabulary for every closed shape.
//
// The problem this solves: a shape has to be drawn on a canvas, hit tested
// against a pointer, and outlined when it is selected. Write those three
// separately and they drift, which is how you get a rhombus you can select by
// clicking the empty corner of its bounding box.
//
// So a shape is described once, here, as a list of path operations. Two readers
// consume that list and nothing else describes the shape:
//
//   - `src/ui/editor.js` replays the ops onto a 2D context, so a curve is a real
//     curve on screen and in the exported file.
//   - `flatten()` below turns the same ops into a polygon, so hit testing is
//     point in polygon and distance to polygon, with no canvas anywhere near it.
//     That is what makes this file unit testable.
//
// Operations, each a plain array so they are trivially comparable in a test:
//   ['M', x, y]                                  move
//   ['L', x, y]                                  line
//   ['A', cx, cy, rx, ry, from, to, anticlock]   elliptical arc, radians
//   ['Z']                                        close
//
// Canvas angles run clockwise with y pointing down, so PI/2 is the BOTTOM of an
// ellipse and 3PI/2 is the top. Getting that backwards draws a cylinder with no
// lid, which is a mistake this file has already made once.

/** Corner radius presets for the Box. `pill` is clamped to half the short side. */
export const CORNERS = { square: 0, rounded: 12, pill: 9999 };
export const CORNER_NAMES = Object.keys(CORNERS);

/**
 * The corner radius of a shape, in image pixels.
 *
 * Deliberately not `shape.radius`: a counter already owns that key for its own
 * circle, and overloading it would make a numbered step round its corners.
 */
export function cornerOf(shape) {
  const raw = shape?.corner;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

/** How many segments a full circle is flattened into. */
const ARC_SEGMENTS = 64;

const clampRadius = (r, w, h) => Math.max(0, Math.min(r, w / 2, h / 2));

// THE TABLE
//
// Every entry takes a rect and returns ops. `decorations` is for strokes that
// belong to the picture but not to the outline: the seam across a cylinder's
// lid, the handle on a loupe. They are drawn and never hit tested, because a
// pointer near a loupe's handle is not inside the loupe.

const rectOps = (x, y, w, h, radius) => {
  const r = clampRadius(radius, w, h);
  if (r <= 0) {
    return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  }
  const right = x + w;
  const bottom = y + h;
  return [
    ['M', x + r, y],
    ['L', right - r, y],
    ['A', right - r, y + r, r, r, -Math.PI / 2, 0, false],
    ['L', right, bottom - r],
    ['A', right - r, bottom - r, r, r, 0, Math.PI / 2, false],
    ['L', x + r, bottom],
    ['A', x + r, bottom - r, r, r, Math.PI / 2, Math.PI, false],
    ['L', x, y + r],
    ['A', x + r, y + r, r, r, Math.PI, Math.PI * 1.5, false],
    ['Z'],
  ];
};

const polygon = (points) => [
  ['M', points[0][0], points[0][1]],
  ...points.slice(1).map(([px, py]) => ['L', px, py]),
  ['Z'],
];

/** The lid height of a cylinder, clamped so an extreme rect cannot invert it. */
const lidOf = (w, h) => Math.max(1, Math.min(h * 0.16, w * 0.5, h / 2));

export const SHAPE_GEOMETRY = {
  rect: {
    corners: true,
    outline: ({ x, y, w, h }, shape) => rectOps(x, y, w, h, cornerOf(shape)),
  },
  highlight: { outline: ({ x, y, w, h }) => rectOps(x, y, w, h, 0) },
  pixelate: { outline: ({ x, y, w, h }) => rectOps(x, y, w, h, 0) },

  ellipse: {
    outline: ({ x, y, w, h }) => [
      ['A', x + w / 2, y + h / 2, Math.max(w / 2, 0.5), Math.max(h / 2, 0.5), 0, Math.PI * 2, false],
      ['Z'],
    ],
  },

  rhombus: {
    outline: ({ x, y, w, h }) => polygon([
      [x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2],
    ]),
  },

  triangle: {
    outline: ({ x, y, w, h }) => polygon([[x + w / 2, y], [x + w, y + h], [x, y + h]]),
  },

  hexagon: {
    // The point inset is a quarter of the width, clamped at half so a very wide
    // shape stays a hexagon and a very narrow one degenerates to a rhombus
    // rather than turning itself inside out.
    outline: ({ x, y, w, h }) => {
      const i = Math.min(w * 0.25, w / 2);
      return polygon([
        [x + i, y], [x + w - i, y], [x + w, y + h / 2],
        [x + w - i, y + h], [x + i, y + h], [x, y + h / 2],
      ]);
    },
  },

  parallelogram: {
    outline: ({ x, y, w, h }) => {
      const i = Math.min(w * 0.26, w / 2);
      return polygon([[x + i, y], [x + w, y], [x + w - i, y + h], [x, y + h]]);
    },
  },

  cylinder: {
    outline: ({ x, y, w, h }) => {
      const lid = lidOf(w, h);
      const rx = w / 2;
      const cx = x + rx;
      return [
        ['M', x, y + lid],
        // PI to 2PI passes through 3PI/2, which is the top. The other direction
        // sweeps the bottom and leaves the cylinder open at the top.
        ['A', cx, y + lid, rx, lid, Math.PI, Math.PI * 2, false],
        ['L', x + w, y + h - lid],
        ['A', cx, y + h - lid, rx, lid, 0, Math.PI, false],
        ['Z'],
      ];
    },
    // The front half of the lid. Without it the silhouette is a rounded blob:
    // this single arc is what makes a cylinder read as a cylinder.
    decorations: ({ x, y, w, h }) => {
      const lid = lidOf(w, h);
      return [[['A', x + w / 2, y + lid, w / 2, lid, 0, Math.PI, false]]];
    },
  },

  callout: {
    outline: ({ x, y, w, h }) => {
      const body = Math.max(h * 0.74, 1);
      const r = clampRadius(12, w, body);
      const right = x + w;
      const foot = y + body;
      // The tail hangs from the lower left, which is where a speech bubble's
      // tail sits when the thing being pointed at is the text under it.
      const tailR = x + w * 0.42;
      const tailL = x + w * 0.24;
      const tip = x + w * 0.18;
      return [
        ['M', x + r, y],
        ['L', right - r, y],
        ['A', right - r, y + r, r, r, -Math.PI / 2, 0, false],
        ['L', right, foot - r],
        ['A', right - r, foot - r, r, r, 0, Math.PI / 2, false],
        ['L', tailR, foot],
        ['L', tip, y + h],
        ['L', tailL, foot],
        ['L', x + r, foot],
        ['A', x + r, foot - r, r, r, Math.PI / 2, Math.PI, false],
        ['L', x, y + r],
        ['A', x + r, y + r, r, r, Math.PI, Math.PI * 1.5, false],
        ['Z'],
      ];
    },
  },

  loupe: {
    // A circle inscribed in the rect, so a loupe is always round however the
    // drag was shaped. Magnification is the editor's business; the outline is
    // the ring, and the handle is decoration so a pointer beside it misses.
    outline: ({ x, y, w, h }) => {
      const r = Math.max(Math.min(w, h) / 2, 0.5);
      return [['A', x + w / 2, y + h / 2, r, r, 0, Math.PI * 2, false], ['Z']];
    },
    decorations: ({ x, y, w, h }) => {
      const r = Math.max(Math.min(w, h) / 2, 0.5);
      const cx = x + w / 2;
      const cy = y + h / 2;
      const a = Math.PI / 4;
      const reach = Math.max(r * 0.5, 6);
      return [[
        ['M', cx + Math.cos(a) * r, cy + Math.sin(a) * r],
        ['L', cx + Math.cos(a) * (r + reach), cy + Math.sin(a) * (r + reach)],
      ]];
    },
  },
};

/** Kinds this table can describe. */
export const GEOMETRY_KINDS = Object.keys(SHAPE_GEOMETRY);

/** Kinds whose corner radius means something. */
export const CORNERED_KINDS = GEOMETRY_KINDS.filter((k) => SHAPE_GEOMETRY[k].corners);

export const hasGeometry = (kind) => Object.hasOwn(SHAPE_GEOMETRY, kind);

/**
 * The ops for a shape, or null when the kind has no closed outline.
 *
 * `rect` here is passed separately rather than read off the shape, so a caller
 * mid-drag can ask for the outline of a rectangle that is not committed yet.
 */
export function outlineOps(kind, rect, shape = null) {
  const entry = SHAPE_GEOMETRY[kind];
  if (!entry) return null;
  const safe = {
    x: rect.x,
    y: rect.y,
    w: Math.max(rect.w, 0),
    h: Math.max(rect.h, 0),
  };
  return entry.outline(safe, shape ?? {});
}

/** Extra strokes that are drawn but never hit tested. Always an array. */
export function decorationOps(kind, rect) {
  const entry = SHAPE_GEOMETRY[kind];
  if (!entry?.decorations) return [];
  const safe = { x: rect.x, y: rect.y, w: Math.max(rect.w, 0), h: Math.max(rect.h, 0) };
  return entry.decorations(safe);
}

// FLATTENING
//
// Curves become line segments so that containment and distance are the same two
// functions for every shape. The segment counts are generous: at 64 segments a
// full circle is within a thousandth of its radius, far inside any tolerance a
// pointer works at.

const pointOnArc = (cx, cy, rx, ry, angle) => [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];

/**
 * Turn ops into a closed polygon.
 *
 * NaN in, empty out. A degenerate rect is a real thing that happens on the first
 * pixel of a drag, and every caller would otherwise need its own guard.
 */
export function flatten(ops) {
  if (!Array.isArray(ops)) return [];
  const points = [];
  const push = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const last = points.at(-1);
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return;
    points.push([x, y]);
  };

  for (const op of ops) {
    const [code] = op;
    if (code === 'M' || code === 'L') {
      push(op[1], op[2]);
    } else if (code === 'A') {
      const [, cx, cy, rx, ry, from, to, anticlock] = op;
      let sweep = to - from;
      if (anticlock && sweep > 0) sweep -= Math.PI * 2;
      if (!anticlock && sweep < 0) sweep += Math.PI * 2;
      const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * ARC_SEGMENTS));
      for (let i = 0; i <= steps; i += 1) {
        const [px, py] = pointOnArc(cx, cy, rx, ry, from + (sweep * i) / steps);
        push(px, py);
      }
    }
  }
  return points;
}

/** The flattened outline of a shape kind over a rect. */
export const outlinePoints = (kind, rect, shape = null) => flatten(outlineOps(kind, rect, shape));

// CONTAINMENT AND DISTANCE

/** Even-odd ray casting. A point exactly on an edge may fall either way, which
    is why callers add a tolerance band rather than relying on this alone. */
export function pointInPolygon(points, point) {
  if (!points || points.length < 3) return false;
  const { x, y } = point;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const straddles = (yi > y) !== (yj > y);
    if (!straddles) continue;
    const at = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < at) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a[0], point.y - a[1]);
  let t = ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a[0] + t * dx), point.y - (a[1] + t * dy));
}

/** Shortest distance from a point to the closed outline. Infinity if degenerate. */
export function distanceToPolygon(points, point) {
  if (!points || points.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    best = Math.min(best, distanceToSegment(point, points[j], points[i]));
  }
  return best;
}

/**
 * Is the point inside the shape, or within `tolerance` of its outline?
 *
 * `tolerance` is required, and it is in image pixels. A fixed number of image
 * pixels is a different distance under the pointer at every display scale, so
 * the caller has to convert from screen space first (DECISIONS.md D19). A
 * default here would be a bug that only shows up on a very long capture, which
 * is exactly the kind this extension exists to take.
 */
export function outlineHit(kind, rect, point, tolerance, shape = null) {
  const points = outlinePoints(kind, rect, shape);
  if (points.length < 3) return false;
  if (pointInPolygon(points, point)) return true;
  return distanceToPolygon(points, point) <= tolerance;
}

// FREEHAND PATHS
//
// A pen stroke is the one shape whose payload is a list rather than a handful
// of numbers, which makes two things true that are not true of anything else
// here.
//
// The first is that it has to be thinned. A pointer reports moves faster than
// anybody draws, and a stroke held for a few seconds is thousands of samples
// describing a line the eye reads as smooth at a few dozen.
//
// The second is that it must never be edited in place. `commit()` snapshots the
// containing arrays and keeps a *reference* to every shape, so history shares
// these points with the present. Mutating them would silently rewrite the past:
// undo would hand back a state that had already been changed. Every function
// below returns a new array, and every caller has to keep it that way.

/**
 * The distance from a point to an open polyline.
 *
 * Open, unlike `distanceToPolygon`, which closes the shape: a stroke that
 * starts and ends far apart is not a shape with a long invisible side.
 *
 * @param {Array<[number, number]>} points
 * @param {{x:number, y:number}} point
 * @returns {number} Infinity if there is nothing to measure against
 */
export function distanceToPath(points, point) {
  if (!points || points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(point.x - points[0][0], point.y - points[0][1]);

  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const d = distanceToSegment(point, points[i - 1], points[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The box a path occupies.
 *
 * @param {Array<[number, number]>} points
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function pathBounds(points) {
  if (!points || points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Ramer, Douglas and Peucker: drop every point that is closer to the line
 * between its neighbours than `tolerance`.
 *
 * Written out rather than taken from a package, which is the rule here and is
 * also the right call for twenty lines with no edge cases worth arguing about.
 * Iterative rather than recursive, because a stroke can be thousands of points
 * and a recursive version blows the stack on exactly the input this exists for.
 *
 * The ends are always kept: a simplification that moves where a stroke starts
 * is not a simplification.
 *
 * @param {Array<[number, number]>} points
 * @param {number} tolerance in canvas pixels
 * @returns {Array<[number, number]>} a new array, never the one passed in
 */
export function simplifyPath(points, tolerance) {
  if (!points || points.length <= 2) return points ? [...points] : [];
  if (!(tolerance > 0)) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // An explicit stack of [first, last] spans, standing in for the recursion.
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;

    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = distanceToSegment(
        { x: points[i][0], y: points[i][1] },
        points[first],
        points[last],
      );
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }

    if (worst > tolerance) {
      keep[worstAt] = 1;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push([points[i][0], points[i][1]]);
  return out;
}

/**
 * Move every point by the same amount.
 *
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>} a new array
 */
export const movePath = (points, dx, dy) => (points ?? []).map(([x, y]) => [x + dx, y + dy]);

/**
 * Fit a path into a new box, keeping its shape.
 *
 * A path with no width or height in one axis (a perfectly straight horizontal
 * stroke, say) cannot be scaled in that axis without dividing by nothing, so
 * that axis is left alone and the stroke is moved instead.
 *
 * @param {Array<[number, number]>} points
 * @param {{x:number,y:number,w:number,h:number}} from
 * @param {{x:number,y:number,w:number,h:number}} to
 * @returns {Array<[number, number]>} a new array
 */
export function fitPath(points, from, to) {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return (points ?? []).map(([x, y]) => [
    to.x + (x - from.x) * sx,
    to.y + (y - from.y) * sy,
  ]);
}
