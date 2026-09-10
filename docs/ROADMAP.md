# Roadmap

**This is the north star. One document, five phases, every planned change.**
When you want to know what to work on next, read this file, then read the matching
entry in [../TASKS.md](../TASKS.md) for acceptance criteria.

Last restructured 2026-09-09, after clean-room comparisons against four extensions
and desktop tools in this category. Comparisons were made by using them, never by
reading their code. One of the four is GPL-3.0, which is the only one whose code
could be adapted at all, and none of it has been.


## Everything, on one page

**Read this table first.** One row per item, in the order the phases run. Every row
links to nothing: the detail is in the section of this file that carries the same
number, and the acceptance criteria are in [../TASKS.md](../TASKS.md).

Status is one of **shipped** with the date it landed, **next** for the work that is
already scoped and ready to start, or **planned** with the effort in the form
*human team / Claude Code with gstack*.

| Bucket | # | Work | Status | Notes |
|---|---|---|---|---|
| Core capture | | Full page, sticky and fixed headers, lazy loading, retina and zoom | shipped 1.0.0 to 1.3.1 | The thing the product is for. Verified against a fixture on every run |
| Core capture | | Visible area and pick-an-element modes, capture delay, frames | shipped 1.2.0 to 1.3.0 | Cross-origin frames sit behind an optional permission never granted at install |
| Core editing | | Live-object editor: select, move, resize, restyle, delete, undo | shipped 1.3.0 | Shapes are objects, not committed strokes, which is what makes undo exact |
| Core output | | PNG, JPEG, copy to clipboard, URL-based filenames | shipped 1.3.0 to 1.6.1 | Copy needs no permission |
| 1.7.0 repairs | T19 | Harden the content security policy | shipped | D15. `connect-src 'none'` plus a closed `img-src` |
| 1.7.0 repairs | T3 | Round-trip test for every settings key | shipped | A key in `DEFAULTS` but not in `sanitise()` now fails the build |
| 1.7.0 repairs | T10 | Warn before losing unsaved edits | shipped | D14. All of what survived the apply/discard request |
| 1.7.0 repairs | T20 | Selection handles hold their size on screen | shipped | D19. A defect: nine canvas pixels is one screen pixel on a 14,000px capture |
| 1.7.0 repairs | T1 | Fix the false storage claim in the README | shipped 2026-09-08 | |
| 1.7.0 repairs | T2 | `encodeOrThrow`, so a null blob cannot fail silently | shipped 2026-09-10 | D52. A null blob was a download of nothing with no error anywhere |
| 1.7.0 repairs | T11 | Version the port protocol | shipped 2026-09-10 | D53. Unblocks F10. Exercised by `--stale` |
| 1.7.0 repairs | T30 | A screenful Chrome had already presented is photographed again | shipped 2026-09-10 | D56, L39. **Found in the field**, not by a test. A repeated screenful, and a lost one. Exercised by `--frozen` |
| 1.7.0 wins | F1 | WebP export | shipped 2026-09-10 | D52. Output formats are described once now, not in three lists |
| 1.7.0 wins | F21 | Export quality, and what each format costs | shipped 2026-09-10 | D54. The size readout is the feature; the slider is how you move it |
| 1.7.0 wins | F2 | Pause playing media during the capture | shipped 2026-09-10 | L27, L28. Only what was playing, resumed first in the tidy-up |
| 1.7.0 wins | F26 | Unmissable confirmation on copy and save | shipped 2026-09-10 | D55. The button answers, at the width it already had. No new permission |
| 1.8.0 toolbar | F24 | Toolbar regrouped, and configurable | shipped | D17, D18, D20, D21. 26 flat controls became grouped buttons carrying 68 |
| 1.8.0 toolbar | F25 | Upload, as a hand-off | shipped | D16. The extension never uploads. It copies and opens the host |
| 1.8.0 toolbar | F35 | PDF export, ahead of its release | shipped 2026-09-09 | D31. Hand written, around 200 lines, no library |
| 1.8.0 toolbar | F29 | More shapes behind the Shapes chevron | shipped 2026-09-10 | D43, D47, D51. Twelve shapes, then Rounded box and Stadium as presets |
| 1.8.0 toolbar | F41 | Hover cursors, hover outline, Escape cancels a drag | shipped | D42 |
| 1.8.0 toolbar | F27 | The editor says what is under the pointer | shipped 2026-09-10 | D42, D44, D49. Finished by the paint order menu and a key in every tooltip |
| 1.8.0 toolbar | F40 | Text is a shape, with a frame and a plate | shipped 2026-09-10 | D46, D50. The Frame block replaced the hint that stood in for it |
| 1.8.0 toolbar | F4 | Freehand pen and object eraser | planned, 2d / 45m | No pixel eraser: it would bake pixels into the immutable base |
| 1.8.0 toolbar | F6 | Navigate a large capture: zoom and an overview pane | shipped 2026-09-10 | D58. Zoom is a width, not a scroll container, so L17 closed rather than fired. The pane is the progress popup's page with a marker on it |
| 1.8.0 toolbar | F44 | Opacity in every colour popover, and the frame switches removed | shipped 2026-09-10 | D57. Five hand-written colour panels became one built from `PAINTS`. A redaction still cannot take an opacity |
| 1.8.0 toolbar | F43 | A caption wraps inside a width you set | shipped 2026-09-10 | D60, L41. Two side handles set the width, the height follows the words. A word that exactly fits and a word that cannot fit are the two tests |
| 1.9.0 long pages | F10 | Multi-part export for very long pages | planned, 5d / 2h | **The known defect.** Must stream part by part or Chrome kills the worker |
| 1.9.0 long pages | F13 | Runtime seam verification | planned, 5d / 2h | We verify seams in tests. This verifies them in the field |
| 1.9.5 region | F28 | Select a region of the canvas | planned, 2d / 45m | A marquee other operations take as an argument. Rectangle only |
| 1.10.0 capture | F15 | Remove an element before capturing | planned, 2d / 45m | Cookie banners and chat widgets. No new permission |
| 1.11.0 output | F5 | Presentation frame | planned, 3d / 1h | Padding, a background, an optional window frame. Pure canvas |
| 1.12.0 thanks | F3 | Rating nudge | shipped 2026-09-10 | D59. No review gating: one ask, and the feedback link beside it rather than behind it. Exercised by `--nudge` |
| 1.12.0 thanks | F42 | Donations | shipped 2026-09-10 | D48. The GOVERNANCE.md amendment landed in the same commit. Ships with an empty list, so the section stays hidden until there is somewhere to send money |
| Phase 2 in | F8 | Snip a region on the live page | planned, 3d / 1h | The editor stays in the result tab, where it can never be photographed |
| Phase 2 in | F17 | Repeat the last capture | planned, 1d / 25m | Turns a five step loop into one keystroke |
| Phase 2 out | F16 | Before and after | planned, 0.5d / 15m | Nearly free: the pristine capture is already on its own canvas |
| Phase 2 out | F23 | Text watermark | planned, 1d / 20m | Typed text only, never an image loaded from a URL |
| Phase 3 | F20 | Presentation finish and image adjustments | planned, 4d / 1.5h | All `ctx.filter` and compositing, no library |
| Phase 3 | F30 | Adjust size on export | planned, 1.5d / 30m | The "resulting size" readout is the part that earns it |
| Phase 4 | F11 | Capture library | planned, 8d / 3h | **The only feature that changes the trust posture.** Off by default, IndexedDB |
| Phase 4 | F18 | Command palette | planned, 2d / 40m | The cheapest real progress on L14, the editor without a pointer |
| Phase 4 | F22 | Remappable editor shortcuts | planned, 2d / 40m | In-editor keys only |
| Phase 4 | F19 | Style presets | planned, 1d / 20m | |
| Phase 5 | F14 | Locales | planned, 10d / 4h | Verify `getManifest()` returns a localised `short_name` first: it feeds every filename |
| Debt | T14 | Split `src/ui/result.js` into stitch, export and wiring | planned, P1 | Before F5. F6 and F27 both added to this file again |
| Debt | T8 | Extract the duplicated `:root` token blocks | planned, P2 | Before F11 adds a third page |
| Debt | T5 | Test that the GOVERNANCE.md canary is not stale | planned, P2 | It has already drifted, L19 |
| Debt | T13 | Use the exported `HISTORY_LIMIT` instead of a second hardcoded 60 | planned, P3 | |

