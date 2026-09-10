// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The result tab. It receives the captured screenfuls from the service worker,
// stitches them, hands them to the editor, and exports whatever the user ends
// up with.
//
// Stitching here rather than in a background document is what lets the
// extension do without the `offscreen` permission. It also means Download and
// Copy are real clicks in a real page, so the downloads permission can be asked
// for at the moment it is needed rather than at install time.

import { applyFilename, captureBasename } from '../lib/plan.js';
import { buildPdf, deflate, planPdfPages, rgbaToRgb } from '../lib/pdf.js';
import { CORNERED_KINDS, PAINTS, PAINT_KINDS, SHAPE_TOOLS, kindOfTool } from '../lib/edit.js';
import { DOWNLOAD_FORMATS, OUTPUT_FORMATS, encodeOrThrow, extensionOf } from '../lib/encode.js';
import { PROTOCOL_MISMATCH, speaksOurProtocol } from '../lib/protocol.js';
import { captureWasClean, reviewsUrl, shouldNudge } from '../lib/nudge.js';
import { createEditor } from './editor.js';
import { defaultStyle, saveSettings } from '../lib/settings.js';
import { THEME_STATE, cycleTheme, startTheme, themeLabel } from '../lib/theme.js';

const el = (id) => document.getElementById(id);
const ui = {
  dimensions: el('dimensions'),
  filename: el('filename'),
  ext: el('ext'),
  formats: el('formats'),
  settings: el('settings'),
  download: el('download'),
  copy: el('copy'),
  upload: el('upload'),
  bar: el('bar'),
  track: el('track'),
  status: el('status'),
  note: el('note'),
  canvas: el('canvas'),
  toolbar: el('toolbar'),
  theme: el('theme'),
  cropBar: el('crop-bar'),
  cropSize: el('crop-size'),
  cropApply: el('crop-apply'),
  cropCancel: el('crop-cancel'),
  undo: el('undo'),
  redo: el('redo'),
  revert: el('revert'),
  delete: el('delete'),
  shapesGlyph: el('shapes-glyph'),
  shapesCombo: el('shapes-combo'),
  textCombo: el('text-combo'),
  styleGlyph: el('style-glyph'),
  strokePx: el('stroke-px'),
  borderGlyph: el('border-glyph'),
  fillGlyph: el('fill-glyph'),
  fillSlash: el('fill-slash'),
  textFamily: el('text-family'),
  textWell: el('text-well'),
  textSize: el('text-size'),
  textBold: el('text-bold'),
  textItalic: el('text-italic'),
  textUnderline: el('text-underline'),
  zoomLevel: el('zoom-level'),
  zoomExact: el('zoom-exact'),
  nudge: el('nudge'),
  nudgeRate: el('nudge-rate'),
  nudgeTell: el('nudge-tell'),
  nudgeNever: el('nudge-never'),
  overview: el('overview'),
  overviewSheet: el('overview-sheet'),
  overviewPort: el('overview-port'),
  frameWell: el('frame-well'),
  frameWidth: el('frame-width'),
  plateWell: el('plate-well'),
  plateOpacity: el('plate-opacity'),
  plateOpacityOut: el('plate-opacity-out'),
  ctx: el('ctx'),
  quality: el('quality'),
  qualityOut: el('quality-out'),
};

// Single-key tool shortcuts, which is how tool palettes are normally driven.
//
/**
 * One key per tool, and every one of them is in its own tooltip.
 *
 * The rule is: a letter from the tool's own name, or from the name people
 * actually use for it. `v` for select, `r` for a rectangle and `o` for an oval
 * are the three exceptions, and they are exceptions because every other editor
 * uses them and muscle memory beats a rule. The rest read as `d` for diamond,
 * `b` for bubble, `z` for zoom, and then the first free letter inside the word:
 * parallelogra**m**, tr**i**angle, c**y**linder, ro**u**nded.
 *
 * A tooltip that names the key is the whole point. A shortcut nobody can find
 * is a shortcut for the person who wrote it.
 */
const TOOL_KEYS = {
  v: 'select', a: 'arrow', l: 'line', r: 'rect', u: 'rounded', s: 'stadium',
  o: 'ellipse', b: 'callout', z: 'loupe', h: 'highlight', p: 'pixelate',
  t: 'text', n: 'counter', c: 'crop',
  d: 'rhombus', g: 'hexagon', m: 'parallelogram', i: 'triangle', y: 'cylinder',
};

/**
 * The paint order, on the keys the drawing tools have used for decades.
 *
 * Square brackets alone move one step, and with the platform accelerator they
 * go all the way. The menu names them, so pressing one is a thing you learn by
 * having used the menu once rather than by reading a manual.
 */
const ORDER_KEYS = { '[': 'backward', ']': 'forward' };
const ORDER_ENDS = { '[': 'back', ']': 'front' };

/** Arrow keys move the selection. Ten times as far with Shift. */
const NUDGES = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

// How long a confirmation stays. Long enough to be seen after a glance away,
// short enough that the toolbar is not still congratulating itself by the time
// the next thing is done.
const CONFIRM_MS = 2000;

// What the lossy encoders are given, as a percentage, because that is what the
// control shows. 92 is where JPEG stops being visibly worse than the original on
// a screenshot, which is mostly flat colour and hard edges rather than
// photographic detail, and it is what this was hardcoded to before it was a
// control at all.
let quality = 92;

// The stitched capture, kept untouched. The visible canvas is rendered from it
// on every edit, so undo is exact and repeated edits never degrade the image.
const base = document.createElement('canvas');

let ctx = null;
// The scale the screenfuls arrive at, and the scale the output is written at.
// They differ only when the page is too long to hold at full resolution.
let captureScale = 1;
let outputScale = 1;
let plan = null;
let received = 0;
let pageTitle = 'page';
let pageUrl = '';
let editor = null;
let edited = false;
let settings = {};
// The number of undoable steps at the last save or copy. -1 means nothing has
// been written out at all, which is true the moment a capture lands.
let savedAt = -1;

// Screenfuls arrive faster than they decode, so work is chained: order matters,
// and 'finish' must land after the last draw.
let queue = Promise.resolve();

/**
 * A capture lives only in this tab.
 *
 * The service worker streams the screenfuls once, to the port the result tab
 * opened with, and then forgets them. Reloading this page therefore does not
 * reload the screenshot: it destroys it, along with every annotation, and there
 * is nothing left anywhere to recover it from. A stray Cmd+R or a click on the
 * reload button is all it takes.
 *
 * So the tab asks. Chrome will only show its own wording, and only if the user
 * has interacted with the page, which by this point they have.
 */
const hasUnsavedWork = () => Boolean(editor) && editor.document.past.length !== savedAt;

window.addEventListener('beforeunload', (event) => {
  if (!hasUnsavedWork()) return;
  event.preventDefault();
  // Older Chrome needs the assignment as well as preventDefault.
  event.returnValue = '';
});

/** Called after the image has actually been written somewhere. */
function markSaved() {
  savedAt = editor ? editor.document.past.length : -1;
}

function say(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', isError);
  ui.status.classList.remove('done');
}

/**
 * Confirm, where the reader is already looking.
 *
 * Copying and saving both said so in the status line, at the far end of a row
 * that also carries a filename and a pixel count, in the same muted grey as
 * both. It is easy to miss entirely, and "did that work" is the one question a
 * capture tool has to answer without being asked twice.
 *
 * So the button that was pressed answers: its glyph becomes a tick and it takes
 * a green ground for two seconds. The status line still carries the sentence,
 * briefly on the same green so it reads as the record rather than as one more
 * grey label.
 *
 * The button does not grow to fit a word. Copy and Download are fixed-width icon
 * buttons, and widening one would shove Download, Upload, Theme and Settings
 * sideways and back again. A quieter answer in place beats a louder one that
 * moves the furniture.
 *
 * `aria-label` changes with it, so this is an answer for a screen reader too and
 * not only a colour.
 */
const answered = new Map();

