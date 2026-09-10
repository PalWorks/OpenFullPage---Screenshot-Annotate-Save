// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The settings page. Permission checkboxes read their state from
// chrome.permissions.contains() rather than from storage: if the user revokes
// access in chrome://extensions, a stored flag would still say "on", and the
// disagreement would always be in our favour.

import {
  DEEP_FRAMES,
  SHAPE_GROUPS,
  TOOLBAR_GROUPS,
  loadSettings,
  parseSettingsFile,
  saveSettings,
  toSettingsFile,
} from '../lib/settings.js';
import { applyTheme, startTheme } from '../lib/theme.js';
import { usableSponsors } from '../lib/sponsors.js';

/**
 * Where feedback goes.
 *
 * A mailto: hand-off rather than a form that posts somewhere, because posting
 * would need network access and this extension has none. Nothing is sent until
 * the person presses send in their own mail app, which also means attachments
 * are theirs to add and we never touch their files.
 */
const SUPPORT_EMAIL = 'support@palworks.ai';

const el = (id) => document.getElementById(id);
const deepFrames = el('deepFrames');
const extraModes = el('extraModes');
const defaultMode = el('defaultMode');
const captureDelay = el('captureDelay');
const progressPopup = el('progressPopup');
const directDownload = el('directDownload');
const themeChoice = el('theme');
const saved = el('saved');
const toolbarButtons = el('toolbarButtons');


/** The names the options page shows for each shape, in the popover's own order. */
const SHAPE_LABELS = {
  arrow: 'Arrow', line: 'Line', rect: 'Box', ellipse: 'Ellipse', callout: 'Callout',
  loupe: 'Loupe', highlight: 'Highlighter', rounded: 'Rounded box', stadium: 'Stadium',
  rhombus: 'Rhombus', hexagon: 'Hexagon',
  parallelogram: 'Parallelogram', triangle: 'Triangle', cylinder: 'Cylinder',
};

/** Off by default. Everything else ships on, which is the curated set. */
const HIDDEN_BY_DEFAULT = [];

const shapeButtons = document.getElementById('shapeButtons');

/** Every shape, grouped exactly as the popover groups them. */
function buildShapeList() {
  for (const [title, kinds] of SHAPE_GROUPS) {
    const heading = document.createElement('p');
    heading.className = 'group';
    heading.textContent = title;
    shapeButtons.append(heading);

    for (const kind of kinds) {
      const row = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.shape = kind;
      row.append(box, document.createTextNode(SHAPE_LABELS[kind] ?? kind));
      shapeButtons.append(row);
    }
  }

  shapeButtons.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement) saveShapes();
  });
}

async function saveShapes() {
  const hidden = [...shapeButtons.querySelectorAll('input')]
    .filter((box) => !box.checked)
    .map((box) => box.dataset.shape);
  const settings = await saveSettings({ hiddenShapes: hidden });
  showShapes(settings.hiddenShapes);
  note(
    settings.hiddenShapes.length === 0
      ? 'Every shape is showing.'
      : `${settings.hiddenShapes.length} shape${settings.hiddenShapes.length === 1 ? '' : 's'} hidden.`,
  );
}

function showShapes(hidden) {
  for (const box of shapeButtons.querySelectorAll('input')) {
    box.checked = !hidden.includes(box.dataset.shape);
  }
}

function buildToolbarList() {
  for (const [title, buttons] of TOOLBAR_GROUPS) {
    const heading = document.createElement('p');
    heading.className = 'group';
    heading.textContent = title;
    toolbarButtons.append(heading);

    for (const [name, label] of Object.entries(buttons)) {
      const row = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.button = name;
      row.append(box, document.createTextNode(label));
      toolbarButtons.append(row);
    }
  }

  toolbarButtons.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement) saveToolbar();
  });
}

async function saveToolbar() {
  const hidden = [...toolbarButtons.querySelectorAll('input')]
    .filter((box) => !box.checked)
    .map((box) => box.dataset.button);
  const settings = await saveSettings({ hiddenButtons: hidden });
  showToolbar(settings.hiddenButtons);
  note(
    settings.hiddenButtons.length === 0
      ? 'Every control is showing.'
      : `${settings.hiddenButtons.length} control${settings.hiddenButtons.length === 1 ? '' : 's'} hidden.`,
  );
}

function showToolbar(hidden) {
  for (const box of toolbarButtons.querySelectorAll('input')) {
    box.checked = !hidden.includes(box.dataset.button);
  }
}

function note(text) {
  saved.textContent = text;
}

async function refresh() {
  const settings = await loadSettings();
  extraModes.checked = settings.extraModes;
  defaultMode.value = settings.defaultMode;
  defaultMode.disabled = !settings.extraModes;
  captureDelay.value = String(settings.captureDelay);
  progressPopup.checked = settings.progressPopup;
  themeChoice.value = settings.theme;
  // Storage says the user asked for it; the permission says it can actually
  // happen. Both have to be true, and Chrome is the one that decides the second.
  directDownload.checked = settings.directDownload && (await chrome.permissions.contains(DOWNLOADS));
  deepFrames.checked = await chrome.permissions.contains(DEEP_FRAMES);
  showToolbar(settings.hiddenButtons);
  showShapes(settings.hiddenShapes ?? []);
}

