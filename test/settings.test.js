// SPDX-License-Identifier: GPL-3.0-only
//
// Settings sanitising. Storage is user writable in principle, and everything
// here is read back out of it and acted on, so what comes out is treated as
// untrusted input rather than as something we wrote.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULTS,
  DOWNLOAD_FORMATS,
  STYLE_KEYS,
  TEXT_ALIGNS,
  THEMES,
  TOOLBAR_BUTTONS,
  SHAPE_TOOLS,
  TOOLBAR_GROUPS,
  TOOLS,
  defaultStyle,
  sanitise,
  saveSettings,
} from '../src/lib/settings.js';

test('an empty store gives exactly the defaults', () => {
  assert.deepEqual(sanitise({}), DEFAULTS);
});

test('the progress popup is on unless it was explicitly turned off', () => {
  assert.equal(sanitise({}).progressPopup, true);
  assert.equal(sanitise({ progressPopup: false }).progressPopup, false);
  // Anything that is not the literal false means on, so a corrupt value cannot
  // quietly remove the only feedback a capture gives.
  for (const junk of [undefined, null, 0, '', 'no', {}]) {
    assert.equal(sanitise({ progressPopup: junk }).progressPopup, true, String(junk));
  }
});

test('extra modes are off unless explicitly true', () => {
  for (const junk of ['true', 1, {}, null, undefined]) {
    assert.equal(sanitise({ extraModes: junk }).extraModes, false, String(junk));
  }
  assert.equal(sanitise({ extraModes: true }).extraModes, true);
});

test('a default mode the user cannot reach is refused', () => {
  // With extra modes off, a stored mode of "element" would make the toolbar
  // button do something the user switched off.
  assert.equal(sanitise({ defaultMode: 'element' }).defaultMode, 'full');
  assert.equal(sanitise({ defaultMode: 'element', extraModes: true }).defaultMode, 'element');
  assert.equal(sanitise({ defaultMode: 'nonsense', extraModes: true }).defaultMode, 'full');
});

test('the capture delay is clamped to a sane range', () => {
  assert.equal(sanitise({ captureDelay: -5 }).captureDelay, 0);
  assert.equal(sanitise({ captureDelay: 9999 }).captureDelay, 10);
  assert.equal(sanitise({ captureDelay: 2.4 }).captureDelay, 2);
  assert.equal(sanitise({ captureDelay: 'soon' }).captureDelay, DEFAULTS.captureDelay);
});

test('a colour has to be a hex colour, not arbitrary CSS', () => {
  assert.equal(sanitise({ colour: '#00FF00' }).colour, '#00ff00');
  for (const junk of ['red', 'url(x)', '#fff', 'expression(1)', 123]) {
    assert.equal(sanitise({ colour: junk }).colour, DEFAULTS.colour, String(junk));
  }
});

// The ceiling is 64 rather than 24 because the stroke style popover has an
// exact px box, and the three preset buttons are no longer the only way in.
test('the stroke width is clamped and rounded', () => {
  assert.equal(sanitise({ strokeWidth: 0 }).strokeWidth, 1);
  assert.equal(sanitise({ strokeWidth: 1000 }).strokeWidth, 64);
  assert.equal(sanitise({ strokeWidth: '4' }).strokeWidth, DEFAULTS.strokeWidth);
});

test('a dash style, line ending and font family have to be ones we can draw', () => {
  assert.equal(sanitise({ dash: 'dotted' }).dash, 'dotted');
  assert.equal(sanitise({ dash: 'squiggle' }).dash, DEFAULTS.dash);
  assert.equal(sanitise({ lineEnds: 'both' }).lineEnds, 'both');
  assert.equal(sanitise({ lineEnds: 'sideways' }).lineEnds, DEFAULTS.lineEnds);
  assert.equal(sanitise({ textFamily: 'mono' }).textFamily, 'mono');
  assert.equal(sanitise({ textFamily: 'Comic Sans' }).textFamily, DEFAULTS.textFamily);
});

// No fill is a value, not a missing setting, so anything unusable becomes null
// rather than falling back to whatever colour was there before.
test('a fill is a hex colour or nothing at all', () => {
  assert.equal(sanitise({ fill: '#3B82F6' }).fill, '#3b82f6');
  assert.equal(sanitise({ fill: 'red' }).fill, null);
  assert.equal(sanitise({}).fill, null);
  assert.equal(sanitise({ fillOpacity: 5 }).fillOpacity, 1);
  assert.equal(sanitise({ fillOpacity: -1 }).fillOpacity, 0);
  assert.equal(sanitise({ fillOpacity: 0.356 }).fillOpacity, 0.36);
});

test('the text size is clamped to what the inspector offers', () => {
  assert.equal(sanitise({ textSize: 2 }).textSize, 8);
  assert.equal(sanitise({ textSize: 9999 }).textSize, 200);
  assert.equal(sanitise({ textSize: '24' }).textSize, DEFAULTS.textSize);
});

