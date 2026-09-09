// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// User settings.
//
// Stored with chrome.storage.local only. The synced storage area would send the
// user's configuration to Google's servers, which is a network path this
// extension does not otherwise have; test/invariants.test.js bans that API
// outright so it stays that way.
//
// Permissions are deliberately NOT mirrored here. chrome.permissions.contains()
// is the only honest source of truth for what has been granted, a stored flag
// could disagree with reality after the user revokes access in chrome://extensions,
// and the disagreement would always favour us.

export const CAPTURE_MODES = ['full', 'visible', 'element'];
export const DOWNLOAD_FORMATS = ['png', 'jpeg', 'pdf'];

/**
 * Interface theme. `system` is the default and means "whatever the operating
 * system is set to", which is a third state rather than a synonym for light:
 * with it chosen the pages carry no `data-theme` at all and the stylesheets fall
 * through to `prefers-color-scheme`.
 */
export const THEMES = ['system', 'light', 'dark'];

// Style vocabularies. Repeated from src/lib/edit.js rather than imported: this
// module is loaded by the service worker and the options page, neither of which
// has any other reason to pull in the editing model.
export const DASH_STYLES = ['solid', 'dashed', 'dotted'];
export const LINE_ENDS = ['none', 'start', 'end', 'both'];
export const TEXT_FAMILIES = ['system', 'sans', 'serif', 'mono'];
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'];

/**
 * Every toolbar control the options page can hide, grouped the way the toolbar
 * itself is grouped, with the label the options page shows.
 *
 * This is the only place the list exists. The options page used to keep its own
 * copy, which meant a control could be added to one and not the other: a
 * checkbox that hid nothing, or a button with no way to switch it off.
 *
 * The settings button is deliberately absent. Hiding it would remove the only
 * way back to the page that hid it.
 */
export const TOOLBAR_GROUPS = [
  ['Tools', {
    select: 'Select',
    shapes: 'Shapes',
    text: 'Text',
    counter: 'Numbered step',
    pixelate: 'Redact',
    crop: 'Crop',
  }],
  ['Style', {
    style: 'Stroke style',
    border: 'Border colour',
    fill: 'Fill colour',
  }],
  ['History', {
    delete: 'Delete',
    undo: 'Undo',
    redo: 'Redo',
    revert: 'Reset',
  }],
  ['Output', {
    copy: 'Copy image',
    download: 'Download',
    upload: 'Upload',
  }],
  ['View', {
    theme: 'Theme',
  }],
];

/**
 * The style the editor remembers between captures, so picking red and a 7px
 * stroke once means the next capture opens on red and 7px.
 *
 * Named as a set because Reset needs to put exactly these back and nothing else:
 * not the output format, not which toolbar controls are showing, not the capture
 * settings. Those are separate choices and resetting them would be a surprise.
 */
export const STYLE_KEYS = [
  'tool', 'colour', 'strokeWidth', 'dash', 'lineEnds', 'fill', 'fillOpacity',
  'textSize', 'textFamily', 'textBold', 'textItalic', 'textUnderline',
  'textAlign', 'textColour',
];

/** A fresh copy of the shipped style. */
export function defaultStyle() {
  return Object.fromEntries(STYLE_KEYS.map((key) => [key, DEFAULTS[key]]));
}

/** The flat set, in toolbar order. Derived, never written by hand. */
export const TOOLBAR_BUTTONS = TOOLBAR_GROUPS.flatMap(([, buttons]) => Object.keys(buttons));