deepFrames.addEventListener('change', async () => {
  // Requesting must happen inside the click, so it is not awaited behind
  // anything else: Chrome only shows the prompt for a genuine gesture.
  const granted = deepFrames.checked
    ? await chrome.permissions.request(DEEP_FRAMES)
    : !(await chrome.permissions.remove(DEEP_FRAMES));

  deepFrames.checked = granted;
  note(
    granted
      ? 'Cross-origin frames will be captured in full. Revoke this any time.'
      : 'Cross-origin frames contribute only what is on screen.',
  );
});

extraModes.addEventListener('change', async () => {
  const settings = await saveSettings({ extraModes: extraModes.checked });
  defaultMode.disabled = !settings.extraModes;
  defaultMode.value = settings.defaultMode;
  note(settings.extraModes ? 'Extra capture modes enabled.' : 'Back to whole-page capture only.');
});

defaultMode.addEventListener('change', async () => {
  await saveSettings({ defaultMode: defaultMode.value });
  note('Saved.');
});

/**
 * Saving without the editor has to happen without a click to hang a permission
 * prompt on, so the permission is asked for here, where there is one. If it is
 * declined the setting does not stick: the alternative is a switch that reads as
 * on and silently opens the editor anyway.
 */
const DOWNLOADS = { permissions: ['downloads'] };

directDownload.addEventListener('change', async () => {
  if (!directDownload.checked) {
    await saveSettings({ directDownload: false });
    // The permission itself is left alone. The editor's own Save button uses it,
    // and revoking it here would make that ask again for no reason.
    note('Captures will open in the editor.');
    return;
  }

  const granted = await chrome.permissions.request(DOWNLOADS);
  directDownload.checked = granted;
  await saveSettings({ directDownload: granted });
  note(
    granted
      ? 'Captures will be saved straight to your downloads folder.'
      : 'Saving without the editor needs permission to use Chrome downloads.',
  );
});

// THEME
//
// The same setting the editor's theme button writes. Applied here the moment it
// changes rather than on the next load, and applied to every other extension page
// that is open, because startTheme() below is watching storage on all of them.

themeChoice.addEventListener('change', async () => {
  applyTheme(themeChoice.value);
  await saveSettings({ theme: themeChoice.value });
  note(
    themeChoice.value === 'system'
      ? 'Following your system theme.'
      : `Using the ${themeChoice.value} theme everywhere.`,
  );
});

startTheme((theme) => {
  themeChoice.value = theme;
});

progressPopup.addEventListener('change', async () => {
  await saveSettings({ progressPopup: progressPopup.checked });
  note(progressPopup.checked ? 'The progress popup will open with each capture.' : 'Progress will show on the toolbar icon only.');
});

captureDelay.addEventListener('change', async () => {
  await saveSettings({ captureDelay: Number(captureDelay.value) });
  note('Saved.');
});

el('showEverything').addEventListener('click', async () => {
  await saveSettings({ hiddenButtons: [] });
  showToolbar([]);
  note('Every control is showing.');
});

el('resetToolbar').addEventListener('click', async () => {
  await saveSettings({ hiddenButtons: HIDDEN_BY_DEFAULT });
  showToolbar(HIDDEN_BY_DEFAULT);
  note('Toolbar back to the default set.');
});

el('showEveryShape').addEventListener('click', async () => {
  await saveSettings({ hiddenShapes: [] });
  showShapes([]);
  note('Every shape is showing.');
});

// THE INDEX
//
// Built from the sections themselves rather than written out beside them, so a
// section cannot be added, removed or reordered without the index following. The
// numerals on both sides come from CSS counters over the same DOM order, which is
// what keeps "03" in the index pointing at the section headed "03".

function buildIndex() {
  const list = el('tocList');
  const sections = [...document.querySelectorAll('main section[id]')];

  for (const section of sections) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.textContent = section.querySelector('h2').textContent.trim();
    item.append(link);
    list.append(item);
  }

  const links = new Map(sections.map((s, i) => [s, list.querySelectorAll('a')[i]]));

  /**
   * Mark the section the reader is actually in.
   *
   * The topmost section still intersecting the viewport, not merely the most
   * visible one: at the bottom of the page several are on screen at once, and the
   * one being read is the one whose heading was passed last.
   */
  const spy = new IntersectionObserver(
    () => {
      const current = sections.find((section) => {
        const box = section.getBoundingClientRect();
        return box.bottom > 80 && box.top < window.innerHeight * 0.6;
      }) ?? sections.at(-1);

      for (const [section, link] of links) {
        if (section === current) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    },
    { rootMargin: '-70px 0px -40% 0px', threshold: [0, 0.25, 1] },
  );
  for (const section of sections) spy.observe(section);
}

