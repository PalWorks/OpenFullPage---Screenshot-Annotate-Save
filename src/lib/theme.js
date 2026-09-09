// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The interface theme, shared by every page the extension shows.
//
// THREE STATES, NOT TWO
//
// `system` is not a synonym for light. With it chosen the document carries no
// `data-theme` attribute at all and the stylesheets fall through to
// `prefers-color-scheme`, which is what makes the interface follow the operating
// system as it changes during the day. Only an explicit choice stamps anything.
//
// WHY THE FLASH IS UNAVOIDABLE
//
// The choice lives in chrome.storage, which is asynchronous, and the content
// security policy forbids an inline script (rule 2), so there is no way to stamp
// the attribute before the first paint. A user who has overridden the system
// theme therefore sees the system one for a frame. The alternative is a policy
// that permits inline script on every page forever, which is a far worse trade
// than one frame.

import { THEMES, loadSettings, saveSettings } from './settings.js';

export { THEMES };

/** How the button describes where it is now. */
export const THEME_STATE = {
  system: 'following your system',
  light: 'light',
  dark: 'dark',
};

/** And what one more press will do. Separate, because "switch to following your
 *  system" is not a sentence anyone says. */
export const THEME_NAMES = { system: 'system', light: 'light', dark: 'dark' };

/** The whole label, used for both `title` and `aria-label` so they cannot drift. */
export function themeLabel(theme) {
  return `Theme: ${THEME_STATE[theme]}. Click for ${THEME_NAMES[nextTheme(theme)]}.`;
}

export function nextTheme(theme) {
  const at = THEMES.indexOf(theme);
  return THEMES[(at + 1) % THEMES.length];
}

/** Stamp the choice on the document. `system` deliberately stamps nothing. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else root.removeAttribute('data-theme');
}

/**
 * Apply the stored theme and keep applying it.
 *
 * Every extension page listens, so changing the theme in the editor also changes
 * the settings page that is already open in another tab, without either page
 * knowing about the other.
 *
 * @param {(theme: string) => void} [onChange] told the theme whenever it settles
 * @returns {Promise<string>} the theme in force
 */
export async function startTheme(onChange = () => {}) {
  // The listener is attached before the first read, so a change that lands while
  // the read is in flight is not missed. It also has to win: without this flag
  // the read would resolve a moment later with the value from before the change
  // and put the old theme back.
  let live = false;

  const settle = (theme) => {
    applyTheme(theme);
    onChange(theme);
    return theme;
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.theme) return;
    live = true;
    settle(THEMES.includes(changes.theme.newValue) ? changes.theme.newValue : 'system');
  });

  const { theme } = await loadSettings();
  return live ? theme : settle(theme);
}

/** Move to the next theme in the cycle and store it. Returns the new theme. */
export async function cycleTheme(from) {
  const theme = nextTheme(from);
  applyTheme(theme);
  await saveSettings({ theme });
  return theme;
}