test('hidden toolbar buttons are checked against the buttons that exist', () => {
  assert.deepEqual(sanitise({ hiddenButtons: ['crop', 'fill'] }).hiddenButtons, ['crop', 'fill']);
  assert.deepEqual(sanitise({ hiddenButtons: ['crop', 'crop'] }).hiddenButtons, ['crop']);
  assert.deepEqual(sanitise({ hiddenButtons: ['nonesuch'] }).hiddenButtons, []);
  assert.deepEqual(sanitise({ hiddenButtons: 'crop' }).hiddenButtons, []);
});

// Hiding everything would leave no toolbar, and the settings button is on it,
// so there would be no way back to the page that did it.
test('the whole toolbar cannot be hidden at once', () => {
  const all = sanitise({ hiddenButtons: [...TOOLBAR_BUTTONS] }).hiddenButtons;
  assert.equal(all.length, TOOLBAR_BUTTONS.length - 1);
});

/**
 * T3. Every key has to survive being written and read back. A key present in
 * DEFAULTS but forgotten in sanitise() silently reverts on the next load, and
 * the failure looks like the user's choice never being remembered.
 */
test('every default value round trips through sanitise unchanged', () => {
  assert.deepEqual(sanitise({ ...DEFAULTS }), DEFAULTS);
});

test('every key sanitise knows about is one DEFAULTS declares', () => {
  const sample = {
    defaultMode: 'visible', extraModes: true, tool: 'rect', colour: '#123456',
    strokeWidth: 8, captureDelay: 3, progressPopup: false, directDownload: true,
    theme: 'dark', format: 'jpeg',
    dash: 'dashed', lineEnds: 'none', corner: 12, fill: '#abcdef', fillOpacity: 0.5,
    textSize: 40, textFamily: 'serif', textBold: false, textItalic: true,
    textUnderline: true, textAlign: 'justify', textColour: '#00ff88',
    textFrameColour: '#00aa11', textFramePlate: '#ffffff', textFrameWidth: 3,
    hiddenButtons: ['crop'], hiddenShapes: ['cylinder'],
  };
  const clean = sanitise(sample);
  assert.deepEqual(Object.keys(clean).sort(), Object.keys(DEFAULTS).sort());
  // And every one of them actually took the value it was given.
  assert.deepEqual(clean, sample);
});

test('text alignment has to be one we can actually draw', () => {
  for (const known of TEXT_ALIGNS) assert.equal(sanitise({ textAlign: known }).textAlign, known);
  for (const junk of ['start', 'end', 'middle', 'JUSTIFY', 7, null]) {
    assert.equal(sanitise({ textAlign: junk }).textAlign, DEFAULTS.textAlign, String(junk));
  }
});

test('the text colour is a hex colour or it is the default', () => {
  assert.equal(sanitise({ textColour: '#AABBCC' }).textColour, '#aabbcc');
  for (const junk of ['red', '#fff', 'rgb(0,0,0)', '#12345g', 42, null]) {
    assert.equal(sanitise({ textColour: junk }).textColour, DEFAULTS.textColour, String(junk));
  }
});

test('a stored tool name is checked against the real list, not a pattern', () => {
  // The pattern this replaced was /^[a-z]{2,12}$/. "parallelogram" is thirteen
  // characters, so a user who last drew one would have had it thrown away on
  // every reload and the editor would have opened on the default instead.
  assert.equal(sanitise({ tool: 'parallelogram' }).tool, 'parallelogram');
  for (const kind of TOOLS) assert.equal(sanitise({ tool: kind }).tool, kind);
  // Membership is also stricter than the pattern was: this passed it.
  assert.equal(sanitise({ tool: 'banana' }).tool, DEFAULTS.tool);
});

test('a stored tool name cannot be arbitrary text', () => {
  assert.equal(sanitise({ tool: 'crop' }).tool, 'crop');
  for (const junk of ['<script>', 'a', 'waytoolongtoolname', 42]) {
    assert.equal(sanitise({ tool: junk }).tool, DEFAULTS.tool, String(junk));
  }
});

test('the remembered download format has to be one we can actually encode', () => {
  assert.equal(sanitise({}).format, 'png');
  for (const known of DOWNLOAD_FORMATS) assert.equal(sanitise({ format: known }).format, known);
  // A format we cannot encode would fail at the moment the user presses save.
  for (const junk of ['webp', 'image/png', '../x', 7, null]) {
    assert.equal(sanitise({ format: junk }).format, 'png', String(junk));
  }
});

// Reset on an untouched capture puts these back, and nothing else. A key that
// drifts out of DEFAULTS would make it throw away a setting it cannot restore.
test('every style key Reset restores is one DEFAULTS declares', () => {
  for (const key of STYLE_KEYS) assert.ok(Object.hasOwn(DEFAULTS, key), key);
  assert.deepEqual(defaultStyle(), Object.fromEntries(STYLE_KEYS.map((k) => [k, DEFAULTS[k]])));
});

test('Reset leaves the output format, the toolbar and the capture settings alone', () => {
  for (const key of ['format', 'hiddenButtons', 'captureDelay', 'defaultMode', 'theme',
    'extraModes', 'progressPopup', 'directDownload']) {
    assert.ok(!STYLE_KEYS.includes(key), `${key} should not be swept up by Reset`);
  }
});

