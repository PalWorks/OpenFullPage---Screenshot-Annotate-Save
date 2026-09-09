# Architecture

Read [DOMAIN.md](DOMAIN.md) first for the vocabulary.

## Shape of the system

Three processes, no server, no dependencies, no build step.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │ SERVICE WORKER   src/background.js                                  │
  │                                                                     │
  │   chrome.action.onClicked ──▶ start() ──▶ runCapture()              │
  │                                                                     │
  │   uses: lib/plan.js      tile arithmetic, scales, filenames (pure)  │
  │         lib/settings.js  defaults, sanitising, optional permissions │
  │         lib/badge.js     progress drawn onto the toolbar icon       │
  └───────┬──────────────────────────────────────────┬──────────────────┘
          │ chrome.scripting.executeScript           │ chrome.runtime port
          ▼                                          ▼
  ┌───────────────────────────┐          ┌──────────────────────────────┐
  │ THE PAGE  src/content/    │          │ RESULT TAB  src/ui/          │
  │                           │          │                              │
  │  measure.js  metrics      │          │  result.js  stitch, filename,│
  │  prepare.js  unstick,     │          │             format, export   │
  │              scroll,      │          │  editor.js  canvas + pointer │
  │              settle,      │          │  lib/edit.js  the model,pure │
  │              frames       │          │                              │
  │  pick.js     element pick │          │  options.js  settings page   │
  │                           │          │  progress.js toolbar popup   │
  └───────────────────────────┘          └──────────────────────────────┘
```

Nothing else exists. There is no offscreen document (stitching happens in the result
tab, which is why the `offscreen` permission is not needed), no popup on the toolbar
button (clicking it captures immediately), and no page can reach the extension
(no `web_accessible_resources`, no `externally_connectable`).

## The capture pipeline, end to end

```
  1  click / shortcut
        │
  2  measurePage()                    metrics: viewport, document, dpr, title, url
        │
  3  mode == element ? pickElement()  the user points at something first
        │
  4  markSpecialElements()            tag fixed and sticky elements
     insertCSS(PREPARE_CSS)           unstick, pause animations, kill the caret
     expandSameOriginFrames()         lay same origin frames out at full height
     [optional] reportFrameHeights()  cross origin frames, only if opted in
        │
  5  waitForStableHeight()            preparation moved the page; let it settle
     measurePage() again              ONLY now is the page the shape we photograph
        │
  6  planCapture(metrics, region)     tiles, width, height, origin, scales
        │
  7  for each tile:                   ONE pass down the page
        stop requested? end the walk  Finish now, checked at the start of a row
        scrollAndSettle()             scroll, wait for images in shot, report height
        captureVisibleTab()           with backoff on Chrome's rate limit
        after tile 0: insertCSS(HIDE_FIXED_CSS)
        if the page grew: re-plan
        timed out with shots in hand? end the walk
        │
  7b if the walk ended early: trim the planned canvas to the last screenful
        │
  8  restore()                        undo CSS, untag, put the scroll position back
        │                             bounded: tidying never holds the capture up
  9  openResultTab() ──▶ port         background tab when saving straight to a file
        post {type:'plan'}  {type:'tile'} x N  {type:'finish'}
        │
 10  result tab: decode, crop the scrollbar gutter, draw each tile onto `base`
 11  createEditor(base) ──▶ the user annotates ──▶ export
     or, if directDownload: save the file and close this tab
```

**Every step from 2 to 9 has a deadline.** `chrome.scripting.executeScript` and
`chrome.tabs.create` reject when they fail and simply never settle when whatever
they are waiting on has gone quiet. Because the screenfuls are held in the worker
until step 9, one step that never settles destroys all of them: the icon reads
100%, the panel names the last screen, and nothing opens. A step that times out
after the walk has begun therefore ends the walk and delivers what was captured.
See [DECISIONS.md](DECISIONS.md) D27.

**Why the result tab opens at step 9 and not step 1.** The user is not left staring
at an empty tab while their page scrolls. The cost is that the screenfuls are held
in the worker until then, which is the memory ceiling recorded in
[LIMITATIONS.md](LIMITATIONS.md).

**Why the page is measured twice.** Preparation changes the document height.
Measuring before it settles plans the walk against a layout that no longer exists,
and the first screenfuls then disagree with the last.

**Why one pass and not two.** The obvious alternative, racing down the page to
trigger lazy images and then coming back to photograph, scrolls the user's page
twice and still loses a race against anything slower than the warm up budget.
Waiting per tile costs nothing on pages with no lazy content.

## Data flow: a screenful becoming pixels

```
  dataUrl (base64 PNG)
      │  dataUrlToBlob()      hand decoded: the conventional route sends a data:
      │                       URL back through the network APIs, which are banned
      ▼
  Blob ──▶ createImageBitmap() ──▶ ImageBitmap
      │
      │  first tile only: sizeCanvas()
      │    captureScale = bitmap.width / plan.innerWidth   measured, not assumed
      │    outputScale  = min(plan.outputScale, captureScale)
      │    base.width   = plan.width  * outputScale
      │
      ▼  drawTile()
  crop off the scrollbar gutter (viewportWidth x viewportHeight in captured px)
  place at (x - originX, y - originY) * outputScale
  round BOTH edges, not the origin and size independently, so tiles abut exactly
      │
      ▼
  base canvas  (never drawn into again)
      │
      ▼  editor renders base + shapes on every frame
  visible canvas ──▶ flatten() ──▶ toBlob ──▶ download or clipboard
