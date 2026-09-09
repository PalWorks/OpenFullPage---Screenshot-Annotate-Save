# Tasks

**[docs/ROADMAP.md](docs/ROADMAP.md) is the north star: it holds the plan, the
phases and the order.** This file holds the acceptance criteria for the release
being built now and the one after it, at the level of detail an agent can implement
from without asking a question.

Read [AGENTS.md](AGENTS.md) first. Every task inherits the definition of done there:
tests pass, new behaviour is tested, every new failure path has a user visible
message, new settings touch both `DEFAULTS` and `sanitise()`, docs updated in the
same commit.

# Shipped since this file was written

Kept as a record of what the acceptance criteria below already cover, so nobody
implements them twice. Every one has tests.

| # | What | Where |
|---|---|---|
| **T3** | Round-trip test for every settings key, plus a test that every key `sanitise()` knows is one `DEFAULTS` declares | `test/settings.test.js` |
| **T10** | `beforeunload` guard on the result tab. Refreshing destroyed the capture and every annotation with no warning, because the service worker streams the screenfuls once and forgets them | `src/ui/result.js` |
| **T20** | Selection chrome drawn in screen space, so handles stay 9px under the pointer at any display scale | `src/ui/editor.js`, D19 |
| **F24** | The grouped toolbar and the options page switches. 26 flat controls became 16 buttons carrying 68, split buttons for Shapes and Text, popovers clamped to the window | D18, D20, D21 |
| **F25** | Upload as a hand-off: copy the image, open the host, paste it there. The extension performs no upload | D16, D26 |
| | Settings export and import as a file | D24 |
| | Support and feedback form, composing a `mailto:` | D25 |
| | Rendered-page audit on every end-to-end run | D23 |
| | A new mark, a retro camera caricature on a teal disc | D22 |
| **T21** | Every step that crosses into a page, a frame or a new tab has a deadline. A capture could reach 100% with all its screenfuls in hand and never open, because `executeScript` against every frame never settled | `src/background.js`, D27 |
| **F32** | Finish now, in the progress panel. Stops the walk between screenfuls, trims the canvas to what was reached, and says so on arrival | `src/ui/progress.*`, D28, `--stop` |
| **F33** | Save straight to your downloads instead of opening the editor, off by default | `src/ui/options.*`, `src/ui/result.js`, D29, `--direct` |
| **F34** | Crop proposes a region: dimmed surround, eight handles, slide to reposition, a confirm bar fixed to the viewport, Enter and Escape | `src/lib/edit.js`, `src/ui/editor.js`, D30 |
| **F35** | PDF export, written by hand, lossless, paginated at the capture's own width | `src/lib/pdf.js`, D31 |
| **F36** | Theme: system, light and dark, on the toolbar and on the settings page | `src/lib/theme.js`, D32 |
| **F37** | Reset restores the drawing style on an untouched capture, and removes edits on a touched one | `src/ui/result.js`, D33 |
| **F38** | An index down the side of the settings page, built from the sections, with both numbered from the same order | `src/ui/options.*` |
| **T22** | Overlapping settings writes no longer overwrite each other | `src/lib/settings.js`, L34 |
| **T23** | The shipped surface names no other product, and CI keeps it that way | `test/lib/scan.js`, D34 |
| **F39** | Text is a first class shape: multi-line entry, double click to re-edit, corner handles that scale the point size, four alignments including justify, and its own colour | `src/lib/edit.js`, `src/ui/editor.js`, D39 |
| **T24** | A move or resize that changed nothing no longer pushes an undo step, so clicking a shape to select it stops filling the history | `src/ui/editor.js`, D39 |
| **T25** | Three glyphs were toggled with `element.hidden`, which SVG does not have, so none of them ever changed | `src/ui/result.js`, D37 |
| **T26** | The Shapes and Text chevrons opened a popover their own group was clipping | `src/ui/result.html`, D38 |
| **F40** | The text colour is a well beside the font menu, opening the same palette the border and fill controls open | `src/ui/result.*`, D40 |
| **T27** | Picking Arrow could still draw a line. The tool and the arrowheads are reconciled in both directions | `src/ui/editor.js`, D41 |
| **F41** | Hover cursors, a hover outline, and Escape to abandon a drag. Part of F27 | `src/ui/editor.js`, D42 |
| **T28** | The hover outline could be baked into an exported PNG or PDF. `flatten()` dropped the selection but never the hover, and only a pointer-driven export cleared it on the way to the button | `src/ui/editor.js` |
| **F29** | Twelve shapes behind the Shapes chevron, each described once as path operations that the canvas and the hit tester both read. Corner radius is a property of the Box, not two more tools | `src/lib/geometry.js`, D43 |
| **F27** | Shift constrains a resize, arrow keys nudge the selection, Alt drag duplicates. With F41 this completes F27 apart from the right click z-order menu | `src/ui/editor.js`, D44 |
| | Multi-select: shift click, marquee, group move, group delete as one step, group restyle, Cmd+A | `src/lib/edit.js`, `src/ui/editor.js`, D45 |
| | A frame and a plate for text, out of the border colour, the fill and the stroke width. `colour` is the stroke on every shape and `ink` is the glyphs | `src/lib/edit.js`, D46 |
| | Every shape can be switched off individually on the options page | `src/lib/settings.js`, `src/ui/options.js` |
| **T19** | The content security policy names every directive. `connect-src 'none'` never covered a remote subresource, and an absent directive with no `default-src` is unrestricted | `manifest.json`, `test/lib/scan.js`, D15 |
| **T29** | The progress popup opening is now checked. `--headed --popup` fails if `chrome.action.openPopup()` never produces a panel, or produces one that is never told anything | `test/e2e/run.mjs`, `src/background.js` |
| | Support and feedback goes to `support@palworks.ai` rather than a personal address | `src/ui/options.js` |