**Release 1.7.0 is complete.** Every repair and every free win in it has shipped.

**What to pick up next: F10**, multi-part export for very long pages. It is the only
item on this page that fixes something a user has actually hit, T11 has unblocked it,
and it is the last thing standing between the product and an honest claim that it
captures long pages. After it, F13 verifies the same seams in the field.


## The rule every item is measured against

**`test/invariants.test.js` must still pass when the feature ships.** No network,
no remote code, no required host permissions, no `update_url`, no build step, no
dependencies. If a feature cannot be built inside that boundary, it does not get
built. **The boundary is the product**, and every competitor studied so far has
traded it away: two of them require access to every site you visit at install, one
of them declares a server push channel, and one ships a 2.8MB WebAssembly binary.

Two traps that catch tools like this one:

- **Fonts and icon sets.** A webfont is a network request. Every glyph in the editor
  is an inline SVG path or a system font, and that is why the UI uses `system-ui`.
  See [DECISIONS.md](DECISIONS.md) D13.
- **Image libraries.** jsPDF, Fabric.js, Konva, Cropper.js: each is a build step and
  a supply chain. Canvas 2D already does everything in Phases 1 to 3. The nearest
  competitor pays 740KB for jQuery, anime.js and jsPDF; we pay nothing.


## How to read the phases