test('a stored theme has to be one of the three states', () => {
  assert.equal(sanitise({}).theme, 'system');
  for (const known of THEMES) assert.equal(sanitise({ theme: known }).theme, known);
  for (const junk of ['Dark', 'auto', '', 3, null]) {
    assert.equal(sanitise({ theme: junk }).theme, 'system', String(junk));
  }
});

test('unknown keys in storage are dropped rather than carried through', () => {
  const clean = sanitise({ evil: 'payload', __proto__: { polluted: true } });
  assert.equal(clean.evil, undefined);
  assert.deepEqual(Object.keys(clean).sort(), Object.keys(DEFAULTS).sort());
});

// The options page renders TOOLBAR_GROUPS and sanitise() validates against
// TOOLBAR_BUTTONS. They used to be two hand-written lists in two files, which
// meant a control could exist in one and not the other: a checkbox that hid
// nothing, or a button with no way to switch it off.
test('shapes are hidden by their own list, not by the toolbar one', () => {
  // Separate from hiddenButtons on purpose. The guard on that list un-hides the
  // FIRST entry when everything is hidden, and with shape names in the same
  // list that first entry would be Select.
  assert.deepEqual(sanitise({}).hiddenShapes, []);
  assert.deepEqual(sanitise({ hiddenShapes: ['rhombus', 'banana'] }).hiddenShapes, ['rhombus']);
  assert.deepEqual(sanitise({ hiddenShapes: 'cylinder' }).hiddenShapes, []);
  // Hiding a shape must not touch the toolbar list, and the reverse.
  assert.deepEqual(sanitise({ hiddenShapes: ['rhombus'] }).hiddenButtons, []);
  assert.deepEqual(sanitise({ hiddenButtons: ['crop'] }).hiddenShapes, []);
});

test('the shapes popover can never be emptied completely', () => {
  // A chevron that opens an empty panel is a dead end. Hiding the whole Shapes
  // group is what the toolbar switch is for, one section above on the same page.
  const all = sanitise({ hiddenShapes: SHAPE_TOOLS });
  assert.equal(all.hiddenShapes.length, SHAPE_TOOLS.length - 1);
  assert.ok(SHAPE_TOOLS.some((kind) => !all.hiddenShapes.includes(kind)));
});

test('the flat button list is exactly what the grouped one contains', () => {
  const fromGroups = TOOLBAR_GROUPS.flatMap(([, buttons]) => Object.keys(buttons));
  assert.deepEqual(TOOLBAR_BUTTONS, fromGroups);
  assert.equal(new Set(TOOLBAR_BUTTONS).size, TOOLBAR_BUTTONS.length, 'a button is listed twice');
});

test('every toolbar button has a label, and settings is not one of them', () => {
  for (const [group, buttons] of TOOLBAR_GROUPS) {
    assert.ok(group.length > 0, 'a group has no name');
    for (const [name, label] of Object.entries(buttons)) {
      assert.match(name, /^[a-z]+$/, `${name} is not a plain control name`);
      assert.ok(label && label.length > 1, `${name} has no label`);
    }
  }
  // Hiding it would remove the only way back to the page that hid it.
  assert.ok(!TOOLBAR_BUTTONS.includes('settings'));
});

/**
 * Saving is read-modify-write over the whole object, so two overlapping saves
 * used to end with the second putting back what the first had just changed.
 *
 * Easy to trigger in the editor: dragging the fill opacity slider fires one save
 * per step. The fake storage below simply makes the window wide enough to see.
 */
test('two saves at once both survive', async () => {
  let store = {};
  const previous = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          // A real read answers with the state at the moment it was made, not the
          // state when it happens to resolve. Snapshotting before the delay is
          // what makes this a read-modify-write race rather than three tidy
          // round trips that accidentally queue themselves.
          const snapshot = { ...defaults, ...store };
          await new Promise((resolve) => setTimeout(resolve, 5));
          return snapshot;
        },
        async set(next) {
          store = { ...next };
        },
      },
    },
  };

  try {
    await Promise.all([
      saveSettings({ colour: '#00ff00' }),
      saveSettings({ strokeWidth: 11 }),
      saveSettings({ textFamily: 'mono' }),
    ]);
    assert.equal(store.colour, '#00ff00');
    assert.equal(store.strokeWidth, 11);
    assert.equal(store.textFamily, 'mono');
  } finally {
    globalThis.chrome = previous;
  }
});

test('a failed write does not stop the next one', async () => {
  const previous = globalThis.chrome;
  let store = {};
  let failNext = true;
  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...store };
        },
        async set(next) {
          if (failNext) {
            failNext = false;
            throw new Error('storage is full');
          }
          store = { ...next };
        },
      },
    },
  };

  try {
    await assert.rejects(saveSettings({ colour: '#00ff00' }));
    await saveSettings({ colour: '#0000ff' });
    assert.equal(store.colour, '#0000ff');
  } finally {
    globalThis.chrome = previous;
  }
});