**Still open from the 1.7.0 list below:** T2, T11, F1, F21, F2, F26.
**Still open from 1.8.0:** F6, F4, and the two remaining pieces of F27 (the right click z-order menu, and shortcut keys in every tooltip).

**Queued by the maintainer on 2026-09-10:** F3, the rating nudge, and F42,
donations. Both are designed in [docs/ROADMAP.md](docs/ROADMAP.md) under release
1.12.0, and the platform comparison behind F42 is D48. **F42 does not start until
[GOVERNANCE.md](GOVERNANCE.md) is amended**, because that document currently says
"No monetisation" without distinguishing a gift from a paid tier, and shipping a
donate link against it would put the product in contradiction with its own
covenant. That amendment is the maintainer's to write.

# Release 1.7.0: the repairs, and the free wins

Removes every known silent failure and closes the one real hole in the security
model. Nothing here needs new UI beyond a menu item and a slider.

### T2 (P1) Add `encodeOrThrow` and stop the silent export failure

**Goal.** `canvas.toBlob()` resolves with `null` when the encoder fails or the
format is unsupported. `src/ui/result.js` passes that `null` straight to
`URL.createObjectURL` and `new ClipboardItem`. Nothing checks it. WebP makes it
reachable.

**Constraints.** One helper used by every format. Do not repeat a null check at five
call sites.

**Acceptance.**
- `encodeOrThrow(kind, quality)` rejects with a named error carrying the format when
  the blob is null.
- Copy and Save both surface it through `say(..., true)`, and the Save button
  re-enables afterwards.
- Test: a stubbed canvas whose `toBlob` yields `null` produces the named error and
  no `createObjectURL` call.
- Fixes L9.

### T3 (P1) Test that settings survive a round trip

**Already covered, do not duplicate.** `test/settings.test.js` tests each validator
individually and asserts unknown keys are dropped. What is missing is the round trip.

**Acceptance.**
- One new test iterates `Object.keys(DEFAULTS)`, writes a valid non default value
  for each, and asserts it survives `saveSettings` then `loadSettings`. It must fail
  if a key is added to `DEFAULTS` and not handled in `sanitise()`.
- Fixes the trap behind L13. Blocks F21, F24 and F3, which all add settings.

### T10 (P1) Warn before losing unsaved edits

**Goal.** Closing the result tab discards the capture and every annotation with no
warning. This is the whole of what survived the apply/discard request
([docs/DECISIONS.md](docs/DECISIONS.md) D14): the guard, not staging.

**Constraints.** No new UI, no Apply button, no pending state.

**Acceptance.**
- The browser's leave-site prompt appears when `isEdited(doc)` is true.
- No prompt when the capture is untouched, or after a save with no further edits.
- The listener is added once, not per render.
- e2e: annotate then attempt to close, the prompt fires; capture and close clean, it
  does not.
- Fixes L10.

### T11 (P1) Version the port protocol

**Goal.** A result tab left open across an extension update can receive messages
from a newer worker and hang with no diagnosis.

**Acceptance.**
- The `plan` message carries `protocol: 1`.
- `src/ui/result.js` refuses a mismatch with "This tab is from an older version.
  Reload it and capture again." rather than proceeding.