function confirmOn(button, text) {
  say(text);
  ui.status.classList.add('done');

  if (button) {
    clearTimeout(answered.get(button)?.timer);
    const label = answered.get(button)?.label ?? button.getAttribute('aria-label');
    button.classList.add('done');
    button.setAttribute('aria-label', text);
    answered.set(button, {
      label,
      timer: setTimeout(() => {
        button.classList.remove('done');
        button.setAttribute('aria-label', label);
        answered.delete(button);
      }, CONFIRM_MS),
    });
  }

  clearTimeout(confirmOn.fade);
  confirmOn.fade = setTimeout(() => ui.status.classList.remove('done'), CONFIRM_MS);
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function markPressed(selector, isOn) {
  for (const button of ui.toolbar.querySelectorAll(selector)) {
    button.setAttribute('aria-pressed', String(isOn(button)));
  }
}

// STITCHING

/**
 * Decode a captured screenful without touching the network stack. The
 * conventional route sends a data: URL back through the network APIs, which are
 * banned repo-wide; decoding it by hand keeps this provably local.
 */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const type = dataUrl.slice(5, comma).split(';')[0] || 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function sizeCanvas(bitmap) {
  // Only the first screenful reveals the true captured-pixel scale, which folds
  // display density and browser zoom into one number. Trusting the measured
  // value over the planned one matters: if the user zoomed between the
  // measurement and the capture, the plan's scale is stale and the canvas would
  // be the wrong size.
  captureScale = bitmap.width / plan.innerWidth;

  // Never upscale. The planner may ask for less than the captured scale to fit
  // a long page on one canvas; it must never ask for more.
  outputScale = Math.min(plan.outputScale ?? captureScale, captureScale);

  base.width = Math.round(plan.width * outputScale);
  base.height = Math.round(plan.height * outputScale);

  ctx = base.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Pages that declare no background paint nothing; white matches what the user
  // saw rather than leaving transparent bands.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, base.width, base.height);
}

async function drawTile({ dataUrl, x, y }) {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  if (!ctx) sizeCanvas(bitmap);

  // Crop each screenful to the client box: the captured bitmap also contains
  // the scrollbar gutters, which would otherwise be stitched into the page.
  const sw = Math.min(Math.round(plan.viewportWidth * captureScale), bitmap.width);
  const sh = Math.min(Math.round(plan.viewportHeight * captureScale), bitmap.height);

  // Placed relative to the captured region, which for the visible-area and
  // pick-an-element modes starts partway down the document.
  const left = x - plan.originX;
  const top = y - plan.originY;

  // Round both edges rather than the origin and the size independently: at a
  // fractional output scale that is what makes neighbouring tiles abut exactly
  // instead of leaving a hairline seam between every screenful.
  const x0 = Math.round(left * outputScale);
  const y0 = Math.round(top * outputScale);
  const x1 = Math.round((left + plan.viewportWidth) * outputScale);
  const y1 = Math.round((top + plan.viewportHeight) * outputScale);

  ctx.drawImage(bitmap, 0, 0, sw, sh, x0, y0, x1 - x0, y1 - y0);
  bitmap.close();

  received += 1;
  ui.bar.style.width = `${Math.round((received / plan.total) * 100)}%`;
  if (plan.total > 1) say(`Assembling, ${received} of ${plan.total} screenfuls…`);
}

async function finish() {
  if (!ctx) throw new Error('Nothing was captured.');

  // What the two frame switches put back when they are turned on. The frame
  // falls back to the stroke colour rather than to a colour nobody chose.
  lastFrameColour = settings.textFrameColour ?? settings.colour ?? lastFrameColour;
  lastPlateColour = settings.textFramePlate ?? lastPlateColour;

  editor = createEditor({
    base,
    canvas: ui.canvas,
    initial: settings,
    onChange(state) {
      edited = state.edited;
      ui.undo.disabled = !state.canUndo;
      ui.redo.disabled = !state.canRedo;
      ui.revert.disabled = false;
      ui.revert.title = resetLabel(state.edited);
      // selectedCount, not selected: `selected` is the ONE selected shape and
      // is deliberately null for a set, so reading it here would disable Delete
      // exactly when several things are selected.
      ui.delete.disabled = state.selectedCount === 0;
      // The canvas menu is open while the reader looks at it, so its items have
      // to answer to the document underneath rather than to whatever was true
      // when it was opened.
      showMenuState(state);
      // Every measured file size describes an image that no longer exists.
      forgetSizes(state);
      ui.dimensions.textContent = `${state.crop.w} × ${state.crop.h} pixels`;
      markPressed('[data-tool]', (b) => b.dataset.tool === state.tool);
      showStyle(state.style, state.tool);
      showCropBar(state.pendingCrop);
      // A crop changes how big the picture is, so a fit has to be worked out
      // again. Safe to call from here because applyZoom only redraws when the
      // width it wants is not the width already set, so this settles in one
      // pass rather than notifying its way round in a circle. D58.
      applyZoom();
    },
  });

  editor.render();
  applyHiddenButtons(settings.hiddenButtons ?? []);
  applyHiddenShapes(settings.hiddenShapes ?? []);

  ui.canvas.hidden = false;
  // Fit the width, which is what the old max-width rule did on its own, so a
  // capture opens exactly where it always has.
  applyZoom();
  // The bar has served its purpose; leaving it full reads as unfinished work.
  ui.track.hidden = true;
  ui.download.disabled = false;
  ui.copy.disabled = false;
  ui.upload.disabled = false;
  setToolsEnabled(true);

  const manifest = chrome.runtime.getManifest();
  ui.filename.value = captureBasename({
    // The store title carries keywords; the short name is the product. Filenames
    // follow the short name so a listing rewrite never lengthens them.
    product: manifest.short_name || manifest.name,
    url: pageUrl,
  });
  ui.filename.disabled = false;
  format = OUTPUT_FORMATS[settings.format] ? settings.format : 'png';
  setQuality(settings.quality ?? 92);
  showExtension();

  const modeNote =
    plan.mode === 'visible' ? 'Visible area. ' : plan.mode === 'element' ? 'Selected element. ' : '';
  say(`${modeNote}The image never leaves your computer.`);

  // Long pages are fitted by lowering the output scale before anything is cut,
  // so say which happened rather than leaving the user to guess.
  const shrunk = outputScale < captureScale - 0.001;
  const notes = [];

  if (shrunk) {
    const percent = Math.round((outputScale / captureScale) * 100);
    notes.push(
      `This page was too long to hold at full resolution, so it was scaled to ${percent}% ` +
        'to fit all of it on one image.',
    );
  }
  if (plan.truncated) {
    notes.push(
      'It is still longer than Chrome can hold on a single canvas (16384 pixels), ' +
        'so the capture stops there.',
    );
  }
  // A short image is worth saying out loud. Without this the user has a picture
  // that ends mid-article and no idea whether that is the page or the extension.
  if (plan.endedEarly === 'stopped') {
    notes.push('You finished this capture early, so it ends where the page had got to.');
  } else if (plan.endedEarly === 'stalled') {
    notes.push(
      'The page stopped responding partway down, so this is everything that was ' +
        'captured before then. Pages that never finish loading do this.',
    );
  }

  if (notes.length > 0) {
    ui.note.hidden = false;
    ui.note.textContent = notes.join(' ');
  }

  // Counted here, where the plan that says whether it came out whole already is.
  // Never before the picture is on screen: the ask is worth making only after
  // the thing it is asking about has been delivered.
  await maybeNudge(plan, settings);

  if (settings.directDownload) await saveWithoutEditing();
}

// STRAIGHT TO A FILE
//
// When the user has asked for it, the capture is written out and this tab closes
// itself, so a capture is one click and nothing else. It only works if the
// downloads permission is already granted, because there is no click here to
// hang a permission prompt on: the options page asks at the moment the setting is
// switched on, and this checks rather than assumes.
//
// Anything that goes wrong shows the editor instead. Losing the capture to a
// silent failure is the one outcome worse than an extra tab.
async function saveWithoutEditing() {
  const allowed = await chrome.permissions.contains({ permissions: ['downloads'] }).catch(() => false);
  if (!allowed) {
    await showTab();
    say('Saving without the editor needs permission to use Chrome downloads. Turn it on in settings, or save from here.', true);
    return;
  }

  const id = await save(format, { ask: false });
  if (!id) {
    await showTab();
    return;
  }
  // The file is read from a blob URL owned by this document, so closing the tab
  // before Chrome has finished reading it would cut the download off. Wait for
  // Chrome to say it is done, and close anyway if it never does: an extra tab is
  // recoverable, a half-written file is not.
  await downloadSettled(id);
  chrome.runtime.sendMessage({ type: 'closeTab' }).catch(() => {});
}

/** Resolves when Chrome reports the download finished, or after the grace period. */
function downloadSettled(id, graceMs = 15000) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    };
    const onChanged = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') finish();
    };
    const timer = setTimeout(finish, graceMs);
    chrome.downloads.onChanged.addListener(onChanged);
    // It may already be done by the time the listener is attached.
    chrome.downloads.search({ id }).then(([item]) => {
      if (item && item.state !== 'in_progress') finish();
    }).catch(() => {});
  });
}

/** Bring this tab forward. It was opened in the background to save into. */
function showTab() {
  return chrome.runtime.sendMessage({ type: 'showTab' }).catch(() => {});
}

// CROPPING, WITH A CHANCE TO LOOK FIRST
//
// Dragging with the crop tool proposes a region rather than applying one. The
// region is adjustable by its handles or by sliding it whole, and this bar is
// how it is confirmed or abandoned.
//
// The bar is fixed to the viewport, not placed on the page. A capture is often
// ten screens tall, so someone checking the edges of their crop scrolls, and a
// button anchored to the region would be off screen exactly when it is wanted.
// It sits below the region when there is room, above it when there is not, and
// inside the window when the region is larger than the window.

let pendingCrop = null;

function showCropBar(rect) {
  pendingCrop = rect;
  if (!rect) {
    ui.cropBar.hidden = true;
    return;
  }
  ui.cropSize.textContent = `${rect.w} × ${rect.h}`;
  ui.cropBar.hidden = false;
  placeCropBar();
}

function placeCropBar() {
  if (ui.cropBar.hidden || !editor) return;
  const region = editor.cropRectOnScreen();
  if (!region) return;

  const bar = ui.cropBar.getBoundingClientRect();
  const gap = 12;
  const room = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;

  const left = Math.max(
    gap,
    Math.min(region.x + region.w / 2 - bar.width / 2, room - bar.width - gap),
  );

  let top = region.y + region.h + gap;
  if (top + bar.height > height - gap) top = region.y - bar.height - gap;
  if (top < gap || top + bar.height > height - gap) {
    // Neither edge is on screen. Sit on the region, inside the window.
    top = Math.max(gap, Math.min(height - bar.height - gap, region.y + region.h - bar.height - gap));
  }

  ui.cropBar.style.left = `${Math.round(left)}px`;
  ui.cropBar.style.top = `${Math.round(top)}px`;
}

// Coalesced to one measurement per frame. Scroll fires far faster than the page
// repaints, and every call reads two layout boxes on a document that can be
// sixteen thousand pixels tall.
let placing = 0;
function schedulePlaceCropBar() {
  if (placing || ui.cropBar.hidden) return;
  placing = requestAnimationFrame(() => {
    placing = 0;
    placeCropBar();
  });
}

window.addEventListener('scroll', schedulePlaceCropBar, { passive: true });
window.addEventListener('resize', schedulePlaceCropBar);

ui.cropApply.addEventListener('click', () => {
  const rect = editor?.applyCrop();
  if (rect) say(`Cropped to ${rect.w} × ${rect.h} pixels.`);
});

