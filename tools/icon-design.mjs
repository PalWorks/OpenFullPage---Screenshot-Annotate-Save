// The OpenFullPage icon, described as geometry.
//
// CLEAN ROOM
//
// The mark is drawn from these coordinates and from nothing else. It was designed
// against the constraints below, not against anyone's existing mark, and the
// statement of non-association lives in NOTICE.md, which is where a disclaimer
// belongs. A camera is the obvious sign for a thing that photographs a page, so
// several tools in this category use one; what follows is why ours is the shape
// it is, which is the record that matters if the question is ever asked.
//
// THE IDEA
//
// A retro camera drawn as a caricature: a squat cream body dwarfed by one
// enormous lens, set in a circle. The exaggeration is the point. A correctly
// proportioned camera is a picture of a camera and looks like every other one;
// a camera that is mostly lens is a character, and it is the lens that survives
// when the mark is sixteen pixels wide.
//
// The container is a disc because almost every extension in the toolbar is a
// rounded square, so a circle is the one silhouette that is not. Filled cream on
// teal, rather than an outline on white, for the same reason: the mark has to be
// told apart at a glance from its neighbours, at sixteen pixels, on both the
// light and the dark Chrome toolbar.
//
// Five other marks were drawn and rejected, recorded so they are not redrawn by
// accident. They are kept as images in the logo options folder. Four crop marks
// around a narrow page put five elements inside sixteen pixels and none survived.
// A folded sheet of paper read cleanly but said "document" rather than "camera".
// A monoline camera and a ringed badge both dissolved at 16px. An aperture of six
// blades read as a star. A cream disc with the camera cut out of it disappeared
// into the light Chrome toolbar, which is the background it has to hold against.
//
// Unit coordinates (0..1) so one description renders correctly at every size.
// The constraint is the 16px toolbar rendering, not the 128px store tile: at
// 16px only solid masses survive, and anything closer than about a pixel merges.
// The lens ring is the one detail allowed to merge, because when it does it
// leaves a dark lens, which is still correct.

import { Canvas, clipped, hex, roundedRect, subtract, union, verticalGradient } from './lib/png.mjs';

export const PALETTE = {
  // Deep teal. It has to hold against both the light (#F1F3F4) and the dark
  // (#292A2D) Chrome toolbar, which rules out anything pale or anything near
  // black. Teal also leaves amber free, and amber is the progress colour.
  tileTop: '#12907E',
  tileBottom: '#0A5F55',
  // Warm off-white, not pure white: the cream is what makes the body read as a
  // film era camera rather than a phone.
  body: '#F6F1E4',
  lens: '#08312C',
  // The ring inside the lens picks up the tile colour, so the mark resolves to
  // two hues rather than three.
  lensRing: '#12907E',
  // The catchlight at the centre of the lens. Cream rather than white, so it
  // belongs to the body rather than reading as a hole punched through it.
  lensCentre: '#F6F1E4',
  // Reserved for progress. At rest the icon carries no amber at all, so amber
  // appearing in the toolbar means exactly one thing: a capture is running.
  accent: '#FBBF24',
};

const circle = (cx, cy, r) => roundedRect(cx - r, cy - r, r * 2, r * 2, r);

const TILE = circle(0.5, 0.5, 0.5);

const GEOMETRY = {
  // Wide and squat, with generous corners. The proportions are wrong on purpose:
  // a real camera body is roughly 2:1 and this is closer to 5:3, which is what
  // stops it reading as a technical drawing.
  bodyX: 0.115,
  bodyW: 0.77,
  bodyY: 0.30,
  bodyH: 0.46,
  bodyR: 0.13,
  // The viewfinder housing, oversized to match the lens, and a small shutter
  // release to its right. Two bumps on the top edge are what separate a camera
  // from a suitcase at sixteen pixels, where the lens alone could be a button.
  viewfinderX: 0.035,
  viewfinderW: 0.26,
  viewfinderH: 0.16,
  shutterW: 0.10,
  shutterH: 0.075,
  // Nearly half the height of the body. This is the caricature.
  lensR: 0.215,
};

/** Body, viewfinder housing and shutter release as one silhouette. */
function shell(g) {
  const body = roundedRect(g.bodyX, g.bodyY, g.bodyW, g.bodyH, g.bodyR);
  const viewfinder = roundedRect(
    g.bodyX + g.viewfinderX, g.bodyY - g.viewfinderH + 0.06,
    g.viewfinderW, g.viewfinderH, 0.055,
  );
  const shutter = roundedRect(
    g.bodyX + g.bodyW - 0.17, g.bodyY - g.shutterH + 0.03,
    g.shutterW, g.shutterH, 0.03,
  );
  return union(body, viewfinder, shutter);
}

/**
 * @param {Canvas} c
 * @param {number} progress 0..1: how much of the camera body is filled
 */
export function draw(c, progress = 0) {
  const g = GEOMETRY;
  const camera = clipped(shell(g), TILE);

  c.fill(TILE, verticalGradient(PALETTE.tileTop, PALETTE.tileBottom));
  c.fill(camera, hex(PALETTE.body));

  if (progress > 0) {
    // Rising from the bottom of the body, so a glance at the toolbar reads as a
    // level rather than as a different icon.
    const top = g.bodyY + g.bodyH * (1 - progress);
    c.fill(clipped(roundedRect(0, top, 1, 1 - top, 0), camera), hex(PALETTE.accent));
  }

  // Three rings, coarse enough that at 16px they collapse to a dark lens with a
  // light centre, which is still a lens.
  const cx = 0.5;
  const cy = g.bodyY + g.bodyH / 2 + 0.005;
  const r = g.lensR;
  c.fill(circle(cx, cy, r), hex(PALETTE.lens));
  c.fill(circle(cx, cy, r * 0.62), hex(PALETTE.lensRing));
  c.fill(circle(cx, cy, r * 0.30), hex(PALETTE.lensCentre));
}

// Frames for the toolbar animation. Eight is enough to read as motion without
// shipping a sprite sheet, and the badge carries the exact percentage.
export const PROGRESS_STEPS = 8;
export const PROGRESS_SIZES = [16, 32];

export function render(size, progress = 0, samples = 4) {
  const c = new Canvas(size, samples);
  draw(c, progress);
  return c.toRgba();
}