- Test asserts the constant is present on both sides.
- Fixes L11. Blocks F10, which changes this contract.

### F1 (P1) WebP export

**Constraints.** `canvas.toBlob('image/webp')`. No library. Depends on T2.

**Acceptance.**
- `DOWNLOAD_FORMATS` gains `webp`; `EXTENSIONS` in `result.js` gains `webp: 'webp'`.
- One more `[data-format]` item in the menu, same two line label style: "WebP",
  "Smaller than PNG, still sharp".
- Feature detection: if the browser cannot encode WebP, the item is not offered
  rather than failing on click.
- The chosen format is remembered for the next capture.
- Test: every format offered in the UI round trips through `applyFilename` with the
  right extension.

### F21 (P1) Export quality control

**Goal.** `JPEG_QUALITY` is hardcoded at 0.92. A full page capture emailed as a JPEG
is often the case where a user wants to trade sharpness for size.

**Acceptance.**
- A quality control appears in the format menu for JPEG and WebP only, never for PNG
  (which is lossless and ignores the argument).
- Stored in settings as an integer percentage, clamped, defaulting to 92.
- The saved status line already reports the file size, so the effect is visible
  immediately. Verify it still does.
- New key added to **both** `DEFAULTS` and `sanitise()`.

### F2 (P1) Pause playing media during the capture

**Constraints.** Content script, self contained, no imports. Resume must live inside
the guarded `restore()` in `src/background.js`, next to `restorePage`, or a capture
that throws mid walk leaves the user's video paused forever.

**Acceptance.**
- `pauseMedia()` pauses only elements that were playing and returns enough to resume
  exactly those.
- `resumeMedia()` tolerates elements removed from the DOM and never throws.
- A video already paused before the capture stays paused after it.
- A page with no media costs nothing measurable.
- Fixes L6.

### F26 (P2) Unmissable confirmation on copy and save

**Goal.** The status line already says "Copied to the clipboard" and "Saved as PNG,
1.2 MB". On a 4000px tall result page the user's eyes are on the image, not the
header.

**Constraints.** No `notifications` permission. Others in this category ask for one; we do not need
one for a confirmation inside our own tab.

**Acceptance.**
- The confirmation is visible without looking away from the canvas: a brief inline
  acknowledgement near the pointer, or a transient banner over the canvas that never
  covers what was just edited.
- It never blocks interaction and it never needs dismissing.
- `prefers-reduced-motion` is respected.

### T20 (P1) Selection chrome must hold its size on screen

**Goal.** On a long capture the selection handles are effectively invisible. This is
a defect, not a preference.

**Cause, confirmed by reading the code.** `src/ui/editor.js` sets
`HANDLE_SIZE = 9` and `drawSelection()` draws each handle at nine **canvas** pixels,
with a 1.5px dashed outline also in canvas pixels. The canvas is fitted to the window
by CSS, so a 14,000px capture renders at roughly 12% and nine canvas pixels become one
screen pixel. The dashed outline lands at 0.18 of a pixel and is not drawn at all.
`pickTolerance()` three functions away already divides by that same display factor, so
the handle stays easy to grab. The hit target was corrected for zoom and the drawing
was never corrected with it.

**Note on the wording.** The request was for handles "proportionate to the size of the
image". Strictly proportional is the same bug pointing the other way: enormous on a
long capture, invisible on a small one. The usual rule in an editor, and what this task
implements, is a constant size **on screen** at any zoom.

**Acceptance.**
- One helper, `screenScale()`, returns `canvas.width / canvas.getBoundingClientRect().width`,
  guarding a zero width box by returning 1.
- `drawSelection()` multiplies the handle size, the outline `lineWidth` and the dash
  lengths by it, so all three hold their size on screen.
- `pickTolerance()` is rewritten in terms of the same helper. There is exactly one
  place that knows the display factor.
- The floor stays: a handle never renders smaller than 9 device pixels, and never
  larger than about 14, so a 400% zoom (F6) does not produce giant blocks.
- Unit test over the helper and the derived sizes at 12%, 100% and 400%, asserting the
  drawn size in screen pixels is constant across all three.

### T1 (P1) README storage claim

Done 2026-09-08. Listed for the record.

# Release 1.8.0: the toolbar becomes yours

**F24 must land first.** It is what lets every later release add controls without
the toolbar becoming unusable. See [docs/DECISIONS.md](docs/DECISIONS.md) D17.

### F24 (P1) Toolbar regrouped, and configurable