Phases group work by **what the product becomes**, not by difficulty. Inside a
phase, work is cut into releases, because Phase 1 as scoped is roughly five
releases and calling it one would be a lie.

| Phase | Theme | State |
|---|---|---|
| **Phase 1** | Trustworthy and complete. Fix what is broken, finish the core, make the toolbar configurable | in progress |
| **Phase 2** | Capture and share. Better ways in, and a way out that does not cost the invariants | planned |
| **Phase 3** | Presentation. Make a capture look deliberate | planned |
| **Phase 4** | Power user. Palette, shortcuts, a library of captures | planned |
| **Phase 5** | Reach. 50+ locales | planned |

Effort is given at both scales: a human team, and Claude Code with gstack.


## Shipped on 2026-09-09

The toolbar release landed early, together with three repairs and two features that
were not on the plan until a bug or a question made them urgent.

| # | Item |
|---|---|
| F24 | **The grouped toolbar.** 26 flat controls became 16 buttons carrying 68. Shapes, Text, Stroke style, Border colour and Fill colour each own a set; Shapes and Text are split buttons. Every button can be switched off on the options page |
| F25 | **Upload, as a hand-off.** Copies the image and opens ImgBB, Postimages or Litterbox. No request is made by the extension, and none can be |
| T20 | **Selection handles hold their size on screen.** They were nine canvas pixels, which is one screen pixel on a 14,000px capture |
| T10 | **A guard before the result tab is closed or reloaded.** Refreshing silently destroyed the capture and every annotation |
| T3 | **Settings round trip**, so a key added to `DEFAULTS` but not `sanitise()` fails the build rather than failing silently |
| | **Fill and any colour.** Shapes had no fill at all and six colours; they now have both, with opacity |
| | **Text styling**, and the text tool works: its inline box had no CSS rule and the browser took focus back off it |
| | **Settings as a file**, exported and imported, since settings deliberately do not sync |
| | **Support and feedback**, composing a message in the user's own mail app |
| | **A rendered-page audit** on every end-to-end run, after three CSS specificity bugs shipped in one day |
| | **A new mark**, a retro camera caricature on a teal disc |

## Already shipped

| Feature | Version |
|---|---|
| Full page capture, sticky and fixed header handling, lazy loading, retina and zoom correctness | 1.0.0 to 1.3.1 |
| Crop, arrow, line, box, ellipse, highlighter, destructive redaction, text, numbered steps, undo and redo over every edit type | 1.2.0 to 1.3.0 |
| Copy to clipboard, needing no permission | 1.3.0 |
| Visible area and pick-an-element capture modes, behind a setting | 1.3.0 |
| Same-origin frames laid out at full height before capture | 1.2.0 |
| Cross-origin frame capture, behind an optional permission that is never granted at install | 1.3.0 |
| **Capture delay**, 0 to 10 seconds, clamped, in settings | 1.3.0 |
| Progress in the toolbar icon and an animated progress panel | 1.4.0 |
| URL-based filenames, editable before saving, protected by `short_name` | 1.4.0 to 1.6.1 |
| Live-object editor: select, move, resize, restyle and delete after drawing | 1.3.0 |

A capture delay was on the request list. It already exists as
`captureDelay` in `src/lib/settings.js`, exposed on the options page.


# Phase 1: trustworthy and complete

The product currently truncates long pages, fails silently on three paths, and has
a toolbar that cannot absorb the features below. Phase 1 fixes all three. Nothing
in Phase 2 should start before this finishes.

## Release 1.7.0: the repairs, and the free wins

Small, and it removes every known silent failure.