export const DEFAULTS = {
  // What a plain toolbar click does. Full page unless the user changes it.
  defaultMode: 'full',
  // Extra capture modes are off until asked for: one click, one behaviour.
  extraModes: false,
  // Remembered between captures so the editor feels continuous.
  tool: 'arrow',
  colour: '#ef4444',
  strokeWidth: 4,
  // Shape style, remembered so the next capture opens where the last left off.
  dash: 'solid',
  lineEnds: 'end',
  // null is a value here: it means an outlined shape with nothing behind it.
  fill: null,
  fillOpacity: 0.35,
  // Type, in points, matching the inspector rather than being derived from the
  // stroke width the way it used to be.
  textSize: 24,
  textFamily: 'system',
  textBold: true,
  textItalic: false,
  textUnderline: false,
  textAlign: 'left',
  // Text keeps its own colour rather than sharing the stroke colour. They are
  // separate choices: an arrow pointing at a thing and a caption naming it are
  // rarely wanted in the same colour. The default matches the stroke colour, so
  // nothing changes for anyone who never opens the control.
  textColour: '#ef4444',
  // Toolbar controls the user has switched off. Empty means the curated set.
  hiddenButtons: [],
  // Seconds to wait before capturing, for menus and hover states.
  captureDelay: 0,
  // Follows the operating system until the user says otherwise.
  theme: 'system',
  // Show the animated progress popup under the toolbar button while capturing.
  progressPopup: true,
  // Save the finished capture straight to the downloads folder instead of
  // opening it for editing. Needs the downloads permission, which the options
  // page asks for at the moment this is switched on.
  directDownload: false,
  // The download format last used, so the next capture opens on it.
  format: 'png',
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return sanitise(stored);
}

/**
 * Writes are serialised, and that is not decoration.
 *
 * This is read-modify-write over the whole settings object: it loads what is
 * stored, merges the patch, sanitises the result and writes all of it back, which
 * is what repairs a corrupt stored value rather than carrying it forward. Run two
 * of those concurrently and the second reads before the first has written, so the
 * second write puts back the value the first had just changed. It is easy to
 * trigger: dragging the fill opacity slider fires one per step, and picking a
 * colour then immediately a stroke width fires two.
 *
 * A failed write must not poison the chain, so the tail is always resolved.
 */
let queue = Promise.resolve();

export function saveSettings(patch) {
  const done = queue.then(async () => {
    const next = sanitise({ ...(await loadSettings()), ...patch });
    await chrome.storage.local.set(next);
    return next;
  });
  queue = done.catch(() => {});
  return done;
}

/** Storage is user-writable in principle; never trust what comes back out. */
export function sanitise(raw) {
  const clean = { ...DEFAULTS };

  if (CAPTURE_MODES.includes(raw.defaultMode)) clean.defaultMode = raw.defaultMode;
  clean.extraModes = raw.extraModes === true;
  clean.progressPopup = raw.progressPopup !== false;
  if (THEMES.includes(raw.theme)) clean.theme = raw.theme;
  clean.directDownload = raw.directDownload === true;
  if (DOWNLOAD_FORMATS.includes(raw.format)) clean.format = raw.format;

  if (typeof raw.tool === 'string' && /^[a-z]{2,12}$/.test(raw.tool)) clean.tool = raw.tool;
  if (typeof raw.colour === 'string' && /^#[0-9a-f]{6}$/i.test(raw.colour)) {
    clean.colour = raw.colour.toLowerCase();
  }
  if (Number.isFinite(raw.strokeWidth)) {
    clean.strokeWidth = Math.min(64, Math.max(1, Math.round(raw.strokeWidth)));
  }

  if (DASH_STYLES.includes(raw.dash)) clean.dash = raw.dash;
  if (LINE_ENDS.includes(raw.lineEnds)) clean.lineEnds = raw.lineEnds;
  if (TEXT_FAMILIES.includes(raw.textFamily)) clean.textFamily = raw.textFamily;

  // No fill is the default, so anything that is not a hex colour becomes null
  // rather than being dropped back to some previous colour.
  clean.fill =
    typeof raw.fill === 'string' && /^#[0-9a-f]{6}$/i.test(raw.fill)
      ? raw.fill.toLowerCase()
      : null;

  if (Number.isFinite(raw.fillOpacity)) {
    clean.fillOpacity = Math.min(1, Math.max(0, Math.round(raw.fillOpacity * 100) / 100));
  }
  if (Number.isFinite(raw.textSize)) {
    clean.textSize = Math.min(200, Math.max(8, Math.round(raw.textSize)));
  }

  if (TEXT_ALIGNS.includes(raw.textAlign)) clean.textAlign = raw.textAlign;
  if (typeof raw.textColour === 'string' && /^#[0-9a-f]{6}$/i.test(raw.textColour)) {
    clean.textColour = raw.textColour.toLowerCase();
  }
  clean.textBold = raw.textBold !== false;
  clean.textItalic = raw.textItalic === true;
  clean.textUnderline = raw.textUnderline === true;

  // Only names we know, no duplicates, and never every button at once: an empty
  // toolbar would leave no way back to the options page.
  if (Array.isArray(raw.hiddenButtons)) {
    const wanted = [...new Set(raw.hiddenButtons)].filter((n) => TOOLBAR_BUTTONS.includes(n));
    clean.hiddenButtons = wanted.length === TOOLBAR_BUTTONS.length ? wanted.slice(1) : wanted;
  }
  if (Number.isFinite(raw.captureDelay)) {
    clean.captureDelay = Math.min(10, Math.max(0, Math.round(raw.captureDelay)));
  }

  // Extra modes off means the default mode has to be the plain one, or the
  // toolbar button would keep doing something the user turned off.
  if (!clean.extraModes) clean.defaultMode = 'full';

  return clean;
}