**Goal.** Two problems, one release. The toolbar cannot absorb the backlog at 26
flat controls, and different people want different tools.

**Reference.** macOS Preview's markup toolbar, four screenshots reviewed 2026-09-09.
It exposes roughly sixty controls through thirteen buttons. See
[docs/DECISIONS.md](docs/DECISIONS.md) D18 for the pattern and D17 for why
configuration sits alongside it rather than instead of it.

**Constraints.** Settings only, no new permission. New keys go in `DEFAULTS` and
`sanitise()` (T3 protects this).

**Acceptance, part one: grouping.**
- Buttons that own a set carry a **chevron**. Clicking the button uses the current
  value; clicking the chevron opens a popover with the whole set.
- **The glyph is the state.** The Border button is a hollow rounded square stroked in
  the current border colour. The Fill button is the same square filled, slashed in red
  when the fill is none. The Style button draws the current stroke weight to scale. A
  grouped tool button shows the last shape chosen from it.
- Groups: **Shapes** (box, ellipse, line, arrow, highlight), **Text** (see below),
  **Stroke style** (see below), **Border colour**, **Fill colour**, **Zoom** (see F6),
  **Download** (formats, already a menu), **Upload** (F25).
- Ungrouped, because each is its own concept: Select, Pen, Step, Redact, Crop, Undo,
  Redo, Delete, Revert, Copy, Settings.
- Target: **19 buttons carrying 68 controls, against today's 26 flat controls.**
- **Keyboard shortcuts stay bound to individual tools.** `R` still selects the box
  even when it lives behind the Shapes chevron. Grouping costs a mouse click and
  never a keystroke.
- One popover open at a time. `Esc` closes. Click outside closes. The popover never
  covers the canvas region the user just edited.

**Acceptance, part one b: the Stroke style popover.**

Modelled on Preview's, screenshot 2026-09-09 01.22.17.
- Five stroke weights as full width rules of increasing thickness, drawn to scale, so
  the list is the preview.
- A rule, then **dashed** and **dotted**, both implemented with `setLineDash`.
- A rule, then four arrow endings: none, start, end, both. These replace the current
  arrangement where "arrow" and "line" are two separate tools, and the arrow tool
  becomes the line tool with an ending set.
- A rule, then an **exact `px` number input**, 1 to 64, clamped and integer only. The
  five presets write into it and it writes back to the toolbar glyph.
- The stored width stays a number, so shapes drawn before this change render
  unchanged. `dash` and `ends` are new optional keys; a shape without them renders
  exactly as it does today.

**Acceptance, part one c: the two colour popovers.**

One component, one `kind` flag, rendered twice. Preview's border and fill split,
screenshot 2026-09-09 01.22.25.
- **Border colour**: a row of ten quick colours (the six shipped today among them),
  then a sixty step tint and shade grid, then a custom swatch.
- **Fill colour**: **No fill** as its own control and the default, the same palette,
  the same custom swatch, plus an **opacity slider** 0 to 100%. Without opacity a
  fill is unusable over a screenshot.
- The **custom swatch** opens a spectrum: a saturation and brightness square, a hue
  slider, and a **hex field** at the bottom that accepts `#4338CA` or `4338ca` and
  rejects anything else by reverting. This is our `Show Colours…`.
- **Storage.** `colour` keeps its meaning and becomes the border colour. `fill` and
  `fillOpacity` are new optional keys; a shape without them draws as an unfilled
  outline, exactly as today. Do not migrate old shapes.
- Setting a colour with a shape selected restyles that shape and is one undo step.
  With nothing selected it sets the default for the next shape.

**Acceptance, part one d: the Text inspector.**

Modelled on Preview's, screenshot 2026-09-09 01.22.31.
- Family (a short list of stacks that resolve without a network request, since a
  webfont is banned by D13), size in points with a stepper and a typed value, colour,
  bold, italic, underline, and four alignments.
- Every value is stored on the shape, so text drawn ten minutes ago can be restyled.
  Today it can only be deleted and retyped.
- The inline `<input>` used for entry renders with the chosen family, size and weight,
  so what is typed matches what is drawn.
- Shapes without the new keys keep rendering at the current default.

**Acceptance, part two: configuration.**
- The options page lists every toolbar button, grouped as Tools, Style, History,
  Output, with a checkbox each.
- A curated default set ships **on**. Off by default: everything the later phases
  add, so a release never silently widens the toolbar.