| # | Item | Effort | Notes |
|---|---|---|---|
| T19 | **Harden the content security policy** | **shipped**, D15 | `connect-src 'none'` blocks fetch, XHR, WebSocket and beacons. It does **not** block `<img src="https://...">`, because our CSP sets no `default-src` and therefore leaves `img-src`, `style-src`, `font-src` and `media-src` unrestricted. One line closes it. See [DECISIONS.md](DECISIONS.md) D15 |
| T2 | Add `encodeOrThrow`, so a null blob cannot fail silently | **shipped**, D52 | `canvas.toBlob` reports failure by calling back with `null`, so wrapping it in a promise and resolving whatever arrived turned every encoding failure into a download of nothing. Unit tested with a fake canvas, because a real one has to exceed the encoder before it fails |
| T3 | Round-trip test for every settings key | **shipped** | `test/settings.test.js` |
| T10 | Warn before losing unsaved edits | **shipped** | This is F7, the whole of what survived the apply/discard request. D14 |
| T11 | Version the port protocol | **shipped**, D53 | An update replaces the service worker and leaves the pages it opened running old code. Only the worker can be newer than the page, so only that direction is checked. Exercised by `--stale`, which points the worker at a later protocol than the pages read |
| T20 | **Selection handles hold their size on screen** | **shipped**, D19 | A defect, not a preference. `drawSelection()` draws handles at nine **canvas** pixels; at the 12% a 14,000px capture is fitted to, that is one screen pixel, and the 1.5px dashed outline vanishes entirely. `pickTolerance()` already divides by the display factor, so the shape is still easy to grab and impossible to see. One `screenScale()` helper feeds both |
| T1 | Fix the false storage claim in the README | **shipped** | Done 2026-09-08 |
| F1 | **WebP export** | **shipped**, D52 | And the output formats are described once, in `src/lib/encode.js`, rather than in the settings list, the extension table and the markup, which could disagree in either direction without an error |
| F21 | **Export quality, and what each format costs** | **shipped**, D54 | Approved as a slider and sent back with the reason: people move a quality control only to change a file size, so one without a readout cannot answer the question being asked. Every row in the download menu now carries the real encoded size, and the two lossy ones re-measure as the slider moves. Measured only while the menu is open, cheapest format first, and cached against the quality that produced it |
| F2 | **Pause playing media during the capture** | **shipped**, L27, L28 | A walk takes seconds and a video playing through it is photographed at a different frame in every screenful it spans. Only what was playing is paused, and it is the first thing started again when the page is handed back, because it is the one piece of the tidy-up the reader can hear |
| F26 | **Unmissable confirmation on copy and save** | **shipped**, D55 | The button that was pressed answers: a tick, a green ground for two seconds, and an accessible name that says what happened. At the width it already had, because widening an icon button would shove everything to its right sideways and back. A toast was refused as a new floating surface for a sentence that already has somewhere to live |

## Release 1.8.0: the toolbar becomes yours

**This release exists because of a decision made on 2026-09-08**, and it changes the
shape of every release after it. The toolbar holds 26 controls and the backlog adds
more. Rather than collapsing controls for everyone, **the user decides which tools
appear**. See [DECISIONS.md](DECISIONS.md) D17.

| # | Item | Effort | Notes |
|---|---|---|---|
| F24 | **Toolbar regrouped, and configurable** | **shipped**, D17, D18, D20, D21 | Two halves. **Grouping, following macOS Preview** ([DECISIONS.md](DECISIONS.md) D18): each button carries a chevron that opens the related set, and the button's glyph shows the current value. Shapes collapse behind one button; five weights, two dash patterns and four arrow endings behind Stroke style; and colour splits into **Border** and **Fill**, Preview's own two glyphs, each ending in a custom spectrum with a hex field. Text opens an inspector: family, size, bold, italic and underline. Colour is taken from Border colour rather than duplicated, and alignment was held back until text entry is multi-line, both recorded as D21. Nineteen buttons then carry sixty eight controls against today's twenty six. This is a capability change as much as a layout one: **there is no fill and no arbitrary colour in the product today**. **Configuration** ([DECISIONS.md](DECISIONS.md) D17): every button has an on/off switch on the options page, a curated default set on, "Show everything" and "Reset to defaults" present. Keyboard shortcuts stay bound to individual tools, so grouping costs a click and never a keystroke. **Must land before F4 and F6 add controls**
| F6 | **Navigate a large capture** | **shipped** 2026-09-10, D58 | Zoom is **one magnifier button**; its popover holds a slider plus Fit width, Fit height and 100%. Alongside it, an **overview pane in the top right**. The pane is a **schematic of a page and not a picture of the capture**: the same sheet the progress popup draws while capturing, with a marker on it, which is what the maintainer asked for after turning down a minimap as too much. It answers the only question it is asked, costs no drawing at all, and hides itself when the whole capture already fits on screen. Zoom sets the canvas's CSS width and leaves the page doing the scrolling, so [LIMITATIONS.md](LIMITATIONS.md) L17 was **closed rather than fired** |
| F43 | **A caption wraps inside a width you set** | **shipped** 2026-09-10, D60 | Full design below |
| F4 | **Freehand pen and object eraser** | 2d / 45m | Pen is a polyline shape, hit-tested with the existing `distanceToSegment`. The eraser deletes the shape under the cursor. **No pixel eraser**: it would bake pixels into the immutable base |
| F29 | **More shapes behind the Shapes chevron** | **shipped**, D43 | The chevron F24 built is where extra shapes go for free. Worth taking: **rounded rectangle** (everything it is drawn around is rounded), **speech bubble** (explaining a screenshot is the job, and a callout with a tail is how it is done), and the **loupe**, a circle that redraws what is under it magnified, which nobody else in this category has and which is how you show a detail on a 14,000 pixel capture. Refused: star and polygon, which are drawing-app furniture that no bug report needs. **Shipped as twelve shapes**, the three above plus a flowchart set the maintainer asked for, with the rounded rectangle delivered as a corner radius property of the Box rather than as its own tool. The loupe samples a redacted base so it cannot un-redact a redaction, D47. **Reopened and closed again on 2026-09-10 after user feedback**: the corner radius stays a property, and **Rounded box** and **Stadium** are now also entries in the Shapes popover that pick the Box and set that property in one click. Fourteen entries, twelve kinds, no new shape in the model, D51 |
| F27 | **The editor says what is under the pointer** | **shipped except the z-order menu**, D42, D44 | The cursor never changes except when the tool changes, and `pointermove` returns immediately unless a drag is running, so the canvas gives no feedback until you commit to a click. Adds hover cursors, a hover outline, arrow key nudging, Shift constrain while resizing, Alt drag to duplicate, `Escape` to cancel a drag, a right click menu carrying the z order that is unreachable today, and shortcut keys in every tooltip. All of it inside handlers that already exist. **Shipped in full on 2026-09-10.** Hover cursors and outline and Escape came first (F41, D42), then Shift constrain, arrow key nudging and Alt drag. The last two landed together: a **right click menu on the canvas** carrying Bring to front, Bring forward, Send backward, Send to back and Delete, with `[` and `]` for a step and the platform accelerator for all the way (D49); and **a key in every tool's tooltip**, which meant giving the five shapes that had none a letter from their own name. Empty canvas keeps Chrome's own menu, because taking away "Save image as" to show a menu of greyed-out items is a straight loss |