ui.cropCancel.addEventListener('click', () => {
  if (editor?.cancelCrop()) say('Crop cancelled. Nothing was removed.');
});

// EDITING

function selectTool(name) {
  if (!editor) return;
  editor.setTool(name);
  // Picking Arrow or Line is also a statement about the arrowheads, and the
  // editor reconciles the two. Persist what it settled on rather than what was
  // asked for, or the next capture opens on the pair that disagreed.
  saveSettings({
    tool: editor.state.tool,
    lineEnds: editor.state.ends,
    // Rounded and Stadium settle the corner radius the same way Arrow and Line
    // settle the arrowheads, so the next capture opens on the pair that agreed.
    corner: editor.state.corner,
  });
}

/** Every tool is inert until there is an image to use it on. */
function setToolsEnabled(on) {
  const controls = ui.toolbar.querySelectorAll(
    '[data-tool], [data-pop], .pop button, .pop input, .pop select',
  );
  for (const control of controls) control.disabled = !on;
  // Reset is not in that selector because it carries neither a tool nor a
  // popover, and it is no longer edit-only: on an untouched capture it puts the
  // drawing style back. So it follows the same rule as the rest, inert until
  // there is an image and live afterwards.
  ui.revert.disabled = !on;
}

// The toolbar is the page header now, so it is on screen from the start rather
// than appearing when the capture lands. Nothing on it does anything until there
// is an image, so it starts inert.
setToolsEnabled(false);

// What a download would produce right now. Shown next to the filename so the box
// always reads as the whole name, and remembered so the next capture opens on the
// format this one was saved in.
let format = 'png';

function showExtension() {
  ui.ext.textContent = `.${extensionOf(format)}`;
  for (const item of ui.formats.querySelectorAll('[data-format]')) {
    item.setAttribute('aria-pressed', String(item.dataset.format === format));
  }
}

function openMenu(open) {
  ui.formats.hidden = !open;
  ui.download.setAttribute('aria-expanded', String(open));
  // Measuring is what the menu is for now, and it costs real work, so it starts
  // when the menu opens and stops when it closes.
  if (open) {
    showSizes();
    measureSizes();
  }
}

ui.download.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = ui.formats.hidden;
  closePopovers(null);
  openMenu(open);
});

// Clicking anywhere else, or Escape, closes it. Both are what a menu is expected
// to do, and neither should reach the editor underneath.
document.addEventListener('click', () => openMenu(false));
ui.formats.addEventListener('click', (event) => event.stopPropagation());

ui.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

// THEME
//
// One button that rotates system, light, dark and back. System is the default
// and is a real third state: it follows the operating system as it changes,
// which is what most people want and what neither of the other two can do.
//
// The label carries both halves of the story, where it is now and what pressing
// it will do, and title and aria-label are set from the same string so a sighted
// user and a screen reader user are never told different things.

let theme = 'system';

/**
 * Show or hide one SVG element.
 *
 * `hidden` is a property of HTMLElement. SVGElement does not have it, so
 * `svg.hidden = true` quietly sets a plain JavaScript property, leaves the
 * content attribute alone, and draws exactly what it drew before. Three glyphs
 * in this toolbar were toggled that way and not one of them ever changed: the
 * theme button kept the monitor icon through the whole cycle, and the "no fill"
 * slash never lifted. The attribute is the only thing CSS can see.
 */
function showGlyph(node, on) {
  if (on) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}

function showTheme(next) {
  theme = next;
  for (const name of ['system', 'light', 'dark']) {
    showGlyph(el(`theme-${name}`), name === next);
  }
  const label = themeLabel(next);
  ui.theme.setAttribute('aria-label', label);
  ui.theme.title = label;
}

startTheme(showTheme);

ui.theme.addEventListener('click', async () => {
  showTheme(await cycleTheme(theme));
  // #status is a live region, so this is also the announcement.
  say(`Theme: ${THEME_STATE[theme]}.`);
});

for (const button of ui.toolbar.querySelectorAll('[data-tool]')) {
  button.addEventListener('click', () => selectTool(button.dataset.tool));
}

// STYLE CONTROLS
//
// Each grouped button follows the same rule: the glyph shows the current value,
// the chevron opens the set, and picking from the set both restyles the selected
// shape and becomes the default for the next one.

/** Ten quick colours, then a tint and shade grid. Built here because the
    markup would otherwise carry seventy hand-written buttons. */
const QUICK_COLOURS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#18181b', '#ffffff',
];
const GREYS = ['#ffffff', '#e5e7eb', '#9ca3af', '#4b5563', '#1f2937', '#000000'];
const TINTS = [0.72, 0.44, 0.18, 0, 0, 0];
const SHADES = [0, 0, 0, 0, 0.32, 0.6];

function shade(hex, step) {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const lit = v + (255 - v) * TINTS[step];
    return Math.round(lit * (1 - SHADES[step]));
  });
  return `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function swatchButton(colour, kind) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sw';
  button.style.background = colour;
  button.dataset.paint = kind;
  button.dataset.colour = colour;
  button.title = colour.toUpperCase();
  button.setAttribute('aria-label', colour.toUpperCase());
  return button;
}

/**
 * Build the five colour popovers out of one description.
 *
 * They were five hand-written panels in the markup: a row of quick colours, a
 * sixty step grid, a system picker and a hex field, repeated. Adding an opacity
 * slider to all of them would have made five copies of a bigger panel, which is
 * the shape D52 removed from the output formats, where a format present in two
 * lists and missing from the third failed silently in both directions.
 *
 * So the shells carry `data-paint-pop` and PAINTS says what goes in them.
 * `test/invariants.test.js` holds the two together in both directions: a kind
 * with no shell and a shell with no kind are both build failures.
 *
 * This runs at module load, before `ui` is built, because the ids it creates are
 * ids `ui` looks up.
 */
function buildPaintPopovers() {
  for (const pop of document.querySelectorAll('[data-paint-pop]')) {
    const kind = pop.dataset.paintPop;
    const paint = PAINTS[kind];
    if (!paint || pop.childElementCount > 0) continue;

    const title = document.createElement('p');
    title.className = 'pop-title';
    title.id = `pop-${kind}-title`;
    title.textContent = paint.title;
    pop.append(title);
    // The shells carry aria-labelledby pointing at ids that only exist once this
    // has run, so the two are written from the same string rather than by hand
    // in two files.
    pop.setAttribute('aria-labelledby', title.id);

    // The opacity row is the whole width of the panel. The no-colour square used
    // to sit at the head of it, which put a colour choice inside a row about how
    // solid a colour is and squeezed the slider into what was left. It is the
    // first swatch in the row of colours now, which is where a reader looks for
    // it and where every other choice on this panel already lives.
    const row = document.createElement('div');
    row.className = 'paintrow';
    const label = document.createElement('label');
    label.setAttribute('for', `${kind}-opacity`);
    label.textContent = 'Opacity';
    const slider = document.createElement('input');
    slider.id = `${kind}-opacity`;
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = '100';
    slider.setAttribute('aria-label', `${paint.title.replace(' colour', '')} opacity`);
    const out = document.createElement('output');
    out.id = `${kind}-opacity-out`;
    out.setAttribute('for', slider.id);
    out.textContent = '100%';
    row.append(label, slider, out);
    pop.append(row);

    const quick = document.createElement('div');
    quick.className = 'quickrow';
    quick.dataset.quick = kind;
    const grid = document.createElement('div');
    grid.className = 'swgrid';
    grid.dataset.grid = kind;
    pop.append(quick, grid);

    if (paint.none) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'sw none';
      off.dataset.paintNone = kind;
      off.setAttribute('aria-pressed', 'false');
      off.setAttribute('aria-label', kind === 'fill' ? 'No fill' : 'No frame');
      off.title = off.getAttribute('aria-label');
      quick.append(off);
    }
    // Ten cells either way, so the quick row and the grid below it line up. The
    // white that a no-colour square displaces is the first swatch of the grid,
    // so nothing is lost by dropping it from here.
    const quicks = paint.none ? QUICK_COLOURS.slice(0, 9) : QUICK_COLOURS;
    for (const colour of quicks) quick.append(swatchButton(colour, kind));
    for (let step = 0; step < GREYS.length; step += 1) {
      grid.append(swatchButton(GREYS[step], kind));
      for (const colour of QUICK_COLOURS.slice(0, 9)) {
        grid.append(swatchButton(shade(colour, step), kind));
      }
    }

    const custom = document.createElement('div');
    custom.className = 'custom';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.id = `${kind}-picker`;
    picker.value = '#ef4444';
    picker.setAttribute('aria-label', `Custom ${paint.title.toLowerCase()}`);
    picker.title = 'Custom colour';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.id = `${kind}-hex`;
    hex.value = '#EF4444';
    hex.spellcheck = false;
    hex.autocomplete = 'off';
    hex.pattern = '#?[0-9a-fA-F]{6}';
    hex.placeholder = '#RRGGBB';
    hex.setAttribute('aria-label', `${paint.title} as hex`);
    custom.append(picker, hex);
    pop.append(custom);
  }
}

buildPaintPopovers();

const normaliseHex = (raw) => {
  const value = String(raw).trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null;
};

/**
 * The corner controls, and the Box glyph that has to agree with them.
 *
 * The Box icon has carried `rx="1.5"` since it was drawn while the tool drew
 * square corners, so the icon has always been slightly wrong. Now that the
 * radius is a real property the glyph shows it, which fixes the old lie and
 * makes the current radius visible without opening anything.
 *
 * The row is disabled rather than hidden when the tool has no corners. Hiding
 * it would change the popover's height as the tool changes, which moves the
 * Exact field under the pointer.
 */
function showCorner(radius, tool, selectedKind) {
  const applies = CORNERED_KINDS.includes(kindOfTool(tool))
    || CORNERED_KINDS.includes(selectedKind ?? '');
  for (const button of ui.toolbar.querySelectorAll('[data-corner]')) {
    button.disabled = !applies;
  }
  const glyph = el('box-glyph');
  if (glyph) glyph.setAttribute('rx', radius <= 0 ? '0' : radius > 100 ? '5' : '2.6');
}

/** Push the editor's current style back onto every glyph and pressed state. */
function showStyle(style, tool) {
  if (!style) return;

  markPressed('#pop-shapes [data-tool]', (b) => b.dataset.tool === tool);
  ui.shapesCombo.setAttribute('aria-pressed', String(SHAPE_TOOLS.includes(tool)));
  ui.textCombo.setAttribute('aria-pressed', String(tool === 'text'));

  if (SHAPE_TOOLS.includes(tool) && tool !== lastShape) rememberShape(tool);
  const shown = SHAPE_TOOLS.includes(tool) ? tool : lastShape;
  if (shown !== glyphShape) {
    glyphShape = shown;
    const source = ui.toolbar.querySelector(`#pop-shapes [data-tool="${shown}"] svg`);
    if (source) ui.shapesGlyph.replaceChildren(...[...source.childNodes].map((n) => n.cloneNode(true)));
  }

  ui.styleGlyph.style.height = `${Math.min(12, Math.max(1, style.width))}px`;
  ui.strokePx.value = String(style.width);
  markPressed('[data-width]', (b) => Number(b.dataset.width) === style.width);
  markPressed('[data-dash]', (b) => b.dataset.dash === style.dash);
  markPressed('[data-ends]', (b) => b.dataset.ends === style.ends);
  markPressed('[data-corner]', (b) => Number(b.dataset.corner) === (style.corner ?? 0));
  showCorner(style.corner ?? 0, tool, style.selectedKind);

  ui.borderGlyph.setAttribute('stroke', style.colour);
  ui.borderGlyph.setAttribute('stroke-opacity', String(style.strokeOpacity ?? 1));
  markPressed('[data-paint="border"]', (b) => b.dataset.colour === style.colour);
  setHex('border', style.colour);
  showOpacity('border', style.strokeOpacity ?? 1);

  ui.fillGlyph.setAttribute('fill', style.fill ?? 'none');
  ui.fillGlyph.setAttribute('fill-opacity', String(style.fill ? style.fillOpacity : 1));
  showGlyph(ui.fillSlash, !style.fill);
  markPressed('[data-paint="fill"]', (b) => Boolean(style.fill) && b.dataset.colour === style.fill);
  markNone('fill', !style.fill);
  if (style.fill) setHex('fill', style.fill);
  showOpacity('fill', style.fillOpacity);

  ui.textFamily.value = style.text.family;
  ui.textSize.value = String(style.text.size);
  ui.textBold.setAttribute('aria-pressed', String(style.text.bold));
  ui.textItalic.setAttribute('aria-pressed', String(style.text.italic));
  ui.textUnderline.setAttribute('aria-pressed', String(style.text.underline));
  markPressed('[data-align]', (b) => b.dataset.align === style.text.align);
  markPressed('[data-paint="text"]', (b) => b.dataset.colour === style.text.ink);
  ui.textWell.style.background = style.text.ink;
  ui.textWell.style.opacity = String(style.text.inkOpacity ?? 1);
  setHex('text', style.text.ink);
  showOpacity('text', style.text.inkOpacity ?? 1);

  // THE FRAME AND THE PLATE
  //
  // Neither has a switch any more. The frame is off when it has no colour, which
  // is what "no fill" already means and what the slashed well already shows, and
  // the plate is off at nought per cent. Both keep the colour they had while
  // they are off, so turning either back on is one act rather than two.
  const frame = style.text.colour ?? null;
  const plate = style.text.fill ?? null;
  if (frame) lastFrameColour = frame;
  if (plate) lastPlateColour = plate;
  ui.frameWell.style.background = frame ?? lastFrameColour;
  ui.frameWell.classList.toggle('off', !frame);
  markPressed('[data-paint="frame"]', (b) => b.dataset.colour === frame);
  markNone('frame', !frame);
  setHex('frame', frame ?? lastFrameColour);
  showOpacity('frame', style.text.strokeOpacity ?? 1);
  ui.frameWidth.value = String(style.text.width ?? 2);

  const plateAlpha = style.text.fillOpacity ?? 0;
  ui.plateWell.style.background = plate ?? lastPlateColour;
  ui.plateWell.style.opacity = String(Math.max(0.12, plateAlpha));
  setHex('plate', plate ?? lastPlateColour);
  markPressed('[data-paint="plate"]', (b) => b.dataset.colour === plate);
  showOpacity('plate', plateAlpha);
  ui.plateOpacity.value = String(Math.round(plateAlpha * 100));
  ui.plateOpacityOut.textContent = `${Math.round(plateAlpha * 100)}%`;
}