buildIndex();
buildToolbarList();
buildShapeList();

chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);

refresh();

// SETTINGS AS A FILE

el('exportSettings').addEventListener('click', async () => {
  const { version } = chrome.runtime.getManifest();
  const file = toSettingsFile(await loadSettings(), { version });
  const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // A plain download from an extension page. It needs no downloads permission,
  // which is why the export does not have to ask for one.
  const link = document.createElement('a');
  link.href = url;
  link.download = `openfullpage-settings-${file.exported.slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  note('Exported. Keep the file somewhere you can find it.');
});

el('importSettings').addEventListener('click', () => el('settingsFile').click());

el('settingsFile').addEventListener('change', async (event) => {
  const [file] = event.target.files ?? [];
  event.target.value = '';
  if (!file) return;

  try {
    const { settings, unknown } = parseSettingsFile(await file.text());
    await saveSettings(settings);
    await refresh();
    note(
      unknown.length > 0
        ? `Imported. ${unknown.length} unrecognised ${unknown.length === 1 ? 'entry was' : 'entries were'} ignored.`
        : 'Imported. Every setting on this page now matches the file.',
    );
  } catch (error) {
    note(error.message);
  }
});

// SUPPORT AND FEEDBACK

const KIND_SUBJECT = {
  bug: 'Bug report',
  idea: 'Idea',
  question: 'Question',
};

const chosenKind = () =>
  document.querySelector('#feedbackKind input:checked')?.value ?? 'question';

/**
 * What "include your version and settings" actually attaches.
 *
 * Shown in full on the page before anything is composed, because a diagnostics
 * blob nobody can read is exactly the pattern this extension exists to avoid.
 */
async function diagnostics() {
  const { version } = chrome.runtime.getManifest();
  const settings = await loadSettings();
  const platform = await chrome.runtime.getPlatformInfo().catch(() => ({ os: 'unknown' }));
  const chrome_ = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'unknown';
  return [
    `OpenFullPage ${version}`,
    `${chrome_} on ${platform.os}`,
    `Deep frames: ${await chrome.permissions.contains(DEEP_FRAMES) ? 'granted' : 'not granted'}`,
    '',
    'Settings:',
    JSON.stringify(settings, null, 2),
  ].join('\n');
}

async function showDiagnostics() {
  el('diagnosticsPreview').textContent = await diagnostics();
}

async function feedbackText() {
  const body = el('feedbackBody').value.trim();
  const parts = [body || '(describe what happened here)'];
  if (el('includeDiagnostics').checked) {
    parts.push('', '--- version and settings ---', await diagnostics());
  }
  return parts.join('\n');
}

el('composeEmail').addEventListener('click', async () => {
  const subject = `OpenFullPage: ${KIND_SUBJECT[chosenKind()]}`;
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(await feedbackText())}`;

  // mailto: is handled by the operating system. No request is made from here.
  if (url.length > 1800) {
    await navigator.clipboard.writeText(await feedbackText());
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
    note('That message was long, so it is on your clipboard. Paste it into the draft.');
    return;
  }
  window.location.href = url;
  note('Opening your email app. Nothing is sent until you send it.');
});

el('copyFeedback').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(
      `To: ${SUPPORT_EMAIL}\nSubject: OpenFullPage: ${KIND_SUBJECT[chosenKind()]}\n\n${await feedbackText()}`,
    );
    note('Copied. Paste it wherever you read your mail.');
  } catch (error) {
    note(`Could not copy: ${error?.message ?? error}`);
  }
});

el('includeDiagnostics').addEventListener('change', showDiagnostics);
showDiagnostics();

/**
 * Somewhere to send a gift, if there is anywhere yet.
 *
 * Built rather than written into the markup so that the section cannot be on
 * screen with nothing in it: an empty list leaves the whole section hidden, and
 * that is the state this ships in.
 *
 * `chrome.tabs.create` rather than an `<a href>`: the address comes from our own
 * source either way, but routing it through the same call the rest of the
 * extension uses keeps the answer to "what can this page navigate to" in one
 * place, and an anchor in an extension page is the thing that quietly becomes a
 * variable later.
 */
function showSponsors() {
  const sponsors = usableSponsors();
  const section = el('thanks');
  const holder = el('sponsorLinks');
  if (!section || !holder) return;
  section.hidden = sponsors.length === 0;
  holder.replaceChildren();
  for (const sponsor of sponsors) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'linky';
    link.textContent = sponsor.label;
    link.title = sponsor.url;
    link.addEventListener('click', () => chrome.tabs.create({ url: sponsor.url }));
    const note = document.createElement('span');
    note.textContent = sponsor.note ? ` ${sponsor.note}. ` : ' ';
    holder.append(link, note);
  }
}

showSponsors();