## Release 1.9.0: long pages, properly

The defect a real user hit on a live blog. This is a repair, not a feature.

| # | Item | Effort | Notes |
|---|---|---|---|
| F10 | **Multi-part export for very long pages** | 5d / 2h | Slice into parts of at most 16,384 device pixels, each at full resolution, instead of downscaling the whole page to 50% and then truncating. **Must stream part by part**: the worker accumulates base64 screenfuls today and four parts held at once is gigabytes in a process Chrome may kill. Annotations belong to the part. A failed part must still deliver the parts that worked |
| F13 | **Runtime seam verification** | 5d / 2h | Compare the overlap band of consecutive screenfuls and re-shoot a tile whose band does not match. We verify seams in tests; this verifies them in the field |

## Release 1.9.5 candidate: select a region

| # | Item | Effort | Notes |
|---|---|---|---|
| F28 | **Select a region of the canvas** | 2d / 45m | A marquee that other operations take as an argument: crop to it, copy just it, redact it, save just it. Not Photoshop's selection, because the base capture is immutable (D5) and lifting pixels would break exact undo. Rectangle only: it is what a screenshot gets cut along, and lasso would need a clipping path through every operation to mean anything |

## Release 1.10.0: control what gets captured

| # | Item | Effort | Notes |
|---|---|---|---|
| F15 | **Remove an element before capturing** (absorbs the old F12) | 2d / 45m | Two modes on one mechanism. **Automatic:** hide fixed overlays in the first screenful too, which is a setting, not a heuristic, because `markSpecialElements()` already tags them and `HIDE_FIXED_CSS` already hides them from screenful two onward. **Manual:** hover to highlight, click to remove, then capture, reusing the hit-testing already in `src/content/pick.js`. Cookie banners, ads, floating chat widgets, newsletter modals. No new permission |

## Release 1.11.0: output worth sending

| # | Item | Effort | Notes |
|---|---|---|---|
| F9 | **PDF export** | **shipped 2026-09-09 as F35**, ahead of this release. Hand-written in `src/lib/pdf.js`, around 200 lines with the comments. It shipped in one shape rather than two: pages at the capture's own width, no scaling and no margins, with the height divided evenly so the last page is never a sliver. Standard page sizes (A4, Letter, Legal) were **not** built, because a screenshot fitted to A4 is either letterboxed or shrunk, and neither is what the reader asked for. Revisit only if someone asks. See [DECISIONS.md](DECISIONS.md) D31 |
| F5 | **Presentation frame** | 3d / 1h | Padding, a background, and an optional browser window frame carrying the real page title and URL. The nearest competitor offers five chrome styles (macOS, Windows, Chrome, Firefox, Edge) with editable tab name and URL, which is the level to match. Pure canvas, no fonts beyond the system stack. The rest of the treatment is Phase 3 |

## Release 1.12.0: ask for the rating, and offer a way to say thanks