/** The opacity slider and its readout inside one colour popover. */
function showOpacity(kind, alpha) {
  const slider = el(`${kind}-opacity`);
  const out = el(`${kind}-opacity-out`);
  if (!slider || document.activeElement === slider) return;
  const percent = Math.round(alpha * 100);
  slider.value = String(percent);
  out.textContent = `${percent}%`;
}

/** The no-colour button, on the popovers that have one. */
function markNone(kind, on) {
  const button = ui.toolbar.querySelector(`[data-paint-none="${kind}"]`);
  if (button) button.setAttribute('aria-pressed', String(on));
}

function setHex(kind, colour) {
  const picker = el(`${kind}-picker`);
  const hex = el(`${kind}-hex`);
  if (document.activeElement !== hex) hex.value = colour.toUpperCase();
  picker.value = colour;
}

// The Shapes glyph remembers the last shape drawn even while another tool is
// active, so the button never goes blank when you pick Crop.
let lastShape = 'arrow';
let glyphShape = null;

// A switch that turns a colour off has to remember which colour, or turning it
// back on is a second decision the reader never asked to make. Seeded from the
// remembered style, and updated whenever either is set from anywhere.
let lastFrameColour = '#ef4444';
let lastPlateColour = '#ffffff';

// POPOVERS

/**
 * Keep a popover inside the window.
 *
 * Popovers hang from the left edge of their button. The buttons near the right
 * of the toolbar, Download and Upload, are wide enough that theirs ran off the
 * screen and gave the page a horizontal scrollbar. Rather than hand-placing the
 * ones that happen to be on the right today, every popover is measured when it
 * opens and shifted left by however much it overhangs, which stays correct as
 * buttons are added, hidden on the options page, or reordered.
 */
function keepInView(pop) {
  pop.style.left = '0px';
  const group = pop.parentElement.getBoundingClientRect();
  const gap = 10;
  // clientWidth, not innerWidth: innerWidth counts the vertical scrollbar, so
  // measuring against it leaves the popover overlapping the scrollbar and gives
  // the page a horizontal one as well.
  const room = document.documentElement.clientWidth;
  const overhang = group.left + pop.offsetWidth - (room - gap);
  pop.style.left = `${Math.round(Math.min(0, -overhang))}px`;
}

function closePopovers(except) {
  for (const pop of ui.toolbar.querySelectorAll('.pop')) {
    // Never close a popover that contains the one being opened. The text colour
    // palette lives inside the text inspector, and closing its own container
    // would hide it along with everything else in there.
    if (pop === except || (except && pop.contains(except))) continue;
    pop.hidden = true;
  }
  for (const trigger of ui.toolbar.querySelectorAll('[data-pop]')) {
    trigger.setAttribute('aria-expanded', String(el(trigger.dataset.pop) === except));
  }
}

for (const trigger of ui.toolbar.querySelectorAll('[data-pop]')) {
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const pop = el(trigger.dataset.pop);
    const open = pop.hidden;
    openMenu(false);
    closePopovers(open ? pop : null);
    pop.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) keepInView(pop);
  });
}

// A narrowed window can leave an open popover hanging off the edge.
window.addEventListener('resize', () => {
  for (const pop of ui.toolbar.querySelectorAll('.pop')) {
    if (!pop.hidden) keepInView(pop);
  }
});

// A click inside a popover is aimed at the popover, not at dismissing it.
for (const pop of ui.toolbar.querySelectorAll('.pop')) {
  pop.addEventListener('click', (event) => event.stopPropagation());
}
document.addEventListener('click', () => closePopovers(null));

for (const button of ui.toolbar.querySelectorAll('[data-tool]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.tool;
    // Picking from inside the Shapes set both selects it and becomes what the
    // glyph half will draw next time.
    if (SHAPE_TOOLS.includes(name) && button.closest('.pop')) {
      rememberShape(name);
      closePopovers(null);
    }
    selectTool(name);
  });
}

// The glyph half of Shapes redraws the last shape chosen from its set, so the
// button is a shortcut rather than only a label. Its data-tool attribute is kept
// in step with that choice.
function rememberShape(name) {
  lastShape = name;
  ui.shapesCombo.dataset.tool = name;
}

// STROKE

for (const button of ui.toolbar.querySelectorAll('[data-width]')) {
  button.addEventListener('click', () => setWidth(Number(button.dataset.width)));
}

function setWidth(px) {
  editor?.setWidth(px);
  saveSettings({ strokeWidth: px });
}

ui.strokePx.addEventListener('change', () => {
  const px = Math.min(64, Math.max(1, Math.round(Number(ui.strokePx.value) || 1)));
  ui.strokePx.value = String(px);
  setWidth(px);
});

for (const button of ui.toolbar.querySelectorAll('[data-dash]')) {
  button.addEventListener('click', () => {
    editor?.setDash(button.dataset.dash);
    saveSettings({ dash: button.dataset.dash });
  });
}

for (const button of ui.toolbar.querySelectorAll('[data-corner]')) {
  button.addEventListener('click', () => {
    editor?.setCorner(Number(button.dataset.corner));
    saveSettings({ corner: Number(button.dataset.corner) });
  });
}