```

**The scale is measured, not trusted.** Only the first screenful reveals the true
captured pixel scale. If the user zoomed between the measurement and the capture,
the plan's scale is stale and the canvas would be the wrong size, so
`sizeCanvas()` derives it from the bitmap that actually arrived.

## The port protocol

The service worker and the result tab talk over a named `chrome.runtime` port
(`capture:<id>`). Messages:

| Message | Carries |
|---|---|
| `plan` | dimensions, origin, scales, mode, total, truncated, `endedEarly`, title, url, settings |
| `tile` | `dataUrl`, and the document coordinates the page actually landed at |
| `finish` | nothing. It means every tile has been sent |
| `error` | a message already passed through `explain()` |

`endedEarly` is `'stopped'` when the user pressed Finish now, `'stalled'` when a
step timed out partway down, and `null` otherwise. It only changes what the result
tab says: the height it was sent has already been trimmed to what was reached.

The result tab chains the work in a promise queue, because screenfuls arrive faster
than they decode and `finish` must land after the last draw.

Two messages go the other way, on `chrome.runtime.sendMessage` rather than the
port, and only from a result tab that saved itself straight to a file: `closeTab`
and `showTab`. Both act on `sender.tab.id`, which Chrome fills in, never on an id
in the message.

There is no version field on this protocol yet. Adding one is task T11 in
[../TASKS.md](../TASKS.md).

## Cropping, and why it is not a shape

A crop has no colour, is never in the shapes list, and exactly one can exist at a
time, so it has its own small set of pure functions in `src/lib/edit.js`
(`cropHandlesFor`, `resizeCrop`, `moveCrop`) rather than being bent into the shape
model.

```
  drag with the crop tool
        │
  pointerup ──▶ pendingCrop   a proposal, held outside the document
        │                      so cancelling costs no undo step
        ├─ render: dim the four bands around it, thirds, eight handles
        ├─ drag a handle ──▶ resizeCrop, clamped inside the current crop
        ├─ drag inside   ──▶ moveCrop, measured from where the drag began
        ├─ drag outside  ──▶ a new region replaces it
        │
  the confirm bar (a real element, fixed to the viewport)
        ├─ tick or Enter  ──▶ commit(crop), hand back to the selection tool
        └─ cross or Esc   ──▶ drop it, nothing committed
```

`flatten()` sets `hideChrome` while it renders for export, so neither the dimming
nor the handles can be baked into a saved file. See [DECISIONS.md](DECISIONS.md)
D30.

## Exporting

| Format | How |
|---|---|
| PNG | `canvas.toBlob('image/png')` |
| JPEG | `canvas.toBlob('image/jpeg', 0.92)` |
| PDF | `src/lib/pdf.js`, written by hand |

The PDF path cuts the canvas into page-shaped slices, reads each one back as
`ImageData`, drops the alpha channel, deflates it with `CompressionStream` and
assembles the file. Slicing before encoding is what keeps it affordable: the
uncompressed samples for a whole 1265 x 16384 capture are 62 MB, and for one page
of it about six. D31.

## The editor

```
  lib/edit.js  (pure, no DOM, no canvas)          ui/editor.js (canvas + pointer)
  ───────────────────────────────────────         ────────────────────────────────
  createDocument, commit, amend, undo, redo   ◀── pointerdown / move / up
  effectiveCrop, isEdited                          drag modes: draw, move, resize
  normalizeRect, clampRect, constrain              render(): base, shapes, preview,
  arrowGeometry, boundsOf, hits, shapeAt                     selection
  handlesFor, handleAt, moveShape, resizeShape     text entry: an <input> over the
  replaceShape, removeShape, nextCounterNumber                canvas
