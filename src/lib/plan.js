// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// Capture planning. Pure functions, no chrome.*, everything here is unit
// tested in Node, because tile arithmetic is where capture bugs actually live.

/**
 * Chrome refuses canvases wider or taller than 16384px, and very large ones
 * fail to allocate long before that. Both limits are in *device* pixels, which
 * is the whole reason long pages used to be cut in half on a retina display:
 * at devicePixelRatio 2 a 16384px canvas only holds 8192 CSS pixels of page.
 */
export const LIMITS = {
  maxSide: 16384,
  maxArea: 128 * 1024 * 1024,
};

/**
 * How far the output may be shrunk to fit a long page onto one canvas.
 *
 * Below roughly half of CSS-pixel resolution body text stops being readable, so
 * a smaller image would not be a worse copy of the page: it would be a useless
 * one. Pages that still do not fit are truncated, and say so.
 */
export const MIN_OUTPUT_SCALE = 0.5;

/**
 * How small an export may be asked to be, as a fraction of the picture.
 *
 * A tenth of a 1265 pixel capture is 127 pixels, which is a thumbnail. Below
 * that nothing in the image can be read and the file size stops falling
 * usefully, so the slider would be offering a setting nobody would keep.
 */
export const MIN_EXPORT_SCALE = 0.1;

/**
 * The size an export will actually be at a given scale.
 *
 * Rounded once, here, rather than in the encoder and again in the readout: two
 * roundings of the same number is how a menu ends up promising 633 pixels and
 * writing 632. Never upscales, because enlarging a screenshot invents detail
 * that was never captured, and clamps to a side of at least one pixel so a
 * scale that would round an edge away produces a picture rather than an error.
 *
 * @param {number} width the width of the picture as it stands
 * @param {number} height
 * @param {number} scale 0.1 to 1
 * @returns {{w:number, h:number, scale:number}} the size, and the scale that
 *   actually produced it, which is what the readout should show
 */
export function exportSize(width, height, scale) {
  const w0 = Math.max(1, Math.round(Number(width) || 1));
  const h0 = Math.max(1, Math.round(Number(height) || 1));

  const wanted = Number(scale);
  const safe = Number.isFinite(wanted)
    ? Math.min(1, Math.max(MIN_EXPORT_SCALE, wanted))
    : 1;

  const w = Math.max(1, Math.round(w0 * safe));
  const h = Math.max(1, Math.round(h0 * safe));
  return { w, h, scale: safe };
}

/**
 * The largest output scale, no greater than the captured scale, at which the
 * whole region fits within both canvas limits.
 */
function scaleThatFits(region, captureScale, limits) {
  const bySide = limits.maxSide / Math.max(region.w, region.h);
  const byArea = Math.sqrt(limits.maxArea / (region.w * region.h));
  return Math.min(captureScale, bySide, byArea);
}

/**
 * @param {object} m page metrics in CSS pixels, from measurePage()
 * @param {object} [options]
 * @param {{x:number,y:number,w:number,h:number}} [options.region] the part of the
 *   document to capture. Defaults to all of it; the visible-area and
 *   pick-an-element modes pass a smaller box.
 * @returns {{tiles: Array<{x:number,y:number}>, width:number, height:number,
 *            originX:number, originY:number, truncated:boolean,
 *            captureScale:number, outputScale:number}}
 */