for (const button of ui.toolbar.querySelectorAll('[data-ends]')) {
  button.addEventListener('click', () => {
    if (!editor) return;
    editor.setEnds(button.dataset.ends);
    // Taking the arrowheads off turns the tool into Line, and putting one back
    // turns it into Arrow, so both halves are saved together.
    saveSettings({ lineEnds: editor.state.ends, tool: editor.state.tool });
  });
}

// COLOUR

function applyPaint(kind, colour) {
  if (kind === 'border') {
    editor?.setColour(colour);
    saveSettings({ colour });
  } else if (kind === 'frame') {
    // The frame is the text shape's own stroke, which is the same property the
    // Border well writes with a caption selected. Picking a colour here is also
    // how the frame is switched on, exactly as it is for a fill.
    lastFrameColour = colour;
    editor?.setTextStyle({ colour });
    saveSettings({ textFrameColour: colour });
  } else if (kind === 'text') {
    // `ink` is the glyphs. `colour` on a text shape is the frame around them,
    // which the Border palette writes, so the two controls no longer fight over
    // one property the way they used to.
    editor?.setTextStyle({ ink: colour });
    saveSettings({ textColour: colour });
  } else if (kind === 'plate') {
    // The plate is the caption's own fill. Picking a colour here does not switch
    // it on: the opacity slider beside it does that, and a colour chosen while
    // the plate is at nought is a choice waiting for the drag that reveals it.
    lastPlateColour = colour;
    editor?.setTextStyle({ fill: colour });
    saveSettings({ textFramePlate: colour });
  } else {
    editor?.setFill(colour);
    saveSettings({ fill: colour });
  }
}

/**
 * The no-colour button, for the two popovers that have one.
 *
 * Fill and Frame, and nothing else. A stroke has no no-colour state, and the
 * plate says invisible with its slider instead, so PAINTS is what decides
 * whether this button exists at all rather than a list written out here.
 */
function clearPaint(kind) {
  if (kind === 'frame') {
    editor?.setTextStyle({ colour: null });
    saveSettings({ textFrameColour: null });
    return;
  }
  editor?.setFill(null);
  saveSettings({ fill: null });
}

/**
 * The opacity slider in each colour popover.
 *
 * Border and Frame write the same shape property, and so do Fill and Plate,
 * which is why this is a switch on where the control is rather than on what it
 * writes: the same value reached from a caption's panel and from the shared one
 * has to travel through the setter that knows about captions.
 */
function applyOpacity(kind, alpha) {
  if (kind === 'border') {
    editor?.setStrokeOpacity(alpha);
    saveSettings({ strokeOpacity: alpha });
  } else if (kind === 'fill') {
    editor?.setFillOpacity(alpha);
    saveSettings({ fillOpacity: alpha });
  } else if (kind === 'text') {
    editor?.setTextStyle({ inkOpacity: alpha });
    saveSettings({ textInkOpacity: alpha });
  } else if (kind === 'frame') {
    editor?.setTextStyle({ strokeOpacity: alpha });
    saveSettings({ textFrameOpacity: alpha });
  } else {
    editor?.setTextStyle({ fillOpacity: alpha });
    saveSettings({ textPlateOpacity: alpha });
  }
}

for (const pop of ui.toolbar.querySelectorAll('.pop.paint')) {
  pop.addEventListener('click', (event) => {
    const swatch = event.target.closest?.('[data-paint]');
    if (swatch) applyPaint(swatch.dataset.paint, swatch.dataset.colour);
  });
}

for (const button of ui.toolbar.querySelectorAll('[data-paint-none]')) {
  button.addEventListener('click', () => clearPaint(button.dataset.paintNone));
}

for (const kind of PAINT_KINDS) {
  const slider = el(`${kind}-opacity`);
  slider.addEventListener('input', () => {
    const percent = Number(slider.value);
    el(`${kind}-opacity-out`).textContent = `${percent}%`;
    applyOpacity(kind, percent / 100);
  });
}

for (const kind of PAINT_KINDS) {
  // The native colour input is the operating system's own picker, which is where
  // a "more colours" control normally leads. It brings an eyedropper and keyboard
  // support that a hand-drawn spectrum would have to reimplement badly.
  el(`${kind}-picker`).addEventListener('input', () => applyPaint(kind, el(`${kind}-picker`).value));

  // Typed or pasted hex. Anything unusable is put back rather than guessed at.
  const hex = el(`${kind}-hex`);
  hex.addEventListener('change', () => {
    const colour = normaliseHex(hex.value);
    if (colour) applyPaint(kind, colour);
    else showStyle(editor?.state, editor?.state?.tool);
  });
  hex.addEventListener('keydown', (event) => event.stopPropagation());
}

// TEXT

ui.textFamily.addEventListener('change', () => {
  editor?.setTextStyle({ family: ui.textFamily.value });
  saveSettings({ textFamily: ui.textFamily.value });
});

function setTextSize(px) {
  const size = Math.min(200, Math.max(8, Math.round(px) || 24));
  ui.textSize.value = String(size);
  editor?.setTextStyle({ size });
  saveSettings({ textSize: size });
}

ui.textSize.addEventListener('change', () => setTextSize(Number(ui.textSize.value)));
ui.textSize.addEventListener('keydown', (event) => event.stopPropagation());

for (const button of ui.toolbar.querySelectorAll('[data-size-step]')) {
  button.addEventListener('click', () => {
    setTextSize(Number(ui.textSize.value) + Number(button.dataset.sizeStep));
  });
}

for (const button of ui.toolbar.querySelectorAll('[data-align]')) {
  button.addEventListener('click', () => {
    editor?.setTextStyle({ align: button.dataset.align });
    saveSettings({ textAlign: button.dataset.align });
  });
}

for (const [button, key] of [
  [ui.textBold, 'bold'], [ui.textItalic, 'italic'], [ui.textUnderline, 'underline'],
]) {
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-pressed') !== 'true';
    editor?.setTextStyle({ [key]: next });
    saveSettings({ [`text${key[0].toUpperCase()}${key.slice(1)}`]: next });
  });
}

// THE CANVAS MENU
//
// The paint order has existed since the first shape was drawn and there has
// never been a way to change it: a box drawn over a highlighter covered it for
// good, and the only repair was to delete both and draw them again. A right
// click is where people look for this, and four more toolbar buttons for
// something reached once in twenty captures is the wrong trade.

/** Grey out what cannot happen, rather than hiding it and resizing the menu. */
function showMenuState(state) {
  for (const item of ui.ctx.querySelectorAll('[data-order]')) {
    const up = item.dataset.order === 'front' || item.dataset.order === 'forward';
    item.disabled = up ? !state.canRaise : !state.canLower;
  }
  ui.ctx.querySelector('[data-ctx="delete"]').disabled = state.selectedCount === 0;
}

function closeCanvasMenu() {
  ui.ctx.hidden = true;
}

/**
 * Put the menu at the pointer, and keep it on screen.
 *
 * Measured after it is shown, because a hidden element has no size. A menu that
 * opens near the bottom right corner would otherwise hang off the window and
 * give the page scrollbars, which is the same problem `keepInView` solves for
 * the toolbar popovers and is solved the same way.
 */
function openCanvasMenu(x, y) {
  ui.ctx.hidden = false;
  showMenuState(editor.state);
  const gap = 8;
  const room = {
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  };
  const box = ui.ctx.getBoundingClientRect();
  ui.ctx.style.left = `${Math.max(gap, Math.min(x, room.w - box.width - gap))}px`;
  ui.ctx.style.top = `${Math.max(gap, Math.min(y, room.h - box.height - gap))}px`;
}

ui.canvas.addEventListener('contextmenu', (event) => {
  // Empty canvas keeps Chrome's own menu, which offers "Save image as" on a
  // canvas. Replacing that with a menu where every item is greyed out would be
  // a straight loss.
  if (!editor?.menuTarget(event)) {
    closeCanvasMenu();
    return;
  }
  event.preventDefault();
  openCanvasMenu(event.clientX, event.clientY);
});

ui.ctx.addEventListener('click', (event) => {
  const item = event.target.closest('[data-order], [data-ctx]');
  if (!item || item.disabled) return;
  closeCanvasMenu();
  if (item.dataset.order) editor?.reorder(item.dataset.order);
  else if (item.dataset.ctx === 'delete') editor?.deleteSelection();
});

// Anywhere else dismisses it, including a left click on the canvas, which is
// how every menu of this kind behaves.
document.addEventListener('pointerdown', (event) => {
  if (!ui.ctx.hidden && !ui.ctx.contains(event.target)) closeCanvasMenu();
});

// THE FRAME AROUND A LABEL, AND THE PLATE BEHIND IT
//
// Both are properties of the text shape itself: the frame is its stroke and the
// plate is its fill. That is why these and the Border and Fill wells never
// disagree about a selected caption. They all read and write the one shape.

ui.plateOpacity.addEventListener('input', () => {
  const percent = Number(ui.plateOpacity.value);
  ui.plateOpacityOut.textContent = `${percent}%`;
  // setTextStyle gives the plate a colour when this is raised off nought and it
  // has none, because raising it is the reader asking for a plate and a plate
  // with no colour cannot answer.
  editor?.setTextStyle({ fillOpacity: percent / 100 });
  saveSettings({ textPlateOpacity: percent / 100 });
});

function setFrameWidth(px) {
  const next = Math.min(64, Math.max(1, Math.round(px) || 1));
  ui.frameWidth.value = String(next);
  editor?.setTextStyle({ width: next });
  saveSettings({ textFrameWidth: next });
}

ui.frameWidth.addEventListener('change', () => setFrameWidth(Number(ui.frameWidth.value)));
ui.frameWidth.addEventListener('keydown', (event) => event.stopPropagation());