```

The split is the point: everything easy to get subtly wrong is pure and unit tested
in `test/edit.test.js`, and the file that touches the DOM holds no geometry.

**Shapes are live objects.** Draw one and it is selected, movable, resizable and
restylable. Finishing a shape hands the user back to the Select tool, the way
drawing tools generally do, because the next click is almost always aimed at
the thing just drawn. Numbered steps are the deliberate exception.

### Style lives on the shape, and every key is optional

`colour` and `width` were always there. `dash`, `ends`, `fill`, `fillOpacity` and
the text keys `family`, `bold`, `italic`, `underline` are additions, and every one
of them has a reader in `src/lib/edit.js` that supplies a default:

```
  dashOf(shape)      'solid' unless told otherwise
  endsOf(shape)      derived from kind: an arrow has a head, a line does not
  fillOf(shape)      null, meaning an outline with nothing behind it
  fillAlphaOf(shape) 0.35
  fontOf(shape)      600 weight, system stack, the shape's own size
```

That is why no shape was ever migrated. A document saved before any of this
renders exactly as it did, because absence is a value with a meaning rather than a
missing field. Arrow and line are now one shape drawn two ways, and the tool you
picked only sets the default ending.

### Selection chrome is drawn in screen space

Everything the editor draws *about* a shape rather than as part of it, the dashed
outline and the resize handles, is divided by the current display factor before it
is drawn:

```
  screenScale() = canvas.width / canvas.getBoundingClientRect().width
```

A 4px stroke must stay 4px in the exported PNG at any zoom. A 9px handle must stay
9px under the pointer at any zoom. Those are opposite requirements and the code
used to have only one of them, so on a 14,000 pixel capture fitted to the window
the handles rendered at one pixel. One helper now feeds both the drawing and the
hit test. See [DECISIONS.md](DECISIONS.md) D19.

### The toolbar is groups of controls, not a row of them

`src/ui/result.html` holds the markup and `src/ui/result.js` the behaviour. A group
is a `.grp` containing a trigger with `data-pop` and a `.pop` panel:

```
  <span class="grp" data-button="border">
    <button data-pop="pop-border"> glyph + chevron </button>
    <div class="pop paint" id="pop-border" hidden> ... </div>
  </span>
```

Three rules, all borrowed from Preview's markup toolbar:

- **The glyph is the state.** The Border button is a square stroked in the current
  colour; the Fill button is filled, and slashed in red when there is no fill.
  `showStyle()` pushes the editor's current style back onto every glyph on each
  change, so the toolbar reads as state rather than as a list of possibilities.
- **Shapes and Text are split buttons.** The glyph half selects the tool, the
  chevron half opens the set. As one button, picking Text also opened the type
  inspector over the part of the canvas you were about to click on.
- **Popovers are clamped to the window on open**, against `clientWidth` rather than
  `innerWidth` so they do not sit under the scrollbar. Doing it in JavaScript rather
  than hand-placing the ones near the right edge keeps working as buttons are added,
  reordered, or switched off on the options page.

Which controls appear is `hiddenButtons` in settings, validated against
`TOOLBAR_GROUPS` in `src/lib/settings.js`. That is the only list; the options page
renders from it and `sanitise()` validates against the flat form derived from it.

## Security architecture

| Property | Mechanism |
|---|---|
| Cannot send anything anywhere | `connect-src 'none'` in the manifest CSP, enforced by Chrome |
| Cannot read sites you do not capture | `activeTab` only. Broad access is optional and off |
| Cannot run remote code | No `eval`, no `update_url`, no remote config, CSP `script-src 'self'` |
| Cannot be reached by a page | No `web_accessible_resources`, no `externally_connectable` |
| Cannot silently change | No build step, so the published zip is diffable against this tree |

The last one is the load bearing property. Everything else is checkable only because
of it. `tools/verify-crx` is a static Go binary that hashes every file in an
installed extension and compares it to this repository.

## Zero dependencies

There is no `package.json`. Node's built in test runner runs the suite, the zip
writer in `tools/lib/zip.mjs` and the PNG writer in `tools/lib/png.mjs` are written
by hand for exactly this reason, and CI has no install step. This is a cost paid
deliberately, and [DECISIONS.md](DECISIONS.md) records why.