// ADVANCED ACCESS

/**
 * Reading inside cross-origin frames needs webNavigation to enumerate them and
 * <all_urls> to script them. That is access to every site the user visits, so it
 * is opt-in, revocable, and never requested at install.
 *
 * Note what it still cannot do: the content security policy sets
 * `connect-src 'none'`, so even with this granted the extension can read a page
 * and has no way to send what it read anywhere.
 */
export const DEEP_FRAMES = {
  permissions: ['webNavigation'],
  origins: ['<all_urls>'],
};

// PORTABLE SETTINGS
//
// The synced storage area is banned (D2), so settings deliberately do not follow
// the user between machines. A file they carry themselves is the honest
// replacement: it moves the same data, but they can read it first and it goes
// nowhere they did not put it.

export const SETTINGS_FILE_KIND = 'openfullpage-settings';
export const SETTINGS_FILE_VERSION = 1;

/** The object written to disk. Wrapped, so an unrelated JSON file is recognisable. */
export function toSettingsFile(settings, { version = '0.0.0', now = new Date() } = {}) {
  return {
    kind: SETTINGS_FILE_KIND,
    fileVersion: SETTINGS_FILE_VERSION,
    extensionVersion: version,
    exported: now.toISOString(),
    settings: sanitise(settings),
  };
}

/**
 * Read a settings file back.
 *
 * Everything ends up in sanitise(), which already treats stored values as
 * untrusted, so an edited or hostile file cannot introduce a key we do not know
 * or a value outside the range we accept. It is accepted either wrapped or as a
 * bare settings object, because someone will hand-write the bare one.
 *
 * @returns {{ settings: object, unknown: string[] }}
 * @throws {Error} with a message written for the person who picked the file
 */
export function parseSettingsFile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON. Pick the file this page exported.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('That file does not contain settings.');
  }

  const wrapped = Object.hasOwn(raw, 'settings') || raw.kind === SETTINGS_FILE_KIND;
  if (wrapped && raw.kind !== SETTINGS_FILE_KIND) {
    throw new Error('That JSON file belongs to something else, not OpenFullPage.');
  }

  const body = wrapped ? raw.settings : raw;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('That file does not contain settings.');
  }

  // Named so the page can say what was ignored rather than silently dropping it.
  const unknown = Object.keys(body).filter((key) => !Object.hasOwn(DEFAULTS, key));
  return { settings: sanitise(body), unknown };
}
