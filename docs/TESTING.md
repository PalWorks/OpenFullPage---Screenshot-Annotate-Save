# Testing

Two layers. The fast one runs on every commit; the slow one drives a real browser.

## Invariants and unit tests

```bash
./tools/pack.sh
node --test 'test/**/*.test.js'
```

Zero dependencies, no `npm install`, because there is nothing to install.

| File | What it holds the line on |
|---|---|
| `test/invariants.test.js` | No network, remote-code or privileged-API patterns in shipped code; manifest stays minimal; the packaged zip is byte-identical to the source tree |
| `test/plan.test.js` | Tile arithmetic: coverage, retina scaling, canvas limits, scale to fit, filename sanitising |
| `test/settings.test.js` | Sanitising everything read back out of storage |
| `test/edit.test.js` | Editing model: selection, hit testing, move and resize maths, crop geometry, undo across all of them |
| `test/pdf.test.js` | Page planning, the deflate round trip, and the xref offsets a reader has to seek by |
| `test/icons.test.js` | The committed PNGs are exactly what `tools/icon-design.mjs` draws |

`test/fixtures/violation.js` is deliberately poisoned, and the suite asserts every
banned pattern fires on it. A checker that cannot fail is worse than none, so the
gate is tested before the thing it gates.

## End-to-end capture

```bash
node test/e2e/run.mjs            # local fixture only, no network
node test/e2e/run.mjs --sites    # also GitHub, Amazon and MDN
node test/e2e/run.mjs --iframes  # a page with same- and cross-origin frames
node test/e2e/run.mjs --edit     # drive the editor with real mouse events
node test/e2e/run.mjs --progress # watch the progress panel through a capture
node test/e2e/run.mjs --stop     # press Finish now mid capture, on a tall fixture
node test/e2e/run.mjs --direct   # save straight to a file, with no editor
node test/e2e/run.mjs --deep     # with advanced access granted
node test/e2e/run.mjs --headed   # watch it happen
node test/e2e/run.mjs --headed --popup  # prove Chrome opens the toolbar popup
node test/e2e/run.mjs --stale   # a worker newer than the tab it is talking to
node test/e2e/run.mjs --frozen  # Chrome hands back a frame it already presented
node test/e2e/run.mjs --nudge   # the fifth capture asks for a rating, once

FPC_URLS=https://example.com/a,https://example.com/b node test/e2e/run.mjs
```

`FPC_SHOT_DIR=/some/dir` also screenshots the result tab, which is the quickest way
to review its UI. It photographs the download menu open as well as the toolbar at
rest, and **puts the menu back afterwards**: every pass that opens something owes
the passes after it the state it was handed.

Launches real Chrome, installs the extension over CDP (`Extensions.loadUnpacked`,
because Chrome 137 and later ignore `--load-extension`), captures pages, drives the
result tab, and inspects what was saved.

The Download button is clicked with `Runtime.evaluate({ userGesture: true })`, so
`chrome.permissions.request` sees a real gesture. PNG, JPEG, WebP and PDF are all
exercised, and the saved PDF is parsed back: its page count and image count have to
match what `planPdfPages` says the crop should produce.

`--edit` runs the rendered-page audit twice on each page, once per theme. Until the
theme button existed the dark palette could only be reached through
`prefers-color-scheme`, which this harness never sets, so half the colours in the
stylesheets had never been looked at by anything.

The harness subscribes to `Runtime.exceptionThrown` and `Runtime.consoleAPICalled`
for the worker, the driver page and the result tab, and labels each by name. An
extension that throws now prints a stack trace instead of hanging until a timeout.

`test/e2e/fixture/index.html` is built so that failures are visible rather than
subtle: a sticky header, a fixed cookie bar, forty numbered 100px bands, and a block
that only renders once an IntersectionObserver has seen it. `test/e2e/verify.mjs`
decodes the PNG and asserts:

- the sticky header appears **exactly once**, at the top
- the fixed bar appears **exactly once**, in the first tile
- the lazy block **loaded**: proving each stop waits for what it revealed
- all forty bands are present, correct and in order: a duplicated or dropped tile
  breaks the alternation and is caught

Set `FPC_THUMB_DIR=/some/dir` to also write downscaled thumbnails of each capture,
which is the quickest way to eyeball a very tall image.

### The iframe fixture

`--iframes` captures a page holding a same-origin frame and a genuinely
cross-origin one (served from a second port, still with no network). It settles a
question that is easy to get wrong:

- **Frame content is captured.** `captureVisibleTab` photographs what is painted,
  so cross-origin frames appear exactly as the user sees them.
- **A frame's own scrolling is not followed.** A 400px frame holding 3000px of
  content contributes 400px.

Following inner scrolling would need `webNavigation` plus `<all_urls>`. See
[ROADMAP.md](ROADMAP.md) for why that trade is refused.

### The editor

`--progress` opens the progress panel while a capture is running and checks that
it joins mid capture, is told where things stand rather than starting from zero,
names the page, and finishes at 100%. The panel normally lives in the toolbar
popup, which headless Chrome will not open; the page and its port are identical
either way, so it is opened as an ordinary tab. It has to be opened in the
driver's own window: anywhere else it becomes the active tab of the window being
captured, and `captureVisibleTab` then photographs the panel instead of the page.