- "Show everything" and "Reset to defaults" are both present.
- Hiding a button never disables its keyboard shortcut, which is one of the
  arguments for the command palette (F18).
- Changing a setting updates an open result tab without needing a reload.
- The stored list is validated against the known set on read, so a hostile stored
  value cannot inject a control.

### F6 (P1) Navigate a large capture

**Goal.** A 16,000 pixel capture is currently scaled to fit and that is the only
view available.

**Constraints.** Watch L17: `startTextEntry()` positions its `<input>` once, from
the canvas bounding box, which is correct only while the canvas scrolls with the
document. Putting the canvas in its own scrolling container breaks it.

**Acceptance.**
- **One magnifier button** in the toolbar. Clicking it opens a popover with a zoom
  slider, plus Fit width, Fit height and 100%. Not three separate toolbar controls.
- **Fit width and Fit height are icons, not words.** A horizontal double arrow
  between two uprights for width, the same rotated for height, each with a tooltip
  and an `aria-label` carrying the words. `100%` stays as text, because a number is
  its own icon. This keeps the popover the width of the slider instead of the width
  of the longest label, and it matches how the rest of the toolbar reads.
- The current zoom percentage is readable without opening the popover.
- **An overview pane, top right of the canvas area**, showing the whole capture at a
  glance with the current viewport drawn on it, the way a code editor's minimap
  works. Clicking or dragging inside it moves the view.
- The pane hides itself when the whole capture already fits, and can be turned off
  in settings (F24).
- Inline text entry stays anchored to its point at every zoom level and scroll
  position. This is the acceptance criterion most likely to be missed.
- `toImage()` and `pickTolerance()` already derive scale from the rendered box, so
  the drawing maths should need no change. Prove it with a test that draws at 400%
  and asserts the shape lands at the same image coordinates as at 100%.

### F4 (P1) Freehand pen and object eraser

**Constraints.** No pixel eraser: it would bake pixels into the immutable base image
and break exact undo (D5, L16).

**Acceptance.**
- Pen is a polyline shape: pointer samples in image coordinates, drawn with
  `lineTo`, hit-tested by running the existing `distanceToSegment` over each segment.
- Points are thinned so a slow drag does not store thousands of samples.
- The eraser removes the whole shape under the cursor, reusing `shapeAt` and
  `removeShape`. One undo step per removal.
- Both are off by default in the F24 toolbar set, since the toolbar ships curated.

### F27 (P1) The editor should say what is under the pointer

**Goal.** `canvas.style.cursor` is set once in `applyTool()` and never changes again,
and the `pointermove` handler returns immediately unless a drag is already running. The
canvas gives no feedback at all until you have committed to a click.

**Constraints.** No new dependency, no new permission. Everything here goes inside
handlers that already exist.

**Acceptance.**
- With the select tool active, `pointermove` sets the cursor from what is under it:
  `move` over a shape, `nwse-resize` and `nesw-resize` over the matching corner
  handles, `default` over empty canvas. Drawing tools keep `crosshair`, text keeps
  `text`.
- The shape under the pointer draws a faint hover outline, distinct from the selected
  outline. On a dense capture this is the difference between finding a shape and
  hunting for one.
- Arrow keys nudge the selected shape by 1px, with Shift by 10px, one undo step per
  burst rather than per key repeat.
- Double clicking a text shape reopens the inline editor on it.
- Shift constrains while resizing, not only while drawing. The `constrain` helper
  already exists and is wired only to `buildShape`.
- Alt drag duplicates the shape being dragged.
- `Escape` cancels a drag in progress and restores `drag.before`. Today a mis-started
  drag has to be undone afterwards.
- Right clicking a shape offers Delete, Bring to front, Send to back. Z order is not
  reachable any other way today.
- Every tooltip names its shortcut key, for example `Box (R)`.
- Cursor changes are not tested by the unit suite. Cover the state machine (which
  cursor for which hit result) as a pure function, and leave the DOM to the e2e suite.

### F28 (P1) Select a region of the canvas

**Goal.** Pick out part of the image and act on just that part. Preview offers
rectangular, elliptical, lasso and smart lasso selection; this is the rectangular
one, which is the one a screenshot is actually cut along.

**Constraints, and they shape the whole feature.** The base capture is immutable
(D5): every frame re-renders from it, which is what makes undo exact. So a
selection here cannot be Photoshop's, where the selected pixels are lifted and
moved. It is a **region that operations take as an argument**, which is the honest
version of the idea in this model and is what people actually want on a screenshot.

