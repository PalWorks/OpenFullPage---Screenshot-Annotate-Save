# OpenFullPage

**Capture a whole web page as one image, annotate it, save it. It has no network access, and you can prove that in about five minutes.**

[![CI](https://github.com/PalWorks/OpenFullPage---Screenshot-Annotate-Save/actions/workflows/ci.yml/badge.svg)](https://github.com/PalWorks/OpenFullPage---Screenshot-Annotate-Save/actions/workflows/ci.yml)
[![Licence: GPL-3.0-only](https://img.shields.io/badge/licence-GPL--3.0--only-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-informational.svg)](manifest.json)
[![Chrome 116+](https://img.shields.io/badge/chrome-116%2B-informational.svg)](manifest.json)
[![Dependencies: zero](https://img.shields.io/badge/dependencies-0-success.svg)](#tech-stack)
[![Build step: none](https://img.shields.io/badge/build%20step-none-success.svg)](#verify-what-is-running-in-your-browser)

A Chrome extension that photographs an entire page, not just the part you can see, opens it in a real editor, and saves it as PNG, JPEG, WebP or PDF. It asks for no site access at install, sends nothing anywhere, and ships the same bytes that are in this repository.

**Website:** <https://palworks.github.io/openfullpage-site/>

## Contents

- [Overview](#overview)
- [Verify what is running in your browser](#verify-what-is-running-in-your-browser)
- [Features](#features)
- [Permissions](#permissions)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Module reference](#module-reference)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Governance](#governance)
- [Licence](#licence)
- [Acknowledgements](#acknowledgements)

## Overview

**The problem.** Full page screenshot extensions are among the most installed tools in any browser store, and they are also among the most over privileged. The usual shape is: access to every site you visit, granted at install, plus a bundled build the user cannot read, plus an upload path "for sharing". Browser extensions with large install bases are also bought and sold, and an extension that changes hands can ship whatever the new owner likes through an ordinary auto update, because Chrome only re-prompts users when *permissions* increase. Nobody re-consents, and nobody notices.

**The response.** OpenFullPage delivers the feature list without the trade. Every capability below is built inside a boundary that is enforced by Chrome and checked by CI, not promised in a privacy policy.

| Property | How it is enforced | Where |
|---|---|---|
| No network access of any kind | `connect-src 'none'` in the manifest CSP. Chrome refuses `fetch`, `XMLHttpRequest`, `WebSocket` and `sendBeacon` regardless of what the code asks for | [`manifest.json`](manifest.json) |
| No access to sites you do not capture | `activeTab` only. Broad access is offered on the settings page, never granted at install | [`manifest.json`](manifest.json) |
| No remote code | No `eval`, no `new Function`, no `update_url`, no remotely fetched configuration or lists | [`test/lib/scan.js`](test/lib/scan.js) |
| No dependencies and no build step | The shipped zip is byte identical to this repository | [`tools/pack.mjs`](tools/pack.mjs) |
| No synced storage | `chrome.storage.sync` would send your configuration to Google. Banned outright | [`src/lib/settings.js`](src/lib/settings.js) |
| No page can reach the extension | No `web_accessible_resources`, no `externally_connectable` | [`manifest.json`](manifest.json) |

Every row is a test in [`test/invariants.test.js`](test/invariants.test.js) and fails the build when broken. `test/fixtures/violation.js` is a deliberately poisoned file that the suite asserts every rule fires on, because a checker that cannot fail is worse than no checker.

**Who it is for.** Anyone who takes screenshots of web pages and would rather not grant a background process permanent read access to their banking, email and internal tooling. Also anyone who wants to read the entire thing before installing it: the shipped surface is 17 files and roughly 6,200 lines, about half of which are comments explaining why.

## Verify what is running in your browser

This is the claim the whole design exists to support, so it goes near the top.

Because there is no build step, no bundler, transpiler or minifier, the code Chrome runs is the code in this repository, character for character. You do not need to reproduce a build or trust an attestation. Diff it:

```bash
# macOS. The extension id and version come from chrome://extensions with
# Developer mode on.
diff -r --exclude=_metadata \
  ~/Library/Application\ Support/Google/Chrome/Default/Extensions/<id>/<version>/ \
  ./
```

For a complete check, `tools/verify-crx` is a single static Go binary with no dependencies of its own. It hashes every file, reports anything added, missing or altered, and exits non-zero on any mismatch:

```bash
cd tools/verify-crx && go build -o verify-crx .

# Compare an installed extension against this working tree
./verify-crx compare ~/Library/.../Extensions/<id>/<version>/ ../../

# Or compare a packaged zip against it
./verify-crx zip ../../dist/openfullpage-1.6.1.zip ../../
```

Step by step instructions, including where the extension directory lives on Windows and Linux: **[docs/VERIFYING-YOUR-INSTALL.md](docs/VERIFYING-YOUR-INSTALL.md)**.

What this proves and does not prove is written out honestly in that document. In short: it proves no code was added between this repository and the extension in your browser. It does not prove the source is safe, which is what reading it is for.

## Features

### Capture

- **A whole page of any length as a single image.** The page is measured, walked one screenful at a time, and stitched.
- **Sticky and fixed headers appear once**, at the top, instead of repeating down every screenful. This is the thing that makes naive full page capture unusable on GitHub, Amazon and most documentation sites.
- **Lazy loaded content** below the fold is loaded and given time to settle before its screenful is taken.
- **Retina displays and browser zoom** are handled by deriving the scale from the captured bitmap rather than assuming it.
- **Same origin iframes are expanded to their full height** before capture, so their content is not left behind their own scrollbar.
- **Rate limiting.** Chrome throttles `captureVisibleTab`; the extension backs off and retries rather than failing.
- **Scrollbars are cropped out** rather than stitched into the image.
- **The page is restored** afterwards, scroll position, sticky headers and frame heights, even if the capture fails partway.
- **Pages that never finish loading cannot hang it.** Every step that reaches into a page has a deadline, and the progress panel offers **Finish now**, which stops at the screenful it has reached and opens what it has.
- **Extra modes**, off by default: visible area only, or pick an element.

### Edit

The capture opens in a tab with a real editor. Shapes stay **live objects**: select one, drag it, drag its handles, restyle it, delete it.

| | |
|---|---|
| Tools | Select `V`, Text `T`, Numbered step `N`, Redact `P`, Crop `C`, and fourteen shapes behind one chevron: Arrow `A`, Line `L`, Box `R`, Rounded box `U`, Stadium `S`, Ellipse `O`, Callout `B`, Loupe `Z`, Highlighter `H`, Rhombus `D`, Hexagon `G`, Parallelogram `M`, Triangle `I`, Cylinder `Y`. **Every tool has a key and every tooltip names it.** Rounded box and Stadium draw a Box with its corner already set, so the corner control still reaches them |
| Editing | Finishing a shape selects it and returns to the selection tool, drag to move, eight handles to resize, `Backspace` to delete, `Esc` to cancel a drag or drop the selection. The shape under the pointer is outlined, and the cursor says whether a click would move it or resize it. Clicking picks up the shape you can see, not its bounding box: the empty corner of a rhombus is not part of the rhombus |
| Stroke | Five weights plus an exact pixel box, solid, dashed and dotted, arrowheads on either end, both ends or neither, and square, rounded or pill corners for the Box |
| Colour | Border and fill are separate controls. Ten quick colours, a sixty step grid, and any colour through the system picker or a hex field. Fill carries an opacity |
| Text | Multi-line. Family, size in points, bold, italic, underline, four alignments including justify, and its own colour, all stored on the shape, so text drawn ten minutes ago can be restyled. A **Frame** block gives a caption a frame around it and a plate behind it: a switch, a colour, a thickness and a plate switch. It writes the same properties Border colour and Fill write, so the two can never disagree, and the padding is derived from the type size so a framed label looks right at 12pt and at 96pt. Enter starts a new line; Escape or clicking away finishes. Double click a text shape to change its words, and drag a corner to scale the type |
| Crop | Dragging **proposes** a region. The surround dims, the region carries eight handles and can be slid whole, and a tick and cross confirm or abandon it. `Enter` and `Esc` do the same. The bar is fixed to the viewport, so it stays reachable on a capture ten screens tall |
| Several at once | Shift click to add, or sweep a marquee over empty canvas. A marquee catches everything it touches, not only what it swallows whole. Drag any member to move all of them, `Backspace` to delete all of them in one step, and restyling reaches every member the property applies to. `Cmd`/`Ctrl`+`A` selects everything |
| Paint order | **Right click a shape** for Bring to front, Bring forward, Send backward, Send to back and Delete. `[` and `]` move one step, `Cmd`/`Ctrl` with either goes all the way. A whole selection moves as a block and keeps its own order, in one undo step. Right clicking empty canvas leaves Chrome's own menu alone |
| Keyboard | Arrow keys nudge the selection a pixel at a time, ten with `Shift`, and holding a key is one undo step rather than one per repeat. `Alt` drag duplicates |
| History | `Cmd`/`Ctrl`+`Z`, add `Shift` to redo. Covers moves and resizes, not only drawing |
| Reset | Removes your edits when there are some, and restores the default tools and colours when there are none |
| Theme | System, light or dark, cycled from the toolbar. System is the default and follows the operating system. The capture is laid on a solarized mat rather than on white or black, so a white screenshot still has a visible edge |
| Output | `Cmd`/`Ctrl`+`C` to copy, or Download as PNG, JPEG, WebP or PDF with a filename you can edit. An encoder that cannot manage the image says so, rather than saving nothing |
| Upload | Copies the image and opens an image host so you can paste it there. The extension performs no upload and cannot |
| Constrain | Hold `Shift` for squares, circles and 45 degree lines, while drawing and while resizing |

**The toolbar is yours.** Related controls sit behind one button with a chevron: the button shows the current value, the chevron opens the whole set. Seventeen buttons carry what twenty six flat controls used to, and every one of them can be switched off individually on the settings page, as can each of the fourteen shapes. Hiding a button never disables its keyboard shortcut.

**Redact resamples the pixels underneath** rather than drawing a blur over them, and the export is flat, so a saved image has no original hiding under the redaction. **The loupe magnifies a redacted copy of the capture**, never the original, so magnifying a redacted region shows the redaction larger and never the pixels beneath it.

**The stitched capture is kept untouched** on its own canvas and every edit re-renders from it. Undo is therefore exact, repeated edits never degrade the image, and what the canvas shows is exactly what gets saved.

### Save

- **PNG** (lossless), **JPEG** (quality 0.92), or **PDF**.
- **PDF is written by hand** in [`src/lib/pdf.js`](src/lib/pdf.js), because a PDF library is a dependency and a build step. It is lossless: the samples go through `/FlateDecode` rather than as JPEG, since this tool photographs text and JPEG rings around every glyph. Long captures become several pages at the capture's own width, with no scaling and no margins.
- **Filenames** are built from the page URL and the date, and are editable before saving.
- **Straight to a file**, optionally: the capture is written to your downloads folder with no editor at all.

## Permissions

The install prompt asks for **no site access at all**.

| Permission | Granted | Why it exists |
|---|---|---|
| `activeTab` | at install | Read the page **only** on the tab you clicked the button on, and only after you click. Used deliberately instead of host permissions, so the extension has no standing access to any site |
| `scripting` | at install | Measure the page, load content below the fold, hold sticky and fixed elements still, put the page back afterwards |
| `storage` | at install | Your settings, on this computer. `chrome.storage.local` only |
| `downloads` | **optional**, on first save | Write the finished image to your downloads folder. Asked for at the moment you press Download, never at install. Decline it and everything else keeps working. Also asked for when you switch on saving straight to a file, because that mode has no later click to attach a prompt to |
| `webNavigation` + `<all_urls>` | **optional**, off | Only if you turn on cross origin frame capture in settings. Revocable at any time |

The last row is the only broad permission the extension can ever hold. Even fully granted, it still cannot send anything anywhere: `connect-src 'none'` is enforced by Chrome regardless of permissions. See [docs/ADVANCED-ACCESS.md](docs/ADVANCED-ACCESS.md) for exactly what it buys and what it costs.

## Installation

### From the Chrome Web Store

Not yet listed. This section will carry the link when it is.

### From source, unpacked

There is nothing to install and nothing to build.

```bash
git clone https://github.com/PalWorks/OpenFullPage---Screenshot-Annotate-Save.git
cd OpenFullPage---Screenshot-Annotate-Save
```

Then in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the repository directory
4. Pin OpenFullPage to the toolbar

**Prerequisites:** Chrome 116 or newer (`minimum_chrome_version` in the manifest) for the extension itself. Node 22 or newer only if you want to run the tests. Go only if you want to build the verifier.

### As a packaged zip

```bash
./tools/pack.sh
# dist/openfullpage-1.6.1.zip  (38 files, 102277 bytes)
```

Packaging is deterministic: no timestamps, no host details, no ordering by filesystem. The same tree always produces the same bytes and the same SHA-256, which is what makes the hashes in [CHANGELOG.md](CHANGELOG.md) reproducible rather than merely checkable.

## Usage

### Capturing

Click the toolbar button, or press `Alt`+`Shift`+`P`. It starts immediately. There is no popup and no second button to press.

Progress fills the toolbar icon as the walk proceeds, and an animated panel under the button shows how far along it is and offers **Finish now**. No tab is opened until the capture is done, so nothing is in your way while your page scrolls.

| Action | Shortcut | Availability |
|---|---|---|
| Capture using your default mode | `Alt`+`Shift`+`P` | always |
| Capture the visible area only | `Alt`+`Shift`+`V` | after turning on extra capture modes |
| Pick an element to capture | `Alt`+`Shift`+`E` | after turning on extra capture modes |

Shortcuts are remappable at `chrome://extensions/shortcuts`.

### What happens when you press the button

1. The page is measured, and content below the fold is loaded.
2. Sticky elements are returned to normal flow so they appear once. Fixed elements are kept in the first screenful and hidden after it.
3. Same origin frames are laid out at full height, so their content is captured rather than left behind their own scrollbar.
4. Each screenful is captured. The toolbar icon fills and the badge counts up.
5. The page is restored: scroll position, sticky headers, frame heights. **This happens before the result tab opens**, so you get your tab back the moment the capture stops.
6. The result tab opens and stitches the screenfuls into one image.
7. You annotate, crop and redact.
8. You press Copy, or choose a format and press Download. **That** is when the extension asks for permission to save.

Stitching in the result tab rather than a background document is what lets the extension do without the `offscreen` permission, and it is what makes the download permission request a real click you can judge.

### Editing, by example

```text
Draw a red arrow:        A, then drag on the image
Restyle it afterwards:   V, click the arrow, open Stroke style, pick a weight
Number the steps:        N, then click each point in order
Redact an email address: P, then drag over it
Crop:                    C, drag a region, adjust the handles, press Enter
Undo the crop:           Cmd/Ctrl + Z
Save as a PDF:           open the Download menu, choose PDF, press Enter
```

## Configuration

All settings live on the options page (right click the toolbar icon, or `chrome://extensions` then **Details**, then **Extension options**). There are **no environment variables and no configuration files**: an extension has neither, and a remotely fetched configuration would be remote code.

| Setting | Default | Notes |
|---|---|---|
| Default capture mode | full page | What a plain toolbar click does |
| Extra capture modes | off | Adds visible area and pick an element, with their shortcuts |
| Capture delay | 0 s | Wait before capturing, for menus and hover states |
| Progress panel | on | The animated popup under the toolbar button |
| Save straight to your downloads | off | Skips the editor entirely. Needs the `downloads` permission, requested when you switch it on |
| Download format | PNG | Remembered from the last save |
| Theme | system | System, light or dark |
| Toolbar controls | curated set | Each of the 17 buttons can be switched off individually, and so can each of the 12 shapes |
| Drawing style | red, 4px, arrow | Tool, colour, stroke, dash, arrowheads, fill, opacity, text family, size and weight are all remembered between captures |
| Advanced access | off | `webNavigation` and `<all_urls>`, for cross origin frames |

Settings are stored with `chrome.storage.local`, so they stay on the machine that made them. You can **export them to a file and import them back** from the options page, which is the deliberate replacement for `chrome.storage.sync`.

Everything read out of storage goes through `sanitise()` in [`src/lib/settings.js`](src/lib/settings.js), so a corrupt or hand edited value is repaired rather than carried into the editor.

## Architecture

Three processes, one message port, no shared state.

```
 ┌──────────────────────┐
 │  Chrome toolbar      │  click, or Alt+Shift+P
 └──────────┬───────────┘
            v
 ┌──────────────────────────────────────────────────────────┐
 │  src/background.js         MV3 service worker            │
 │                                                          │
 │  1. measurePage()          injected, returns metrics     │
 │  2. planCapture()          pure, returns a tile list     │
 │  3. markSpecialElements()  injected, tags sticky/fixed   │
 │  4. expandSameOriginFrames()                             │
 │  5. for each tile:  scrollAndSettle() -> captureVisibleTab
 │  6. restorePage()          injected, puts the page back  │
 │  7. open the result tab, stream the screenfuls, forget   │
 └──────────┬───────────────────────────────┬───────────────┘
            │ chrome.runtime.connect        │ chrome.action
            │ port "capture:<id>"           v
            │                     ┌─────────────────────────┐
            │                     │ src/ui/progress.html    │
            │                     │ live percentage,        │
            │                     │ Finish now              │
            │                     └─────────────────────────┘
            v
 ┌──────────────────────────────────────────────────────────┐
 │  src/ui/result.html        the result tab                │
 │                                                          │
 │  stitch screenfuls -> immutable base canvas              │
 │  src/ui/editor.js  -> render loop, pointer input         │
 │  src/lib/edit.js   -> shapes, selection, undo, history    │
 │  src/lib/geometry  -> one outline per shape, hit testing  │
 │  src/lib/pdf.js    -> export                             │
 └──────────────────────────────────────────────────────────┘
```

### Design constraints that shaped it

**The service worker holds every screenful until the walk ends.** The result tab is opened only once the capture is finished, so the user is not staring at an empty tab while their page scrolls. The cost is that a step which never settles destroys the whole capture, which is not hypothetical: `chrome.scripting.executeScript({ allFrames: true })` never resolves on a page with an advertising frame that never goes idle. So **every await that crosses into a page, a frame or a new tab is bounded**, and a step that times out after the walk has begun ends the walk and delivers what it has rather than losing it.

**The base capture is immutable.** Edits are objects re-rendered from a pristine canvas on every frame, never composited into it. That is what makes undo exact and repeated edits non degrading, and it is why there is no pixel eraser.

**Screen space and image space are different.** Selection chrome and crop handles are divided by the display scale so they stay the same size under the pointer at any zoom; shape geometry is not, so shapes stay where they were drawn.

**The progress indicator is browser chrome, never an in-page overlay.** The page is what gets photographed, so an in-page indicator would have to be hidden for every screenful and would strobe.

Full walkthrough with diagrams: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The vocabulary the code assumes (screenful, tile, capture scale, output scale, region) is defined in [docs/DOMAIN.md](docs/DOMAIN.md). Why any given choice was made: [docs/DECISIONS.md](docs/DECISIONS.md), 42 records and counting.

## Tech stack

| Layer | Choice | Why not the usual thing |
|---|---|---|
| Platform | Chrome Manifest V3, `minimum_chrome_version` 116 | |
| Language | ES modules, no transpiler | The shipped bytes have to equal the source bytes |
| Runtime dependencies | **none** | A dependency is a supply chain and a build step |
| Dev dependencies | **none** | No `package.json`, no lockfile, no `node_modules` |
| UI | Plain HTML and CSS, `system-ui` | A webfont is a network request |
| Icons | Inline SVG paths, and the extension mark generated from geometry | An icon set is a network request or a bundled binary |
| Rendering | Canvas 2D | Fabric.js, Konva and Cropper.js are each a build step |
| PDF | Hand written PDF 1.4, `CompressionStream('deflate')` for `/FlateDecode` | jsPDF is 419 KB and a build step |
| PNG for the icon pipeline | Hand written encoder in `tools/lib/png.mjs` | |
| Zip | Hand written deterministic writer in `tools/lib/zip.mjs` | System `zip` embeds timestamps, which breaks reproducibility |
| Tests | `node --test`, Node 22 | A test framework is still a dependency |
| Browser tests | Chrome DevTools Protocol over a raw WebSocket | Puppeteer and Playwright are dependencies |
| Verifier | Go, static binary, standard library only | A user checking their install should not have to install a toolchain first |
| CI | One GitHub Actions workflow, three jobs | |

## Module reference

The pure modules carry the logic worth testing and have no `chrome.*` calls, which is why they are unit tested in Node rather than in a browser.

### `src/lib/plan.js`, capture planning

```js
import { planCapture, LIMITS, MIN_OUTPUT_SCALE, captureFilename } from './src/lib/plan.js';

const plan = planCapture({
  fullWidth: 1280, fullHeight: 42000,
  viewportWidth: 1280, viewportHeight: 800,
  innerWidth: 1295, devicePixelRatio: 2,
});

// {
//   tiles: [{ x: 0, y: 0 }, { x: 0, y: 800 }, ...],
//   width: 1280, height: 42000,
//   originX: 0, originY: 0,
//   captureScale: 2,        // CSS px -> captured px, folds in browser zoom
//   outputScale: 0.195,     // shrunk to fit the canvas limit
//   truncated: false,
// }
```

`LIMITS` is Chrome's canvas ceiling (`maxSide` 16384, `maxArea` 128 MP) **in device pixels**, which is why a retina display reaches it at half the page length. `MIN_OUTPUT_SCALE` is 0.5: below roughly half of CSS pixel resolution body text stops being readable, so a smaller image would not be a worse copy of the page, it would be a useless one. Pages that still do not fit are truncated, and the result tab says so.

### `src/lib/edit.js`, the editing model

Shapes, selection, hit testing, history and geometry. Every function is pure, which is what makes undo across moves and resizes testable.

```js
import { createDocument, commit, undo, redo, shapeAt, resizeCrop } from './src/lib/edit.js';

let doc = createDocument(1280, 42000);          // { past, present, future }
doc = commit(doc, { ...doc.present, shapes: [...doc.present.shapes, arrow] });
doc = undo(doc);                                 // exact, because nothing was baked in
const hit = shapeAt(doc.present.shapes, { x: 40, y: 90 });
```

Crop geometry is separate and equally pure: `cropHandlesFor`, `cropHandleAt`, `resizeCrop` and `moveCrop`. Dragging an edge past its opposite clamps rather than flipping, because a flip loses the reader's rectangle by accident.

### `src/lib/pdf.js`, PDF writing

```js
import { planPdfPages, deflate, rgbaToRgb, buildPdf } from './src/lib/pdf.js';

planPdfPages(1280, 1700);
// [{ y: 0, h: 850 }, { y: 850, h: 850 }]
// The page count is decided first and the height divided evenly, so a 1700px
// image never produces a two pixel final page.

const bytes = buildPdf([{ width, height, data: await deflate(rgbaToRgb(imageData.data)) }]);
```

A PDF 1.4 file: catalogue, page tree, one Flate compressed `/DeviceRGB` image per page, a 20 byte per entry xref table. `PAGE_RATIO` is `Math.SQRT2`, the A series ratio, so a long capture splits into pages of a familiar shape at the capture's own width. There is deliberately **no `/CreationDate`**, because a timestamp in an exported file is metadata the reader did not ask to publish.

### `src/lib/settings.js`, preferences

```js
import { loadSettings, saveSettings, sanitise, DEFAULTS, STYLE_KEYS } from './src/lib/settings.js';

await saveSettings({ colour: '#ef4444', strokeWidth: 7 });
```

Writes are **serialised through a promise chain**, and that is not decoration. Saving is read modify write over the whole settings object, so two overlapping saves mean the second reads before the first has written and puts back the value the first had just changed. Dragging the fill opacity slider fires one save per step. There is a test that fails without the serialisation.

`STYLE_KEYS` names exactly what Reset restores, and a test asserts the output format, the toolbar configuration and the capture settings are not in it.

### `src/lib/theme.js`, the three theme states

`system` is a third state rather than a synonym for light: with it chosen the pages carry no `data-theme` attribute at all and the stylesheets fall through to `prefers-color-scheme`. `startTheme()` attaches its storage listener **before** the first read, because a change arriving during that read would otherwise be undone by it.

### The capture port protocol

The service worker talks to the result tab over one `chrome.runtime.connect` port named `capture:<id>`. The result tab opens the port; the worker answers on it and then forgets everything.

| Message | Direction | Payload |
|---|---|---|
| `plan` | worker to tab | Dimensions, origin, `outputScale`, `truncated`, `endedEarly`, page title and URL, capture mode, and the user's settings |
| `tile` | worker to tab | One screenful: `x`, `y` and a data URL |
| `finish` | worker to tab | No more screenfuls are coming |
| `progress` | worker to panel | `fraction`, a human readable step, and whether Finish now is available |
| `done` / `failed` | worker to panel | Terminal states, `failed` carries an explained reason |

The screenfuls are streamed **once**. Refreshing the result tab destroys the capture, which is why the tab warns before it happens.

## Project structure

```
manifest.json              38 shipped files, ~100 KB packaged
VERSION                    single source of truth, asserted against the manifest

src/
  background.js            capture orchestration: measure, prepare, walk, stream, restore
  lib/
    plan.js                tile arithmetic, canvas limits, scale, filenames. Pure
    edit.js                shapes, selection, history, crop maths. Pure
    geometry.js            one description per shape, read by the canvas and the hit tester. Pure
    pdf.js                 PDF 1.4 writing and page planning. Pure
    settings.js            defaults, sanitising, serialised writes, optional permissions
    theme.js               the three theme states and how they are stamped
    badge.js               toolbar icon progress
  content/
    measure.js             page metrics, injected
    prepare.js             sticky and fixed handling, scrolling, lazy loading, frames
    pick.js                the element picker
  ui/
    result.html/.js        the result tab: stitching, toolbar, format menu, export
    editor.js              canvas rendering and pointer input
    options.html/.js       settings, the index, the optional permission toggle
    progress.html/.js      the capture progress panel

icons/                     generated by tools/make-icons.mjs, including 8 progress frames

test/
  invariants.test.js       the security invariants. The heart of the project
  plan.test.js             tile arithmetic
  edit.test.js             editing model and crop geometry
  settings.test.js         sanitising, Reset's scope, write serialisation
  pdf.test.js              page planning, deflate round trip, xref offsets
  icons.test.js            committed PNGs match the design source, pixel for pixel
  lib/scan.js              the banned pattern scanner and manifest checks
  fixtures/violation.js    deliberately poisoned, proves the scanner fires
  e2e/                     real Chrome over CDP, with fixtures

tools/
  pack.mjs / pack.sh       deterministic zip packaging
  check.sh                 everything CI runs, in one command
  icon-design.mjs          the extension mark, described as geometry
  make-icons.mjs           renders it, and --check asserts the committed PNGs match
  lib/png.mjs, lib/zip.mjs hand written encoders
  verify-crx/              Go binary users run to check their own install

docs/                      architecture, decisions, domain, limitations, testing, playbook
store/                     Chrome Web Store copy and assets, ready to submit
```

The icons are **generated, not pasted in**. [`tools/icon-design.mjs`](tools/icon-design.mjs) describes the mark as unit coordinates and CI asserts the committed PNGs match it pixel for pixel, so the one part of the extension a reviewer cannot read is still verifiable.

## Testing

Two layers, no framework.

```bash
./tools/check.sh                 # everything CI runs: pack, unit tests, icons, verifier
node --test 'test/**/*.test.js'  # 174 unit tests, including the security invariants
node tools/make-icons.mjs --check
node test/e2e/run.mjs            # real Chrome, drives a capture over CDP
```

Unit tests cover the pure modules. Anything touching the DOM or a `chrome.*` API is covered end to end instead, because a mock of `chrome.scripting` proves only that the mock behaves.

### End to end

```bash
node test/e2e/run.mjs             # local fixture only, no network
node test/e2e/run.mjs --edit      # drive the editor with real mouse events
node test/e2e/run.mjs --sites     # also GitHub, Amazon and MDN
node test/e2e/run.mjs --iframes   # same origin and cross origin frames
node test/e2e/run.mjs --stop      # press Finish now mid capture
node test/e2e/run.mjs --direct    # save straight to a file, no editor
node test/e2e/run.mjs --progress  # watch the progress panel through a capture
node test/e2e/run.mjs --deep      # with advanced access granted
node test/e2e/run.mjs --headed    # watch it happen
node test/e2e/run.mjs --headed --popup   # prove Chrome opens the toolbar popup
```

The harness launches real Chrome, installs the extension over `Extensions.loadUnpacked`, captures pages, drives the result tab with real mouse events, and inspects what was saved. The Download button is clicked with `Runtime.evaluate({ userGesture: true })` so `chrome.permissions.request` sees a genuine gesture. Saved PDFs are parsed back and their page and image counts checked against what `planPdfPages` says they should be.

`--edit` also runs a **rendered page audit**: it reads what the browser actually computed, in both themes, rather than what the stylesheet meant. Contrast, overflow, focus visibility and control sizing are checked against the live layout.

More: [docs/TESTING.md](docs/TESTING.md).

### CI

One workflow, [`.github/workflows/ci.yml`](.github/workflows/ci.yml), three jobs, on every push and pull request:

| Job | Asserts |
|---|---|
| Invariants and unit tests | The five rules hold, and the packed zip is byte identical to the tree |
| End to end capture | A real capture completes in real Chrome, on the deterministic local fixture |
| verify-crx | The Go verifier is formatted, vets clean, builds, and agrees the zip matches the source |

Workflows are kept deliberately minimal. There is no linting, formatting, dependency or coverage job, because none of those enforce anything that cannot be checked locally, and the one workflow that exists earns its place by turning the five rules into tests.

## Deployment

There is no server, no container and no deploy pipeline. Deployment is a zip and a store submission.

```bash
# 1. VERSION, manifest.json and CHANGELOG.md must agree
node --test 'test/**/*.test.js'
node test/e2e/run.mjs --edit
node test/e2e/run.mjs --sites

# 2. Build the artefact. Deterministic: same tree, same bytes, same hash
./tools/pack.sh

# 3. Record the hash in CHANGELOG.md, then sign the release tag
shasum -a 256 dist/openfullpage-$(cat VERSION).zip
git tag -s v$(cat VERSION)
```

Upload `dist/openfullpage-<version>.zip` to the Developer Dashboard rather than a hand made archive, so the published bytes are the ones the hash covers.

The full checklist, including rolling back and re-dating the canary, is in [docs/PLAYBOOK.md](docs/PLAYBOOK.md). The listing copy and assets are in [store/LISTING.md](store/LISTING.md).

## Known limitations

Honesty runs both ways, and the complete list with severity and status is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

- **Chrome forbids capture on its own pages** (`chrome://`, the Web Store, the PDF viewer, other extensions' pages). Nothing can change that. The extension says so plainly rather than failing silently.
- **Very long pages are scaled down** to fit Chrome's 16384 pixel canvas limit rather than being cut off, and the result tab says what scale was used. That limit is in *device* pixels, so a retina display reaches it at half the page length. Past roughly half of CSS pixel resolution there is nothing left to give and the capture is truncated. You are told when that happens too.
- **Cross origin frames contribute only their visible box.** Same origin frames are expanded to full height and captured entirely, but a cross origin frame's height cannot be read from the page holding it. Closing that gap needs `webNavigation` and `<all_urls>`, which is offered as an opt in rather than taken by default.
- **Pages that scroll inside an inner container** rather than the window are not yet supported.
- **The editor requires a pointer.** Tools can be selected by keyboard and then used for nothing. This is a real accessibility gap, tracked as L14, and arrow key nudging is the cheapest first step because the geometry it needs is already written and tested.
- **Refreshing the result tab destroys the capture.** The screenfuls are streamed once and forgotten. The tab warns you first.

## Roadmap

[docs/ROADMAP.md](docs/ROADMAP.md) is the north star: five phases, every planned change, with the reasoning. [TASKS.md](TASKS.md) holds acceptance criteria for what is being built now, and [TODOS.md](TODOS.md) holds what was deliberately deferred and why.

| Phase | Theme |
|---|---|
| **Phase 1** *(in progress)* | Trustworthy and complete. Remove the silent failures, finish the core, make the toolbar configurable |
| Phase 2 | Capture and share. More ways in (snip a region on the live page, repeat the last capture) and out |
| Phase 3 | Output worth sending. Presentation treatment, multi part export for very long pages |
| Phase 4 | Reach. Locales, and the accessibility gap above |
| Phase 5 | Scale. Whatever survives contact with real users |

Every item is measured against one rule: **`test/invariants.test.js` must still pass when the feature ships.** If a feature cannot be built inside that boundary, it does not get built. The boundary is the product.

Things that will never be built, with reasons, are listed in the roadmap too: direct API upload (Chrome's extension CSP is static in the manifest, so shipping it would weaken `connect-src` permanently for every user including everyone who never uploads), cloud accounts, OCR that needs a WebAssembly blob and `wasm-unsafe-eval`, runtime downloaded plugins, telemetry of any kind, and `update_url`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, then [AGENTS.md](AGENTS.md), which is the contract: what may never be added, and the definition of done.

The short version:

1. **The five rules are not negotiable.** If a change seems to require breaking one, the change is wrong, not the rule. Say so in the issue.
2. **No dependencies.** Not in `src/`, not in `tools/`, not in tests.
3. **New behaviour needs a test**, and every new failure path needs a user visible message.
4. **New settings touch both `DEFAULTS` and `sanitise()`**, or they will be silently dropped on the way out of storage.
5. **Docs move in the same commit as the code**, which is why they are still accurate.
6. **Writing style:** no em dashes, no en dashes, no double hyphen as punctuation, no horizontal rules made of hyphens. Prose, comments, commit messages and UI strings alike.

Changing an invariant and the code it guards in the same commit is the thing reviewers watch for.

**Security issues:** please email rather than opening a public issue. See [SECURITY.md](SECURITY.md).

### Documentation map

| File | What it holds |
|---|---|
| [AGENTS.md](AGENTS.md) | The contract: what may never be added, and the definition of done |
| [CLAUDE.md](CLAUDE.md) | Entry point for coding agents |
| [docs/CONTEXT_MAP.md](docs/CONTEXT_MAP.md) | Which file to read for what |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The capture pipeline end to end, with diagrams |
| [docs/DOMAIN.md](docs/DOMAIN.md) | The vocabulary the code assumes |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why it is built this way, 42 records |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known gaps and deliberate trades |
| [docs/TESTING.md](docs/TESTING.md) | Both test layers, and what each one is for |
| [docs/PLAYBOOK.md](docs/PLAYBOOK.md) | Commands, releasing, rolling back, debugging |
| [docs/PRIVACY.md](docs/PRIVACY.md) | The privacy policy, as source of truth |
| [docs/ADVANCED-ACCESS.md](docs/ADVANCED-ACCESS.md) | What the optional broad permission buys and costs |
| [docs/VERIFYING-YOUR-INSTALL.md](docs/VERIFYING-YOUR-INSTALL.md) | How a user checks their own install |
| [docs/MEMORY.md](docs/MEMORY.md) | Standing context the code does not record |
| [docs/ROADMAP.md](docs/ROADMAP.md) | The north star: every planned change, in phases |
| [TASKS.md](TASKS.md) · [TODOS.md](TODOS.md) | The work queue, and what was deferred |
| [store/LISTING.md](store/LISTING.md) | Chrome Web Store copy and assets |

The website is a separate repository, [PalWorks/openfullpage-site](https://github.com/PalWorks/openfullpage-site).

## Governance

Read **[GOVERNANCE.md](GOVERNANCE.md)**. It contains a **non transfer covenant** and a dated canary.

The covenant: this extension's Web Store listing and publisher account will not be sold or transferred. If the maintainer can no longer maintain it, it is unpublished and the repository archived, never passed on. The repository is never deleted, only archived, because a deleted repository at handover is the loudest available warning signal and it has been missed before.

The canary is re-signed at every release. **If it is missing, stale by more than one release, or removed, treat this extension as compromised and uninstall it.**

## Licence

**GPL-3.0-only.** See [LICENSE](LICENSE).

Copyleft rather than permissive, deliberately: a hostile fork must publish its source. That is the only licence choice consistent with a product whose entire claim is that you can read it.

## Acknowledgements

- **Peter Coles**, for [full-page-screen-capture-chrome-extension](https://github.com/mrcoles/full-page-screen-capture-chrome-extension), the MIT licensed work this is a Manifest V3 port and hardening of. Full attribution and the original licence text are in [NOTICE.md](NOTICE.md).
- **SVG Repo**, for the settings gear, redrawn from their CC0 Editable-line collection. Credited in [NOTICE.md](NOTICE.md) although CC0 requires no attribution, with the original file kept in `public/` as provenance.
- Everything else in the interface, including the extension mark, is drawn from geometry in this repository.

This project is **not affiliated with, endorsed by, or derived from** any commercial successor to the work above. The only code inherited here is the MIT licensed work named in NOTICE.md, and CI fails the build if the extension name ever reuses another product's mark.