`--popup` is the half `--progress` cannot reach: whether the panel is ever put in
front of the user at all. That is `chrome.action.openPopup()`, it is browser chrome
rather than a page, and headless Chrome will not open it, so this mode requires
`--headed` and refuses to run without it. It fails if no popup appears within
twenty seconds of the capture starting, and fails again if a popup opens but is
never told anything, because a panel that shows nothing is the same to the user as
no panel. Without it the whole feature could stop working with every other check
still passing: the popup opening was a promise, and now it is a test.

Note that `--headed` on a Retina display captures at `devicePixelRatio` 2, so the
fixture verifier's pixel expectations do not hold in headed mode. Read the named
checks, not the band comparisons.

`FPC_URLS` points the harness at pages of your choosing, comma separated. The
pages worth testing against are long, lazy and newsworthy, which is also to say
short lived, so they are not hard coded.

`--edit` drives the editor with real `Input.dispatchMouseEvent` drags and checks
**canvas pixels**, not the model, a drawing bug cannot pass by keeping the model
tidy. It draws an arrow, clicks to select it, drags it somewhere else, restyles it
and asserts the colour actually changed on the existing shape, undoes both, deletes
it and asserts the pixels underneath come back exactly, draws a box, redacts over
detailed pixels and asserts they changed, crops, undoes the crop, then downloads and
asserts the saved file matches the edited canvas.

It also drives the paint order menu with a **real right click**
(`Input.dispatchMouseEvent` with `button: 'right'`) and the paint order keys with
**real key events** (`Input.dispatchKeyEvent`), rather than dispatching event
objects. A dispatched `contextmenu` would prove the handler runs and nothing about
whether Chrome reaches it, and a dispatched `KeyboardEvent` cannot show that a
bracket arrives as `]`.

The shape sweep and the two shape counts are driven by `SHAPE_TOOLS` imported from
the model rather than by lists typed into this file. That list used to be twelve
names written out by hand, and it was wrong within one release: two shapes were
added to the popover and the sweep went on testing the old twelve without a word.

Failures worth remembering, all found this way:

- A `setIcon` call per screenful made Chrome's icon reads overlap and cancel. Only
  actual frame changes are sent now.
- The redaction check first sampled the fixture's solid-colour header, where
  pixelation is a no-op by definition. Sample where there is detail, or the test
  passes on a broken build.
- The frame block checks first read the inspector after `settle()`, which presses
  Escape and therefore drops the selection. The inspector shows the *pending* style
  the moment nothing is selected, so every check was reading defaults and reporting
  that a working control did nothing. Pick the shape up again before each switch.
- **`render()` ends by notifying, so `onChange` is not a signal that the picture
  changed.** Selection, hover, the crop bar and every export repaint fire it, and
  `flatten()` fires it twice on its own. The download menu's file sizes invalidated
  themselves on it and measured nothing at all, ever, with no error anywhere. Invalidate
  on a description of the image, not on a count of repaints.
- **A check that cleans up with a fixed number of undos is a check that reaches into
  its neighbours.** The frame block added an undo step per switch, the count typed
  after it went stale, and one undo too many removed a shape belonging to an earlier
  check. The failure surfaced three hundred lines away, in the loupe redaction test,
  as a redaction that suddenly had less to change. Undo until the canvas is clean
  and assert that it is, rather than counting.
- **A helper that toggles a control depends on state it did not set.** The
  `FPC_SHOT_DIR` pass photographs the download menu open and used to leave it open.
  `#download` is a toggle, so `exerciseFileSizes` closed the menu it meant to open,
  and every check after that drove a menu nobody could see: the sizes it read were
  the ones the screenshot's own click had produced, the slider check failed, and the
  wait for a lower quality never ended, because a hidden menu does not re-measure.
  Shots runs died there after ninety seconds, with no hint that the cause was fifteen
  hundred lines away. Read the state and open it, rather than flipping whatever you
  were handed, and **say when it was already open**: the leak is the defect, and a
  silent repair would have hidden it. D64.

### What the harness widens, and why

The extension is copied to a temp directory and two permissions are relaxed, because
a driven browser cannot produce the user gestures they depend on:

- `downloads` moves from optional to required, `chrome.permissions.request` needs a
  click.
- `host_permissions: ["<all_urls>"]` is added, `activeTab` is granted per toolbar
  click on a specific tab, and that click cannot be simulated.

Everything else is untouched and the capture path is identical. **This therefore does
not prove that `activeTab` alone is sufficient in normal use.** That is checked by
hand, below, and it is the one thing worth re-checking before any release.

## Manual checks before a release

1. Load unpacked from `chrome://extensions` with Developer mode on.
2. Confirm the install prompt asks for **no site access**.
3. Capture a long page from the toolbar button. It should start on the single click,
   with no popup. A result tab should open alongside without stealing focus.
4. In the result tab, press Download. **That** is when the downloads permission
   should be requested, not before. Later saves should not re-prompt.
4. Capture with `Alt+Shift+P`.
5. Watch the toolbar icon fill and the badge count up while it runs, and the
   progress panel under the button if you have it switched on.
6. Try `chrome://extensions` itself: expect a clear failure badge, not a hang.
7. Capture a page, then confirm the page is left where you found it: scroll position
   restored, sticky header back, no leftover styling.
8. Repeat one capture at 150% browser zoom and once on a retina display.
9. Close the result tab mid-capture: the run should stop cleanly and the source
   page should still be restored.
10. In the result tab: draw an arrow, undo it, and confirm the image underneath is
    pixel-identical to before. Crop, then `Revert all`.