for (const button of ui.toolbar.querySelectorAll('[data-frame-step]')) {
  button.addEventListener('click', () => {
    setFrameWidth(Number(ui.frameWidth.value) + Number(button.dataset.frameStep));
  });
}

// ZOOM, AND THE OVERVIEW PANE
//
// Zoom is a CSS width on the canvas and nothing else. The page keeps doing the
// scrolling, which is the decision the rest of this depends on: the editor
// converts every pointer position through `canvas.getBoundingClientRect()`, and
// the inline text box is positioned from the same box plus the window's scroll
// offset. Put the canvas in its own scrolling container instead, which is the
// obvious way to build a zoom, and both of those break at once. That is
// LIMITATIONS L17, and this is why it never fires.

const ZOOM_MIN = 10;
const ZOOM_MAX = 400;

// 'width', 'height' or a number of per cent. A fit is a rule rather than a
// value, so the picture goes on fitting when the window is resized.
let zoomFit = 'width';

/**
 * A percentage, or the size a capture opens at.
 *
 * The `isFinite` guard is not decoration. Math.round(NaN) is NaN, and NaN
 * survives both Math.max and Math.min, so without it a field that briefly held
 * something unreadable would set the canvas width to "NaNpx" and the picture
 * would vanish with nothing thrown.
 */
const clampZoom = (percent) =>
  (Number.isFinite(percent) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent))) : 100);

/**
 * The per cent the current rule works out to, for this window and this image.
 *
 * The image is read off the canvas element rather than out of the editor's
 * state, because `editor.state` carries the style and not the crop: the crop is
 * on the object handed to `onChange`, which is a different shape. Reading the
 * canvas is also simply true by construction, since the canvas is resized to the
 * crop and there is no second copy of the number to fall out of step.
 */
function zoomPercent() {
  const crop = { w: ui.canvas.width, h: ui.canvas.height };
  if (!crop.w || !crop.h) return 100;
  // 100% means one pixel of the capture to one pixel of this screen, which is
  // what it means in an image viewer and is the size at which a redaction can be
  // judged. It is not the size the page was: a retina capture holds two device
  // pixels per CSS pixel, so the page at its own size is 50% here.
  const room = document.documentElement.clientWidth - 48;
  const tall = window.innerHeight - ui.toolbar.offsetHeight - 48;
  if (zoomFit === 'width') return clampZoom((room / crop.w) * 100);
  if (zoomFit === 'height') return clampZoom((tall / crop.h) * 100);
  return clampZoom(zoomFit);
}

function applyZoom() {
  if (!editor || ui.canvas.hidden || !ui.canvas.width) return;
  const crop = { w: ui.canvas.width };
  const percent = zoomPercent();
  const wanted = `${Math.round((crop.w * percent) / 100)}px`;
  // Whether anything actually moved. render() ends by calling notify(), so a
  // redraw from inside a change handler would call this again: without this the
  // loop only stops because the numbers stop changing, and that is not a thing
  // to rely on. D58.
  const moved = ui.canvas.style.width !== wanted;
  ui.canvas.style.width = wanted;
  // A fit means the picture never overflows, so the old max-width rule still
  // holds it. Above 100% it has to be allowed to be wider than the window, or
  // zooming in would do nothing at all.
  ui.canvas.style.maxWidth = zoomFit === 'width' ? '100%' : 'none';

  ui.zoomLevel.value = String(percent);
  // Not while it is being typed into: rewriting the field under the caret is how
  // a control refuses to let you type 25 because it saw the 2 first.
  if (document.activeElement !== ui.zoomExact) ui.zoomExact.value = String(percent);
  for (const button of ui.toolbar.querySelectorAll('[data-fit]')) {
    button.setAttribute('aria-pressed', String(button.dataset.fit === zoomFit));
  }

  // Handles and the hover outline are drawn at a fixed size on screen, worked
  // out from the ratio between the image and the box it is shown in, so a zoom
  // that did not redraw would leave them the size they were at the old one.
  if (moved) editor.render();
  showOverview();
}

/**
 * The pane, and where the marker sits in it.
 *
 * A schematic of a page rather than a picture of the capture: the same sheet the
 * progress popup draws while it is capturing, so a reader who has seen one
 * recognises the other. It also means there is nothing to redraw, which matters
 * on a capture that is twelve thousand pixels tall and being scrolled.
 */
function showOverview() {
  const pane = ui.overview;
  if (!editor || ui.canvas.hidden || pane.dataset.off === 'yes') {
    pane.hidden = true;
    return;
  }
  const box = ui.canvas.getBoundingClientRect();
  if (!box.width || !box.height) {
    pane.hidden = true;
    return;
  }

  // Nothing to navigate: the marker would cover the sheet and say nothing.
  const spare = 4;
  const taller = box.height > window.innerHeight - ui.toolbar.offsetHeight + spare;
  const wider = box.width > document.documentElement.clientWidth + spare;
  if (!taller && !wider) {
    pane.hidden = true;
    return;
  }
  pane.hidden = false;

  // The sheet keeps the capture's proportions inside a fixed box, so a long page
  // is a long sheet and a wide one is a wide sheet, and neither can grow off the
  // side of the window.
  const fit = Math.min(70 / box.width, 210 / box.height);
  ui.overviewSheet.style.width = `${Math.round(box.width * fit)}px`;
  ui.overviewSheet.style.height = `${Math.round(box.height * fit)}px`;

  // Where the window sits over the picture, in the picture's own terms. The
  // canvas is in the document, so its top in document coordinates is its box
  // top plus however far the page has been scrolled.
  const top = window.scrollY - (box.top + window.scrollY);
  const left = window.scrollX - (box.left + window.scrollX);
  const seenH = Math.min(box.height, window.innerHeight - ui.toolbar.offsetHeight);
  const seenW = Math.min(box.width, document.documentElement.clientWidth);

  const port = ui.overviewPort;
  port.style.top = `${Math.max(0, Math.min(100, (top / box.height) * 100))}%`;
  port.style.height = `${Math.max(3, Math.min(100, (seenH / box.height) * 100))}%`;
  port.style.left = `${Math.max(0, Math.min(100, (left / box.width) * 100))}%`;
  port.style.width = `${Math.max(3, Math.min(100, (seenW / box.width) * 100))}%`;
}

/** Scroll so that a point on the sheet is the middle of what is on screen. */
function jumpTo(event) {
  const box = ui.canvas.getBoundingClientRect();
  const sheet = ui.overviewSheet.getBoundingClientRect();
  if (!sheet.height || !box.height) return;
  const downSheet = (event.clientY - sheet.top) / sheet.height;
  const acrossSheet = (event.clientX - sheet.left) / sheet.width;
  const seenH = window.innerHeight - ui.toolbar.offsetHeight;
  const seenW = document.documentElement.clientWidth;
  window.scrollTo({
    top: (box.top + window.scrollY) + downSheet * box.height - seenH / 2,
    left: (box.left + window.scrollX) + acrossSheet * box.width - seenW / 2,
    behavior: 'auto',
  });
}

ui.overviewSheet.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  ui.overviewPort.classList.add('held');
  ui.overviewSheet.setPointerCapture(event.pointerId);
  jumpTo(event);
});
ui.overviewSheet.addEventListener('pointermove', (event) => {
  if (!ui.overviewSheet.hasPointerCapture?.(event.pointerId)) return;
  jumpTo(event);
});
ui.overviewSheet.addEventListener('pointerup', (event) => {
  ui.overviewPort.classList.remove('held');
  if (ui.overviewSheet.hasPointerCapture?.(event.pointerId)) {
    ui.overviewSheet.releasePointerCapture(event.pointerId);
  }
});

ui.zoomLevel.addEventListener('input', () => {
  zoomFit = clampZoom(Number(ui.zoomLevel.value));
  applyZoom();
});

/** Typing a percentage. The same control as the slider, reached the other way. */
function typeZoom() {
  const wanted = Number(ui.zoomExact.value);
  // An empty or unreadable field is someone mid-edit, not a request to zoom to
  // nothing. It is left alone until it says a number, and put back on blur.
  if (!Number.isFinite(wanted)) return;
  zoomFit = clampZoom(wanted);
  applyZoom();
}

ui.zoomExact.addEventListener('input', typeZoom);
ui.zoomExact.addEventListener('change', () => {
  typeZoom();
  // Whatever was typed, the field ends up showing what the picture is actually
  // at, which is the clamp made visible rather than silently applied.
  ui.zoomExact.value = String(zoomPercent());
});
// The editor binds single letters to tools, so a field that can hold "100" has
// to stop them before they reach it. Every other field here does the same.
ui.zoomExact.addEventListener('keydown', (event) => event.stopPropagation());

for (const button of ui.toolbar.querySelectorAll('[data-fit]')) {
  button.addEventListener('click', () => {
    zoomFit = button.dataset.fit;
    applyZoom();
  });
}

// The marker follows the window, and a fit follows the window's size.
window.addEventListener('scroll', showOverview, { passive: true });
window.addEventListener('resize', () => applyZoom());

// F3, THE RATING NUDGE
//
// The counting happens here rather than in the worker because everything the
// decision needs is already here: the plan says whether the capture came out
// whole, and a count kept in the tab that can see that cannot disagree with what
// the user is looking at.

async function maybeNudge(plan, settings) {
  const url = reviewsUrl(chrome.runtime.id);
  // Nothing to rate. An unpacked build or anything else whose id is not a real
  // one simply never asks, which is the honest answer rather than a link.
  if (!url) return;

  const history = {
    captureCount: (settings.captureCount ?? 0) + 1,
    nudgesShown: settings.nudgesShown ?? 0,
    nudgeDone: settings.nudgeDone === true,
  };
  const ask = shouldNudge(history, { clean: captureWasClean(plan) });

  // The count goes up whatever happens, including on the captures that are not
  // the moment to ask: it is a count of captures, not of chances to ask.
  await saveSettings({
    captureCount: history.captureCount,
    ...(ask ? { nudgesShown: history.nudgesShown + 1 } : {}),
  });
  if (!ask) return;

  ui.nudge.hidden = false;
  ui.nudgeRate.onclick = () => {
    // The browser opens the store, not the extension. Same reasoning that lets
    // an upload be handed off: connect-src 'none' stays literally true.
    chrome.tabs.create({ url });
    dismissNudge();
  };
  ui.nudgeTell.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html#support') });
    dismissNudge();
  };
  ui.nudgeNever.onclick = () => {
    saveSettings({ nudgeDone: true });
    dismissNudge();
  };
}

