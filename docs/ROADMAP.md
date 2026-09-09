# Roadmap

**This is the north star. One document, five phases, every planned change.**
When you want to know what to work on next, read this file, then read the matching
entry in [../TASKS.md](../TASKS.md) for acceptance criteria.

Last restructured 2026-09-09, after clean-room comparisons against four extensions
and desktop tools in this category. Comparisons were made by using them, never by
reading their code. One of the four is GPL-3.0, which is the only one whose code
could be adapted at all, and none of it has been.


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
| T2 | Add `encodeOrThrow`, so a null blob cannot fail silently | 2h / 15m | Blocks F1 |
| T3 | Round-trip test for every settings key | **shipped** | `test/settings.test.js` |
| T10 | Warn before losing unsaved edits | **shipped** | This is F7, the whole of what survived the apply/discard request. D14 |
| T11 | Version the port protocol | 1h / 10m | Blocks F10 |
| T20 | **Selection handles hold their size on screen** | **shipped**, D19 | A defect, not a preference. `drawSelection()` draws handles at nine **canvas** pixels; at the 12% a 14,000px capture is fitted to, that is one screen pixel, and the 1.5px dashed outline vanishes entirely. `pickTolerance()` already divides by the display factor, so the shape is still easy to grab and impossible to see. One `screenScale()` helper feeds both |
| T1 | Fix the false storage claim in the README | **shipped** | Done 2026-09-08 |
| F1 | **WebP export** | 0.5d / 10m | |
| F21 | **Export quality control** | 0.5d / 10m | A quality slider for JPEG and WebP. We hardcode 0.92 today, which is a guess made once on the user's behalf |
| F2 | **Pause playing media during the capture** | 0.5d / 15m | |
| F26 | **Unmissable confirmation on copy and save** | 0.5d / 15m | The status line already says it. Make it impossible to miss without resorting to the `notifications` permission |

## Release 1.8.0: the toolbar becomes yours

**This release exists because of a decision made on 2026-09-08**, and it changes the
shape of every release after it. The toolbar holds 26 controls and the backlog adds
more. Rather than collapsing controls for everyone, **the user decides which tools
appear**. See [DECISIONS.md](DECISIONS.md) D17.

| # | Item | Effort | Notes |
|---|---|---|---|
| F24 | **Toolbar regrouped, and configurable** | **shipped**, D17, D18, D20, D21 | Two halves. **Grouping, following macOS Preview** ([DECISIONS.md](DECISIONS.md) D18): each button carries a chevron that opens the related set, and the button's glyph shows the current value. Shapes collapse behind one button; five weights, two dash patterns and four arrow endings behind Stroke style; and colour splits into **Border** and **Fill**, Preview's own two glyphs, each ending in a custom spectrum with a hex field. Text opens an inspector: family, size, bold, italic and underline. Colour is taken from Border colour rather than duplicated, and alignment was held back until text entry is multi-line, both recorded as D21. Nineteen buttons then carry sixty eight controls against today's twenty six. This is a capability change as much as a layout one: **there is no fill and no arbitrary colour in the product today**. **Configuration** ([DECISIONS.md](DECISIONS.md) D17): every button has an on/off switch on the options page, a curated default set on, "Show everything" and "Reset to defaults" present. Keyboard shortcuts stay bound to individual tools, so grouping costs a click and never a keystroke. **Must land before F4 and F6 add controls**
| F6 | **Navigate a large capture** | 2d / 1.5h | Zoom is **one magnifier button**; clicking it opens a slider plus Fit width, Fit height and 100%. Alongside it, an **overview pane in the top right** showing the whole capture with the current viewport marked, the way Sublime Text's minimap works. This is what makes a 16,000 pixel capture workable. Watch [LIMITATIONS.md](LIMITATIONS.md) L17: inline text entry must be repositioned when the canvas moves inside a scroll container |
| F4 | **Freehand pen and object eraser** | 2d / 45m | Pen is a polyline shape, hit-tested with the existing `distanceToSegment`. The eraser deletes the shape under the cursor. **No pixel eraser**: it would bake pixels into the immutable base |
| F29 | **More shapes behind the Shapes chevron** | **shipped**, D43 | The chevron F24 built is where extra shapes go for free. Worth taking: **rounded rectangle** (everything it is drawn around is rounded), **speech bubble** (explaining a screenshot is the job, and a callout with a tail is how it is done), and the **loupe**, a circle that redraws what is under it magnified, which nobody else in this category has and which is how you show a detail on a 14,000 pixel capture. Refused: star and polygon, which are drawing-app furniture that no bug report needs. **Shipped as twelve shapes**, the three above plus a flowchart set the maintainer asked for, with the rounded rectangle delivered as a corner radius property of the Box rather than as its own tool. The loupe samples a redacted base so it cannot un-redact a redaction, D47 |
| F27 | **The editor says what is under the pointer** | **shipped except the z-order menu**, D42, D44 | The cursor never changes except when the tool changes, and `pointermove` returns immediately unless a drag is running, so the canvas gives no feedback until you commit to a click. Adds hover cursors, a hover outline, arrow key nudging, Shift constrain while resizing, Alt drag to duplicate, `Escape` to cancel a drag, a right click menu carrying the z order that is unreachable today, and shortcut keys in every tooltip. All of it inside handlers that already exist. **Shipped:** hover cursors and outline and Escape (F41, D42), then Shift constrain, arrow key nudging and Alt drag. **Still open:** the right click z-order menu, which is a new UI surface and deserves its own pass, and shortcut keys in every tooltip |

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

## Release 1.12.0: ask for the rating

| # | Item | Effort | Notes |
|---|---|---|---|
| F3 | **Rating nudge** | 1d / 30m | **Deliberately last in Phase 1.** Asking someone to rate the extension before long pages capture correctly is asking them to rate a product that truncates their work. One status line, never a modal, after the fifth successful capture, capped at two showings ever, with a hard "don't ask again" |


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