| # | Item | Effort | Notes |
|---|---|---|---|
| F3 | **Rating nudge** | 1d / 30m | **Deliberately last in Phase 1.** Asking someone to rate the extension before long pages capture correctly is asking them to rate a product that truncates their work. One status line, never a modal, after the fifth successful capture, capped at two showings ever, with a hard "don't ask again". Full design below |
| F42 | **Donations** | 0.5d / 15m | A quiet line on the options page and a Sponsor button on the repository. Links only, opened in a tab, so no request is ever made by the extension. **Blocked on a GOVERNANCE.md amendment**, see below |

### F3, the rating nudge, in detail

**Where it goes.** One line at the foot of the result tab, in the same strip that
already says "The image never leaves your computer." Never a modal, never a new
window, never the options page opening by itself. The editor is where the value was
just delivered, so it is where the question belongs, and a status line can be
ignored by simply not reading it.

**When it fires.** After the **fifth successful capture**, and only if that capture
was successful. Suppress it when the last capture failed, was truncated by the tile
cap, or was ended early with Finish now: asking for five stars immediately after
handing someone a short image is asking to be told exactly what they think.

**How often.** At most **twice ever**. A dismissal is remembered permanently. Second
showing no earlier than the twenty-fifth capture. The counters live in
`chrome.storage.local`, like everything else, because rule 5 bans synced storage,
which also means the ask is per-browser rather than per-person.

**What it must not do**, all three of these are Chrome Web Store policy or close
enough to it that the distinction is not worth testing:

- **No incentive.** Nothing is unlocked, granted or discounted for leaving a review.
- **No repetition.** "Repeatedly asking users to rate" is a listed abuse.
- **No review gating.** The common pattern is a sentiment fork: "Enjoying it?" with
  Yes going to the store and No going to a feedback form. It measurably lifts the
  average score, which is the reason it is popular, and that is also the reason to
  refuse it here. It filters unhappy users out of the public record. A product sold
  on being checkable does not get to quietly curate its own reviews. **Both answers
  go to the store, and the feedback link sits beside the ask, not behind it.**

**The link.** `https://chromewebstore.google.com/detail/<extension id>/reviews`,
opened with `chrome.tabs.create`. The browser makes that request, not the extension,
which is the same reasoning that lets F25 hand off an upload without a byte of
network access of our own. `connect-src 'none'` stays literally true.

**Alternatives considered.** A time-based trigger (seven days after install) rates
patience rather than usefulness. A star widget inside the extension that posts
nowhere is theatre. A badge on the toolbar icon competes with the progress count,
which is the one thing that badge means.

### F42, donations, in detail

**The conflict, stated first.** [GOVERNANCE.md](../GOVERNANCE.md) currently reads
"**No monetisation.** Monetisation is the pressure that pulls a tool like this
across the network boundary", and this roadmap's own "Explicitly not planned"
section rules out premium tiers on the same grounds. A donation link does not do any
of what that rule was written to prevent: it needs no account, no server, no
authentication, and no network access from the extension. But the covenant as
written does not say that, and a reader who checks will find a contradiction between
the promise and the product.

**So F42 does not ship until GOVERNANCE.md is amended to distinguish the two**, in
words the maintainer chooses, and the amendment lands before or with the feature and
never quietly afterwards. The distinction to draw is between **money that creates an
obligation** (a paid tier, which needs accounts, which needs a server) and **money
that creates none** (a gift, which needs a link). The first is banned because it
pulls the product across the boundary. The second cannot.

**Where it goes.** A single line at the foot of the options page, near the support
and feedback form, and a Sponsor button on the repository via
`.github/FUNDING.yml`. Not in the editor, not in the progress panel, and not after a
capture: the rating nudge already spends the one interruption this product is
willing to make, and asking for money in the same breath as asking for a review
turns both into noise.

**Platforms.** The full comparison is in [DECISIONS.md](DECISIONS.md) D48. The short
version is that **GitHub Sponsors** is the one that matters, because the repository
is the product's shop window, and **Open Collective** is the one that fits, because
it publishes every rupee in and out and this project's entire argument is that you
should not have to take its word for anything.

**What it must not do.** No feature is gated, delayed or degraded for anyone who
does not pay, ever. The moment a donation buys something, the covenant above is no
longer true, and the reason the covenant exists is that everybody who has broken it
said the same thing first.

# Phase 2: capture and share

## Ways in

| # | Item | Effort | Notes |
|---|---|---|---|
| F8 | **Snip a region on the live page** | 3d / 1h | Drag a region on the page itself. The toolbar appears attached to the selection with a live size readout and confirm or cancel, which is the standard shape of a region snipper and is now built for the crop tool (F34). `planCapture` already accepts an arbitrary region and `pick.js` already shows how to inject an overlay. **What we do not adopt:** editing inside the page. Our editor lives in the result tab, where it can never end up in the photograph |
| F17 | **Repeat the last capture** | 1d / 25m | Re-shoot the same region or element without selecting it again. For anyone iterating on a page it turns a five step loop into one keystroke |