function dismissNudge() {
  ui.nudge.hidden = true;
}

// WHAT THE USER CHOSE TO SEE

/** Controls switched off on the options page. Never the settings button. */
function applyHiddenButtons(hidden) {
  // The whole document, not just the toolbar. The overview pane is a control
  // like any other and the README promises every one of them can be switched
  // off, but it is fixed to the window rather than sitting in the toolbar, so a
  // query scoped to the toolbar would have quietly exempted it.
  for (const holder of document.querySelectorAll('[data-button]')) {
    if (holder === ui.overview) {
      // The pane owns its own `hidden`, because it also takes itself away when
      // the whole capture is already on screen. The switch is recorded here and
      // read there, so the two cannot fight over the same attribute.
      holder.dataset.off = hidden.includes('overview') ? 'yes' : 'no';
      continue;
    }
    holder.hidden = hidden.includes(holder.dataset.button);
  }
  // Hidden is not the same as having nothing to show. The pane decides for
  // itself whether the capture needs it, and that decision has to be re-made
  // whenever the switch changes.
  showOverview();
}

/**
 * Hide individual shapes from the Shapes popover.
 *
 * The README promises every control can be switched off individually. At five
 * shapes behind one switch that was close enough to true; at twelve it would
 * have been false for the densest surface in the product.
 *
 * A group whose shapes are all hidden loses its heading with them, so a label
 * never sits above an empty row.
 */
function applyHiddenShapes(hidden) {
  for (const cell of ui.toolbar.querySelectorAll('[data-shape]')) {
    cell.hidden = hidden.includes(cell.dataset.shape);
  }
  for (const block of ui.toolbar.querySelectorAll('#pop-shapes .grp-block')) {
    const visible = [...block.querySelectorAll('[data-shape]')].some((cell) => !cell.hidden);
    block.hidden = !visible;
  }
  // The combo glyph shows the last shape used, so it must not go on offering a
  // shape that is no longer reachable: clicking it would draw something the
  // popover says is not there.
  if (hidden.includes(lastShape)) {
    const next = SHAPE_TOOLS.find((kind) => !hidden.includes(kind));
    if (next) {
      rememberShape(next);
      if (SHAPE_TOOLS.includes(editor?.state.tool)) selectTool(next);
      else showStyle(editor?.state, editor?.state?.tool);
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.hiddenButtons) applyHiddenButtons(changes.hiddenButtons.newValue ?? []);
  if (changes.hiddenShapes) applyHiddenShapes(changes.hiddenShapes.newValue ?? []);
});

ui.undo.addEventListener('click', () => editor?.undo());
ui.redo.addEventListener('click', () => editor?.redo());
ui.delete.addEventListener('click', () => editor?.deleteSelection());
/**
 * Reset does the obvious thing for where you are.
 *
 * With edits on the canvas it removes them, which is what it has always done.
 * With none, it puts the drawing style back to what the extension shipped with:
 * the tool, the colours, the stroke, the fill and the type. Those are remembered
 * between captures on purpose, so there has to be a way back, and a fresh
 * capture is exactly the moment when "reset" cannot mean anything else.
 *
 * It deliberately does not touch the output format, the toolbar switches or the
 * capture settings. Those are separate choices and sweeping them up here would
 * be a surprise, which is the one thing a reset button must never be.
 */
function resetLabel(edited) {
  return edited
    ? 'Remove every edit and go back to the original capture'
    : 'Put the tools and colours back to their defaults';
}

ui.revert.addEventListener('click', async () => {
  if (!editor) return;

  if (editor.state.edited) {
    editor.reset();
    say('Back to the original capture.');
    return;
  }

  const style = defaultStyle();
  await saveSettings(style);
  editor.applyStyle(style);
  selectTool(style.tool);
  say('Tools and colours are back to their defaults.');
});

document.addEventListener('keydown', (event) => {
  if (!editor) return;
  // Never steal keys from anything the reader is typing into. This used to test
  // for HTMLInputElement alone, which stopped covering the inline text box the
  // moment that became a textarea: the box stops propagation itself, so nothing
  // broke, but a guard that quietly no longer guards is worth more than the one
  // line it costs to keep true.
  if (event.target?.closest?.('input, textarea, select')) return;

  const key = event.key.toLowerCase();

  if (event.metaKey || event.ctrlKey) {
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
    } else if (key === 'c') {
      event.preventDefault();
      ui.copy.click();
    } else if (key === 'a') {
      // Nothing on the canvas competes for Cmd+A: the inline text box stops
      // propagation itself, and the guard above returns for any field.
      event.preventDefault();
      editor.selectAll();
    } else if (ORDER_ENDS[event.key]) {
      // All the way to one end. `event.key`, not the lowercased copy: these are
      // punctuation and lowercasing a bracket does nothing but hide the intent.
      event.preventDefault();
      editor.reorder(ORDER_ENDS[event.key]);
    }
    return;
  }

  // A pending crop is a question, so it answers Enter and Escape before anything
  // else does. Every confirm dialogue in every application works this way.
  if (pendingCrop) {
    if (key === 'enter') {
      event.preventDefault();
      ui.cropApply.click();
      return;
    }
    if (key === 'escape') {
      event.preventDefault();
      ui.cropCancel.click();
      return;
    }
  }

  if (key === 'escape') {
    openMenu(false);
    closePopovers(null);
    closeCanvasMenu();
    // A drag in progress is the most recent thing Escape could mean, so it
    // answers that first. Only when there is nothing to abandon does it fall
    // through to dropping the selection.
    if (!editor.cancelDrag()) editor.deselect();
  } else if (key === 'backspace' || key === 'delete') {
    if (editor.deleteSelection()) event.preventDefault();
  } else if (NUDGES[event.key]) {
    // A pixel at a time, ten with Shift. The whole selection moves, which is
    // why this was cheaper to build after multi-select than before it.
    const [dx, dy] = NUDGES[event.key];
    const step = event.shiftKey ? 10 : 1;
    if (editor.nudge(dx * step, dy * step)) event.preventDefault();
  } else if (ORDER_KEYS[event.key]) {
    // One step through the paint order. Tested before the tool keys because a
    // bracket is not a letter and could never be one of them, and read here so
    // the pair with the accelerator above stays in one place.
    event.preventDefault();
    editor.reorder(ORDER_KEYS[event.key]);
  } else if (TOOL_KEYS[key]) {
    event.preventDefault();
    selectTool(TOOL_KEYS[key]);
  }
});

// A nudge burst ends when the key comes up, so holding an arrow key is one
// undo step rather than one per repeat.
document.addEventListener('keyup', (event) => {
  if (NUDGES[event.key]) editor?.endNudge();
});

// EXPORTING

/**
 * The visible canvas already holds the crop and every annotation, so exporting
 * is just encoding it. What you see is exactly what you get.
 */
async function encode(format, { quiet = false } = {}) {
  const canvas = editor.flatten();
  const spec = OUTPUT_FORMATS[format] ?? OUTPUT_FORMATS.png;
  // `quiet` is for measuring a size rather than saving a file: the PDF path
  // narrates its pages on the status line, and a measurement narrating itself
  // would overwrite whatever the reader was actually told last.
  if (format === 'pdf') return { blob: await encodePdf(canvas, quiet), extension: spec.extension };
  // `quality` is passed only to the encoders that take one. Handing a quality to
  // the PNG encoder is not an error, it is simply ignored, but passing it says
  // something untrue about what PNG does.
  const blob = await encodeOrThrow(canvas, spec.mime, spec.quality ? quality / 100 : undefined);
  return { blob, extension: spec.extension };
}

/**
 * The same pixels, in a PDF.
 *
 * Written page by page rather than as one enormous one: a full page capture is
 * often ten screens tall, and a single page that shape opens at 4% and cannot be
 * printed. Each page is a slice of the canvas at its own width, so nothing is
 * scaled, nothing is resampled and the seams land on exact pixel rows.
 *
 * Slicing is also what keeps this affordable. The samples have to exist
 * uncompressed for a moment, and one 1265 x 16384 image is 62 MB of them; a
 * slice is a tenth of that and only one is alive at a time.
 */
async function encodePdf(canvas, quiet = false) {
  const slices = planPdfPages(canvas.width, canvas.height);
  const scratch = document.createElement('canvas');
  const ink = scratch.getContext('2d', { alpha: false, willReadFrequently: true });
  const pages = [];

  for (const [index, slice] of slices.entries()) {
    if (slices.length > 1 && !quiet) say(`Building the PDF, page ${index + 1} of ${slices.length}…`);
    scratch.width = canvas.width;
    scratch.height = slice.h;
    ink.drawImage(canvas, 0, slice.y, canvas.width, slice.h, 0, 0, canvas.width, slice.h);
    const { data } = ink.getImageData(0, 0, canvas.width, slice.h);
    pages.push({
      width: canvas.width,
      height: slice.h,
      data: await deflate(rgbaToRgb(data)),
    });
  }

  // Let go of the scratch canvas before the file is assembled: on a long capture
  // both alive at once is the peak this function has to survive.
  scratch.width = 0;
  scratch.height = 0;
  return new Blob([buildPdf(pages)], { type: 'application/pdf' });
}

// Enter in the filename box means save, which is what every save dialog does.
ui.filename.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !ui.download.disabled) save(format);
});

