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
import { CORNERED_KINDS, SHAPE_TOOLS, kindOfTool } from '../lib/edit.js';
import { DOWNLOAD_FORMATS, OUTPUT_FORMATS, encodeOrThrow, extensionOf } from '../lib/encode.js';
import { PROTOCOL_MISMATCH, speaksOurProtocol } from '../lib/protocol.js';
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
  fillOpacity: el('fill-opacity'),
  fillOpacityOut: el('fill-opacity-out'),
  textFamily: el('text-family'),
  textWell: el('text-well'),
  textSize: el('text-size'),
  textBold: el('text-bold'),
  textItalic: el('text-italic'),
  textUnderline: el('text-underline'),
  frameOn: el('frame-on'),
  framePlate: el('frame-plate'),
  frameWell: el('frame-well'),
  frameWidth: el('frame-width'),
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
    },
  });

  buildPalettes();
  editor.render();
  applyHiddenButtons(settings.hiddenButtons ?? []);
  applyHiddenShapes(settings.hiddenShapes ?? []);

  ui.canvas.hidden = false;
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
 * Fill the colour palettes.
 *
 * Text is in the list but has no `data-grid`, so it gets the ten quick colours
 * and the system picker and not the sixty step grid. Border and fill each own a
 * whole popover and can afford one; the text inspector is a mixed panel that
 * already carries a family, a size, three type toggles and four alignments, and
 * sixty more swatches in it would bury all of them. Arbitrary colour is still
 * one click away through the picker and the hex field.
 */
function buildPalettes() {
  for (const kind of ['border', 'fill', 'text', 'frame']) {
    const quick = ui.toolbar.querySelector(`[data-quick="${kind}"]`);
    const grid = ui.toolbar.querySelector(`[data-grid="${kind}"]`);
    if (!quick || quick.childElementCount > 0) continue;

    for (const colour of QUICK_COLOURS) quick.append(swatchButton(colour, kind));
    if (!grid) continue;
    for (let row = 0; row < GREYS.length; row += 1) {
      grid.append(swatchButton(GREYS[row], kind));
      for (const colour of QUICK_COLOURS.slice(0, 9)) {
        grid.append(swatchButton(shade(colour, row), kind));
      }
    }
  }
}

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
  markPressed('[data-paint="border"]', (b) => b.dataset.colour === style.colour);
  setHex('border', style.colour);

  ui.fillGlyph.setAttribute('fill', style.fill ?? 'none');
  ui.fillGlyph.setAttribute('fill-opacity', String(style.fill ? style.fillOpacity : 1));
  showGlyph(ui.fillSlash, !style.fill);
  markPressed('[data-paint="fill"]', (b) => Boolean(style.fill) && b.dataset.colour === style.fill);
  ui.toolbar.querySelector('[data-fill="none"]').setAttribute('aria-pressed', String(!style.fill));
  if (style.fill) setHex('fill', style.fill);
  ui.fillOpacity.value = String(Math.round(style.fillOpacity * 100));
  ui.fillOpacityOut.textContent = `${Math.round(style.fillOpacity * 100)}%`;

  ui.textFamily.value = style.text.family;
  ui.textSize.value = String(style.text.size);
  ui.textBold.setAttribute('aria-pressed', String(style.text.bold));
  ui.textItalic.setAttribute('aria-pressed', String(style.text.italic));
  ui.textUnderline.setAttribute('aria-pressed', String(style.text.underline));
  markPressed('[data-align]', (b) => b.dataset.align === style.text.align);
  markPressed('[data-paint="text"]', (b) => b.dataset.colour === style.text.ink);
  ui.textWell.style.background = style.text.ink;
  setHex('text', style.text.ink);

  // The frame and the plate. Off is null, which is a value rather than an
  // absence, so the well keeps showing the colour the switch would put back.
  const frame = style.text.colour ?? null;
  const plate = style.text.fill ?? null;
  if (frame) lastFrameColour = frame;
  if (plate) lastPlateColour = plate;
  ui.frameOn.setAttribute('aria-checked', String(Boolean(frame)));
  ui.framePlate.setAttribute('aria-checked', String(Boolean(plate)));
  ui.frameWell.style.background = frame ?? lastFrameColour;
  markPressed('[data-paint="frame"]', (b) => b.dataset.colour === frame);
  setHex('frame', frame ?? lastFrameColour);
  ui.frameWidth.value = String(style.text.width ?? 2);
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
  } else {
    editor?.setFill(colour);
    saveSettings({ fill: colour });
  }
}

for (const pop of ui.toolbar.querySelectorAll('.pop.paint')) {
  pop.addEventListener('click', (event) => {
    const swatch = event.target.closest?.('[data-paint]');
    if (swatch) applyPaint(swatch.dataset.paint, swatch.dataset.colour);
  });
}

ui.toolbar.querySelector('[data-fill="none"]').addEventListener('click', () => {
  editor?.setFill(null);
  saveSettings({ fill: null });
});

ui.fillOpacity.addEventListener('input', () => {
  const percent = Number(ui.fillOpacity.value);
  ui.fillOpacityOut.textContent = `${percent}%`;
  editor?.setFillOpacity(percent / 100);
  saveSettings({ fillOpacity: percent / 100 });
});

for (const kind of ['border', 'fill', 'text', 'frame']) {
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

ui.frameOn.addEventListener('click', () => {
  const on = ui.frameOn.getAttribute('aria-checked') !== 'true';
  const colour = on ? lastFrameColour : null;
  editor?.setTextStyle({ colour });
  saveSettings({ textFrameColour: colour });
});

ui.framePlate.addEventListener('click', () => {
  const on = ui.framePlate.getAttribute('aria-checked') !== 'true';
  if (!on) {
    editor?.setTextStyle({ fill: null });
    saveSettings({ textFramePlate: null });
    return;
  }
  // A plate exists to make words readable over a busy screenshot, so it starts
  // opaque. The 35% that a fill starts at is tuned for shading a box, and a
  // plate at 35% is a wash rather than a plate. This is a starting value on a
  // shape that had no fill at all, not an override of a choice already made:
  // the opacity slider in the Fill popover still owns it from here.
  editor?.setTextStyle({ fill: lastPlateColour, fillOpacity: 1 });
  saveSettings({ textFramePlate: lastPlateColour });
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

// WHAT THE USER CHOSE TO SEE

/** Controls switched off on the options page. Never the settings button. */
function applyHiddenButtons(hidden) {
  for (const holder of ui.toolbar.querySelectorAll('[data-button]')) {
    holder.hidden = hidden.includes(holder.dataset.button);
  }
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