## Ways out

| # | Item | Effort | Notes |
|---|---|---|---|
| F16 | **Before and after** | 0.5d / 15m | Hold to compare the edited image against the original. Nearly free, because the pristine capture is already kept on its own canvas and is never drawn into |
| F23 | **Text watermark** | 1d / 20m | Typed text, positioned, with opacity. **Never an image loaded from a URL**, which is how the nearest competitor does it and is exactly the hole T19 closes |
| F25 | **Upload and share, by handing off** | 3d / 1h | The extension never uploads. It puts the image on the clipboard and opens the host you chose, so the request is made by that site, in a tab you can see, and `connect-src 'none'` stays literally true. Hosts, the alternatives, and the reason a direct API upload is refused: [DECISIONS.md](DECISIONS.md) D16 |


# Phase 3: presentation

| # | Item | Effort | Notes |
|---|---|---|---|
| F20 | **Presentation finish and image adjustments** | 4d / 1.5h | Drop shadow, rounded corners, border, and a date stamp, plus brightness, contrast, saturation, grayscale and invert. All of it is `ctx.filter` and canvas compositing, no library. Merges the "image adjustments" and "effects" requests, which are the same feature seen from two products, and completes the treatment F5 starts |
| F30 | **Adjust size on export** | 1.5d / 30m | Preview's Image Dimensions dialog: fit into a preset or a custom size, width and height in pixels, per cent, cm or inches, resolution in pixels per inch, scale proportionally, and a live "resulting size, 844 KB (was 844 KB)" readout. The readout is the part that earns it: a full page capture is often too large to attach to a ticket, and today the only answer is to save it and resize it somewhere else. Judgement call still open on whether it belongs here or in release 1.11.0 next to the other output work |

# Phase 4: power user

| # | Item | Effort | Notes |
|---|---|---|---|
| F11 | **Capture library** | 8d / 3h | History with thumbnails, bulk download and delete, and auto-prune, **plus a tabbed model**: several captures open at once rather than a tab per capture. **The only feature that changes the trust posture.** IndexedDB, not `chrome.storage.local`. Off by default, explicit opt-in stating that images are written to disk, prune by count and age, a visible delete-all, and a schema version from day one. `docs/PRIVACY.md` and the README table change in the same commit as the code |
| F18 | **Command palette** | 2d / 40m | Type to reach any tool or action. It is also the cheapest real progress on [LIMITATIONS.md](LIMITATIONS.md) L14, the editor being unusable without a pointer, which is the better reason to want it |
| F22 | **Remappable editor shortcuts** | 2d / 40m | Click a key, press its replacement, reset to defaults. In-editor keys only: Chrome's own command shortcuts can be remapped by the user at `chrome://extensions/shortcuts` and by nobody else |
| F19 | **Style presets** | 1d / 20m | Save a named colour, width and tool combination and reuse it |


# Phase 5: reach

| # | Item | Effort | Notes |
|---|---|---|---|
| F14 | **Locales** | 10d / 4h | `_locales` plus `chrome.i18n`, no build step required. The three competitors ship 54, 54 and 42 locales; we ship one. **Verify first** that `chrome.runtime.getManifest()` returns the localised `short_name`, because `captureBasename` slugs it into every filename, then land it alone |


## The iframe question, settled by measurement

Tested in `test/e2e/fixture/iframes.html` against a genuinely cross-origin frame:

- **Iframe content is captured.** `captureVisibleTab` photographs what is painted,
  so cross-origin frames appear exactly as the user sees them. No permission is
  involved and none is needed.
- **Same-origin frames are laid out at full height** before capture, shipped in
  1.2.0. Verified: a 400px frame holding 3000px now contributes all 3000.
- **Cross-origin frames still contribute only their visible box** unless the user
  opts in. `contentDocument` throws, so their height cannot be read from the parent.

Going further needs `webNavigation` to enumerate frames and `<all_urls>` to script
them. **Shipped in 1.3.0 on exactly those terms**: both are optional, never granted
at install, and requested only when the user ticks a box that states the cost in
plain words. `test/invariants.test.js` enforces the distinction: required
`host_permissions` remain banned outright.

The argument for allowing it at all: `connect-src 'none'` means that even fully
granted, the extension can read a page and still has no way to transmit what it
read. Reading and exfiltrating are separate powers, and only the first is on the
table. See [ADVANCED-ACCESS.md](ADVANCED-ACCESS.md).


## Explicitly not planned