**Acceptance.**
- A marquee tool drags out a rectangle drawn with a moving dashed outline, using
  the same screen-space chrome as the selection handles (D19), and it resizes by
  its corners like any other shape.
- With a region live, the toolbar offers, and the right click menu repeats:
  **Crop to selection**, **Copy just this**, **Redact this**, **Save just this**.
- Each is one undo step, and each reuses machinery that exists: crop already
  takes a rect, redaction already takes a rect, and export already flattens a
  canvas.
- Only one region at a time. `Esc` clears it. Switching to a drawing tool clears
  it, the way the shape selection already behaves.
- The region is not a shape and never appears in the exported image.
- Elliptical and lasso selection are **not** in this task. A rectangle is what a
  screenshot gets cut along; the others are image-editing tools that would need a
  clipping path through every operation above to mean anything.

### F29 (P2) More shapes behind the Shapes chevron

**Goal.** Preview's shapes popover holds line, arrow, rectangle, rounded
rectangle, ellipse, speech bubble, star, polygon, plus a mask and a loupe. The
Shapes chevron F24 built is where more shapes would go, at no cost to the toolbar.

**The judgement.** Not all of them earn a place in a screenshot annotator:
- **Rounded rectangle**: yes. Every interface element it is drawn around is
  rounded, so a square box reads as slightly wrong. It is `roundRect()` on the
  existing box geometry, and the corner radius rides on the stroke width.
- **Speech bubble**: yes, and it is the one worth most. Explaining a screenshot is
  the job, and a callout with a tail pointing at the thing is how that is done.
  The tail anchor is a fifth handle.
- **Loupe**: yes, and it is the one nobody else in this category has. A circle
  that redraws the region under it magnified, which on a 14,000 pixel capture is
  how you show someone a detail without a second image. It reads from the same
  immutable base the redaction already samples.
- **Star and polygon**: no. They are drawing-app furniture. Nothing in a bug
  report or a how-to needs a five pointed star, and each one still costs a row in
  the popover, an icon, a shortcut and a line in every style path.

**Acceptance.**
- Rounded rect, speech bubble and loupe are added as `BOX_TOOLS`, so hit testing,
  handles, resize, fill, dash and colour all work with no new code paths.
- The speech bubble carries its tail as a point in image coordinates, with its own
  handle, and the tail clamps to the bubble's edge.
- The loupe takes a magnification setting, default 2x, in the style popover.
- Each is off by default in the F24 toolbar set until it has been used once.

# Everything after 1.8.0

Held in [docs/ROADMAP.md](docs/ROADMAP.md) with phases, sizes and reasoning.
Acceptance criteria are written into this file when a release starts, not before,
so they describe the code as it will actually be by then.

| Release | Contents |
|---|---|
| 1.9.0 | F10 multi-part export (streaming, per-part annotations, partial failure), F13 runtime seam verification |
| 1.10.0 | F15 remove an element before capturing, absorbing the old F12 banner handling |
| 1.11.0 | F9 PDF with one-page and split-page modes, F5 presentation frame |
| 1.12.0 | F3 rating nudge, deliberately last in Phase 1 |
| Phase 2 | F8 snip with an attached toolbar, F17 repeat last capture, F16 before and after, F23 text watermark, F25 upload by hand-off |
| Phase 3 | F20 presentation finish and image adjustments |
| Phase 4 | F11 capture library with tabs, F18 command palette, F22 remappable shortcuts, F19 style presets |
| Phase 5 | F14 locales |

# Debt tasks

| # | Task | When |
|---|---|---|
| T14 (P1) | Split `src/ui/result.js` into stitch, export and a thin wiring module. It is now 1,123 lines with more than a dozen module globals, and PDF export, the crop confirm bar and the theme button all landed in it | Before F5. F6 and F27 both add to this file again |
| T8 (P2) | Extract the duplicated `:root` token blocks into `src/ui/theme.css`, linked by all pages | Before F11 adds a third page |
| T5 (P2) | Test that the `GOVERNANCE.md` canary date is not older than the newest `CHANGELOG.md` entry | Any time. It has already drifted (L19) |
| T13 (P3) | Use the exported `HISTORY_LIMIT` in `src/ui/editor.js` instead of a second hardcoded `60` | Any time |
| ~~T6~~ | ~~Collapse the colour swatches and width buttons into two dropdowns~~ | **Superseded 2026-09-09 by F24.** The toolbar is configured, not collapsed. See D17 |
| ~~T17~~ | ~~Document loading the unpacked extension~~ | **Void.** It was already documented in the README's Development section |