/** Put the finished image on the clipboard. Returns false and says why if not. */
async function copyToClipboard() {
  try {
    const { blob } = await encode('png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch (error) {
    say(`Could not copy: ${error?.message ?? error}`, true);
    return false;
  } finally {
    editor.restoreSelection();
  }
}

ui.copy.addEventListener('click', async () => {
  if (!editor) return;
  if (await copyToClipboard()) {
    markSaved();
    confirmOn(ui.copy, 'Copied to the clipboard.');
  }
});

// UPLOAD, BY HANDING OFF
//
// The extension never uploads. It cannot: connect-src 'none' means Chrome will
// not carry an outbound request from this page, and that line is what the whole
// project rests on. So this copies the image and opens the host you picked in a
// new tab, and you paste it there. The request is made by that site, in a tab
// you can see, under whatever account you already have with them.
//
// The alternative, posting to a host's API, would need a connect-src allowance
// in the manifest. Extension CSP is static, so that allowance would ship
// permanently to every user, including everyone who never uploads. See
// docs/DECISIONS.md D16.
for (const host of ui.toolbar.querySelectorAll('[data-host]')) {
  host.addEventListener('click', async () => {
    if (!editor) return;
    closePopovers(null);
    const name = host.dataset.hostName;
    if (!(await copyToClipboard())) return;
    markSaved();
    confirmOn(ui.upload, `Copied. Paste it on ${name}, which is opening in a new tab.`);
    chrome.tabs.create({ url: host.dataset.host, active: true });
  });
}

/**
 * @param {string} chosen png or jpeg
 * @param {{ ask?: boolean }} options ask:false when there is no click to hang a
 *   permission prompt on, which is the straight-to-a-file path.
 * @returns {Promise<number>} Chrome's download id, or 0 if nothing was written
 */
async function save(chosen, { ask = true } = {}) {
  if (!editor) return 0;

  format = chosen;
  showExtension();
  saveSettings({ format: chosen });

  // Asked for here, on a real click, rather than at install: this is the only
  // moment the permission is needed, and the only moment a user can judge the
  // request. Chrome requires the gesture, which a popup-less toolbar click
  // cannot supply, another reason the result lives in a tab.
  const granted = ask
    ? await chrome.permissions.request({ permissions: ['downloads'] })
    : await chrome.permissions.contains({ permissions: ['downloads'] });
  if (!granted) {
    say('Saving needs permission to use Chrome downloads. You can still right-click the image and save it.', true);
    return 0;
  }

  ui.download.disabled = true;
  try {
    const { blob, extension } = await encode(chosen);
    const url = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({
      url,
      filename: applyFilename(ui.filename.value, extension),
      saveAs: false,
    });
    // Chrome reads the blob asynchronously; releasing it immediately can cut
    // the download off.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    markSaved();
    confirmOn(
      ui.download,
      `Saved as ${extension.toUpperCase()}${edited ? ', with your edits' : ''}, ${formatSize(blob.size)}.`,
    );
    return id ?? 0;
  } catch (error) {
    say(`Could not save: ${error?.message ?? error}`, true);
    return 0;
  } finally {
    editor.restoreSelection();
    ui.download.disabled = false;
  }
}

for (const item of ui.formats.querySelectorAll('[data-format]')) {
  item.addEventListener('click', () => {
    openMenu(false);
    save(item.dataset.format);
  });
}

// WHAT EACH FORMAT WOULD ACTUALLY COST
//
// A quality slider with no readout is guesswork. Nobody moves one because they
// want "quality 78"; they move it because the file is too big to attach, and
// without a number the control cannot answer the only question being asked.
//
// So these sizes are real. Each is the capture encoded for that format, at the
// quality currently set, measured while the menu is open. Nothing is estimated
// from a thumbnail, because a compressed size does not scale with pixel count
// and a wrong number is worse than none.
//
// The cost is paid where it is affordable. Measuring happens only while the menu
// is open, one format at a time with a yield between, cheapest first, so the two
// rows the slider moves answer immediately and the PDF, which has to deflate
// twenty megabytes of samples, arrives a moment later. Everything is cached
// against the quality it was measured at, and the whole cache is dropped the
// moment the image changes.

/** Measured sizes, keyed by format and by the quality that produced them. */
const sizes = new Map();
/**
 * What the image was when these were measured.
 *
 * A description of the picture, not a count of notifications. The first draft
 * bumped a generation counter from `onChange` and it never measured anything:
 * `render()` ends by notifying, `flatten()` renders twice and `restoreSelection`
 * renders again, so every measurement invalidated itself before its own encoder
 * had finished. Selection, hover and the crop bar all repaint too, and none of
 * them changes a single pixel of what a saved file would contain.
 *
 * The stamp moves when the drawing does: a commit on the history, a shape added
 * or removed, or a different crop. It does not move for anything that is merely
 * drawn on top of the image and hidden again before an export.
 */
let imageStamp = '';
let measuring = false;
// Cheapest first. The two the slider moves are also the two worth having first.
const SIZE_ORDER = ['jpeg', 'webp', 'png', 'pdf'];

/** Lossless formats measure once; the lossy ones measure once per quality. */
const sizeKey = (name) => `${name}:${OUTPUT_FORMATS[name].quality ? quality : 0}`;

function showSizes() {
  for (const name of DOWNLOAD_FORMATS) {
    const cell = ui.formats.querySelector(`[data-size="${name}"]`);
    if (!cell) continue;
    const bytes = sizes.get(sizeKey(name));
    // null is a format this capture cannot be encoded as, which is a real
    // answer and a different one from "not measured yet".
    cell.textContent = bytes === undefined ? '…' : bytes === null ? 'too large' : formatSize(bytes);
    cell.classList.toggle('pending', bytes === undefined);
  }
}

async function measureSizes() {
  if (!editor || measuring || ui.formats.hidden) return;
  measuring = true;
  try {
    // Restarted rather than abandoned when the image or the quality changes:
    // returning would leave `measuring` true until the finally ran, and the
    // caller that noticed the change cannot start a replacement while it is.
    // The attempt limit is against an image being edited faster than a format
    // can be measured, where giving up is right because the next edit restarts.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const mine = imageStamp;
      let complete = true;
      for (const name of SIZE_ORDER) {
        // The menu is closed, so nobody is reading these and the work is waste.
        if (ui.formats.hidden) return;
        const key = sizeKey(name);
        if (sizes.has(key)) continue;
        let bytes = null;
        try {
          bytes = (await encode(name, { quiet: true })).blob.size;
        } catch {
          // A save says why on the status line. A measurement is not something
          // the reader asked for, so the row says it and nothing interrupts.
        } finally {
          editor.restoreSelection();
        }
        if (mine !== imageStamp) {
          complete = false;
          break;
        }
        sizes.set(key, bytes);
        showSizes();
        // One turn of the event loop between formats, so a click, a keystroke
        // or the slider is answered rather than queued behind a PDF.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (complete) return;
    }
  } finally {
    measuring = false;
  }
}

/**
 * Called on every repaint. Does nothing unless the picture actually changed.
 *
 * @param {{crop: {w: number, h: number}}} state the editor's own report
 */
function forgetSizes(state) {
  if (!editor) return;
  const { past, future, present } = editor.document;
  const stamp = `${past.length}.${future.length}.${present.shapes.length}.${state.crop.w}x${state.crop.h}`;
  if (stamp === imageStamp) return;
  imageStamp = stamp;
  sizes.clear();
  // Nothing on screen to correct while the menu is shut.
  if (ui.formats.hidden) return;
  showSizes();
  measureSizes();
}

function setQuality(percent) {
  quality = Math.min(100, Math.max(40, Math.round(percent) || 92));
  ui.quality.value = String(quality);
  ui.qualityOut.textContent = `${quality}%`;
}

ui.quality.addEventListener('input', () => {
  setQuality(Number(ui.quality.value));
  showSizes();
  measureSizes();
});

// Saved on release rather than on every step of the drag: `input` fires per
// pixel of travel and each one would be a write to storage.
ui.quality.addEventListener('change', () => saveSettings({ quality }));
ui.quality.addEventListener('keydown', (event) => event.stopPropagation());

// THE CONNECTION

const captureId = location.hash.slice(1);

if (!captureId) {
  // Opened directly rather than by a capture.
  say('No capture in progress. Click the OpenFullPage button on the page you want.');
} else {
  const port = chrome.runtime.connect({ name: `capture:${captureId}` });
  // Said once. A mismatch is true of every message that follows, and repeating
  // it for each of a hundred tiles would bury it.
  let mismatched = false;

  port.onMessage.addListener((message) => {
    // The extension can be updated while this tab stays exactly as it was, and
    // the new worker will post to it regardless. Reading a message we do not
    // understand is the one failure worth catching here, because it fails
    // silently: a progress bar that never fills and no error anywhere.
    if (!speaksOurProtocol(message)) {
      if (!mismatched) {
        mismatched = true;
        say(PROTOCOL_MISMATCH, true);
      }
      return;
    }

    queue = queue
      .then(async () => {
        if (message.type === 'plan') {
          plan = message;
          pageTitle = message.title;
          pageUrl = message.url ?? '';
          settings = message.settings ?? settings;
          // No title row any more, so the tab itself carries the page name.
          document.title = message.title ? `${message.title}. Capture` : 'Capture';
          say('Assembling the capture…');
        } else if (message.type === 'tile') {
          await drawTile(message);
        } else if (message.type === 'finish') {
          await finish();
        } else if (message.type === 'error') {
          say(message.message, true);
        }
      })
      .catch((error) => say(String(error?.message ?? error), true));
  });

  port.onDisconnect.addListener(() => {
    queue = queue.then(() => {
      if (mismatched) return;
      if (!editor && !ui.status.classList.contains('error')) {
        say('The capture stopped before it finished.', true);
      }
    });
  });
}