export function planCapture(m, options = {}) {
  const limits = options.limits ?? LIMITS;
  // Chrome folds browser zoom into devicePixelRatio, so this one number is the
  // full CSS-pixel -> captured-pixel scale of the incoming screenfuls.
  const captureScale = m.devicePixelRatio > 0 ? m.devicePixelRatio : 1;
  const stepX = Math.max(1, Math.floor(m.viewportWidth));
  const stepY = Math.max(1, Math.floor(m.viewportHeight));

  const wanted = options.region ?? { x: 0, y: 0, w: m.fullWidth, h: m.fullHeight };
  const region = {
    x: Math.max(0, Math.round(wanted.x)),
    y: Math.max(0, Math.round(wanted.y)),
    w: Math.max(1, Math.round(wanted.w)),
    h: Math.max(1, Math.round(wanted.h)),
  };

  // Prefer shrinking the output over cutting the page off. Truncation loses
  // content the user asked for; a smaller scale loses only sharpness, and only
  // on the long pages that actually need it.
  const outputScale = Math.max(
    MIN_OUTPUT_SCALE,
    Math.min(captureScale, scaleThatFits(region, captureScale, limits)),
  );

  // Whatever the region still cannot give up at the floor scale is cut.
  const maxWidth = Math.floor(limits.maxSide / outputScale);
  const width = Math.min(region.w, maxWidth);

  const maxHeightBySide = limits.maxSide / outputScale;
  const maxHeightByArea = limits.maxArea / (width * outputScale * outputScale);
  const maxHeight = Math.floor(Math.min(maxHeightBySide, maxHeightByArea));
  const height = Math.max(1, Math.min(region.h, maxHeight));

  const tiles = [];
  for (let y = region.y; y < region.y + height; y += stepY) {
    for (let x = region.x; x < region.x + width; x += stepX) tiles.push({ x, y });
  }

  return {
    tiles,
    width,
    height,
    // Tiles are scrolled to in document coordinates; the canvas starts here, so
    // the stitcher subtracts this to place them.
    originX: region.x,
    originY: region.y,
    captureScale,
    outputScale,
    truncated: height < region.h || width < region.w,
  };
}

/** True when the page already fits on screen and needs no scrolling or prep. */
export function fitsInViewport(m) {
  return m.fullHeight <= m.viewportHeight && m.fullWidth <= m.viewportWidth;
}

/** Only ever an extension we chose. A bare regex test coerces null to "null",
 *  which looks like a perfectly good extension and is not one, so compare a
 *  string. */
function safeExtension(extension) {
  const wanted = String(extension ?? '');
  return /^[a-z0-9]{1,5}$/.test(wanted) ? wanted : 'png';
}

const slug = (text, max) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');

/**
 * The default name for a capture: product, ISO 8601 timestamp, then the page URL.
 *
 * The timestamp is ISO 8601 basic format (20260908T142305) because the extended
 * format's colons are not legal in filenames on Windows and are awkward on macOS.
 * Basic format is still ISO 8601, still sorts chronologically as text, and needs
 * no escaping anywhere.
 *
 * Everything outside [a-z0-9-] is stripped from both the product name and the
 * URL, so no separator, traversal sequence or reserved character can reach
 * chrome.downloads from page controlled text.
 */
export function captureBasename({ product, url, date = new Date() } = {}) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `T${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;

  // The scheme and a leading www carry no information worth spending characters on.
  const site = slug(String(url ?? '').replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/^www\./i, ''), 70);

  return `${slug(product, 40) || 'capture'}-${stamp}-${site || 'page'}`;
}

export function captureFilename({ product, url, date, extension } = {}) {
  return `${captureBasename({ product, url, date })}.${safeExtension(extension)}`;
}

/**
 * Turn what the user typed in the filename box into something safe to hand to
 * chrome.downloads.
 *
 * This is the one place a person can put arbitrary text into a filename, so it is
 * the one place that has to treat that text as hostile: no path separators, no
 * traversal, no control characters, and no leading dot that would quietly write a
 * hidden file. Spaces, dots, dashes and underscores survive, because people
 * reasonably want them and none of them can escape the directory.
 */
export function applyFilename(name, extension) {
  const ext = safeExtension(extension);

  const cleaned = String(name ?? '')
    // Typing "shot.png" and choosing PNG should not produce "shot.png.png".
    .replace(/\.(png|jpe?g|webp|gif)$/i, '')
    // Control characters, which never belong in a filename.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-. ]+/, '')
    .slice(0, 120)
    .replace(/[-. ]+$/, '');

  return `${cleaned || 'capture'}.${ext}`;
}