| Feature | Why not |
|---|---|
| **Direct API upload to an image host** | Chrome's extension CSP is static in the manifest. There is no way to make a `connect-src` allowance conditional on a setting, so shipping it would weaken the CSP permanently, for every user, including everyone who never uploads. See [DECISIONS.md](DECISIONS.md) D16 |
| Cloud accounts, sync, premium tiers | Monetisation is what pulls a tool like this across the network boundary, in a predictable order: a paid tier needs accounts, accounts need authentication, authentication needs a server. The boundary is the product, so the boundary wins |
| OCR, and PII auto-redaction built on it | Both competitors that offer it bundle a 2.8MB Tesseract WebAssembly binary and relax their CSP with `wasm-unsafe-eval` to run it. A model is either a network call or a large opaque binary, and both break verifiability |
| Plugins downloaded at runtime | Desktop capture tools do this for OCR and it is entirely reasonable for an application the user installed deliberately. For us, downloading a plugin **is** remote code. This is the clearest "reasonable elsewhere, banned here" case in the project |
| Custom script uploaders, FTP, imgur API keys embedded in the repo | Network, plus a public credential in an open-source repository is a credential we have to answer for |
| Telemetry, even anonymous | There is no such thing as a little network access |
| Auto-update from outside the Web Store | `update_url` is banned by the invariants |
| Stickers, custom sticker packs | Built-in ones are bloat, custom ones mean loading arbitrary files |
| Reverse image search, social sharing buttons | Every one of them uploads your screenshot to a third party |
| An animated character in the progress indicator | A cartoon character in a loading animation is a copyright complaint waiting to happen, and this project has no appetite for one. The progress indicator is our own geometry for exactly that reason |
| Pixel eraser | It would bake pixels into the immutable base image and break exact undo |
| Firefox or Safari ports | A different manifest and a different verification story |


## What the competitors hold that we refuse to

Kept here because it is the clearest statement of what this product is, and because
it is the store listing's strongest argument.

| | OpenFullPage | Competitor A | Competitor B | Competitor C |
|---|---|---|---|---|
| Site access at install | **none** | `<all_urls>` | `<all_urls>` | `*://*/*` |
| Content script on every page | **no** | no | **yes** | no |
| Can send data anywhere | **no, CSP-enforced** | yes | yes | yes, by design |
| Server push channel | **no** | no | **`gcm`** | no |
| Reads your cookies | **no** | no | no | **yes** |
| Dependencies | **zero** | jsPDF | jQuery, anime.js, jsPDF, Tesseract WASM | jQuery, colpick |
| Install size | **~100KB** | ~1MB | 6.4MB | 1.6MB |
| Shipped build matches the source | **byte for byte** | no | no | no |

### F43, a caption that wraps, in detail

**What is wrong today.** A text shape has no width. Its box is measured from the
longest line it happens to contain, so adding a word to a caption makes the box
wider rather than pushing the word onto the next line, and a long sentence runs
off across the picture instead of forming a paragraph. The corner handles scale
the point size, because scaling is the only thing a box with no width of its own
can do. This is [LIMITATIONS.md](LIMITATIONS.md) L41.

**What it should do**, which is what Preview does. A text box carries a width.
Two handles, at the midpoints of the left and right edges, are the only handles
that change it. Dragging one re-wraps the words inside the new width and the
height follows from how many lines that takes. The top and bottom edges are not
draggable at all, because the height is not a thing anyone sets: it is a
consequence of the words and the width.

**What has to change.**

- **The model.** A text shape gains an optional `wrap`, in image pixels. Optional
  is the migration: a shape saved without one is a shape that has never been
  given a width, and it measures the way it does today. Nothing has to be
  converted, and a capture annotated before this lands keeps its layout.
- **`measureText`.** Given a `wrap`, it breaks each line on word boundaries at
  the measured width and returns the resulting line count, so the frame, the
  plate and the hit box all follow without knowing anything new.
- **`drawText`.** Draws the broken lines rather than the stored ones. The stored
  text keeps its own newlines: a wrap is a display width, never an edit to what
  was typed.
- **The handles.** `handlesFor` returns the two edge midpoints for a text shape
  with a `wrap`, and the corner handles keep scaling the point size for one
  without. A drag on a side handle sets `wrap`, and sets it for the first time on
  a shape that had none.
- **The entry box.** `startTextEntry` uses `white-space: pre` and grows from
  `scrollHeight`. With a wrap it becomes `pre-wrap` at the same width, so what is
  typed still looks like what will be drawn, which is the property that whole
  function exists to hold.

**The one real decision inside it.** Word breaking has to be done with
`ctx.measureText`, in the editor, and `measureText` in `src/lib/edit.js` is pure
and takes a measuring function precisely so that it can. That seam already
exists, so the breaking algorithm is unit testable against a fake measurer, which
is where the off-by-one lives: a word that exactly fills the width, and a single
word longer than the width, which cannot be broken and must be allowed to
overflow rather than loop forever.
