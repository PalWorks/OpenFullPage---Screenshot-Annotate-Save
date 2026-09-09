# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version records the SHA-256 of its published zip. Packaging is
deterministic, no timestamps, no host details, so this hash is reproducible from
a clean checkout with `./tools/pack.sh`, not merely checkable against one download. See
[docs/VERIFYING-YOUR-INSTALL.md](docs/VERIFYING-YOUR-INSTALL.md).

## [Unreleased]

Everything below is on `main` and not yet packaged. It covers the toolbar rework
and the capture reliability work of 2026-09-08 and 2026-09-09.

### Fixed: a capture could reach 100% and never open
On pages whose scripts never go quiet, the walk finished with every screenful in
hand and then wedged: the toolbar icon read 100%, the panel read "Screen 11 of
11", and no result tab ever opened. The screenfuls are held in the service worker
until the walk ends, so a step that never settles destroyed all of them.

`chrome.scripting.executeScript` against every frame in the tab is the step that
hangs, and putting the page back runs it on every single capture, which put the
wedge exactly between the last screenful and the result tab. Every await that
crosses into a page, a frame or a new tab now has a deadline. A step that times
out after the walk has begun ends the walk and delivers what was captured, rather
than losing it. See [docs/DECISIONS.md](docs/DECISIONS.md) D27.

### Added: Finish now, in the progress panel
Once a screenful has landed, the progress popup offers to stop where it is and
open what has been captured. Some pages never stop growing, and nothing can tell
"nearly done" from "will never be done" from the outside, so the reader decides.
The image is trimmed to the part that was reached and says on arrival that it ends
where you stopped it. D28.

### Added: save straight to your downloads instead of opening the editor
Off by default, in settings. The capture is written to a file and the tab it was
written from closes itself, so a capture is one click and nothing else. Chrome
asks for the downloads permission at the moment the switch is turned on, because
this mode has no later click to hang a permission prompt on; decline it and the
setting does not stick. D29.

### Added: cropping asks before it cuts
Dragging with the crop tool now proposes a region instead of applying one. What is
outside it dims, the region carries eight handles and can be slid whole, and a bar
with a tick and a cross confirms or abandons it. Enter and Escape do the same.

The bar is fixed to the viewport, not to the region. A capture is often ten screens
tall, so checking the edges of a crop means scrolling, and a button anchored to the
image would be off screen exactly when it is wanted. Cancelling leaves no undo step,
because nothing was ever committed. D30.

### Added: PDF, alongside PNG and JPEG
Written by hand, because a PDF library is a dependency and a build step. Lossless:
the samples go through `/FlateDecode` rather than as a JPEG, since this tool
photographs text and JPEG rings around every glyph edge. Long captures become
several pages at the capture's own width, with no scaling and no margins, and the
height is divided evenly so the last page is never a two pixel sliver. D31.

### Added: light, dark and system themes
A button on the toolbar rotates through the three, and the same choice is on the
settings page. System is the default, and it is a real third state: it stamps
nothing and keeps following the operating system as it changes. D32.

### Changed: Revert is now Reset, and does the obvious thing for where you are
With edits on the canvas it removes them, as before. On an untouched capture it puts
the drawing style back to the defaults: the tool, the colours, the stroke, the fill
and the type. Those are remembered between captures on purpose, and there was no way
back. It deliberately leaves the output format, the toolbar switches and the capture
settings alone. D33.

### Added: Catbox in the upload list
Above Litterbox, which is unreachable from some countries. Catbox keeps the link
rather than expiring it, so both are offered.

### Added: an index down the side of the settings page
Built from the sections themselves, so it cannot fall out of step with them, and
both are numbered from the same order.

### Changed: Shapes and Text no longer wear a box around their chevron
They are split buttons, and the border they drew around the chevron half made them
the only two controls in the row that looked like a different kind of thing. The
border now belongs to the whole control, as it does on every other group. The split
is still there; it shows itself on hover.

### Fixed: two settings saved at the same instant could lose one
Saving is read-modify-write over the whole settings object, so two overlapping saves
each put back what the other had just changed. Dragging the fill opacity slider
fires one per step. Writes are now serialised.

### Changed: the text inspector says where its colour comes from
It already explained why there is no alignment control, which is D21: alignment
describes how lines sit relative to each other and the entry box holds one line, so
four buttons that provably cannot change anything would be worse than the gap. It
did not explain that text takes the Border colour, which is the other thing missing
from that panel and the one a reader is more likely to go looking for. Both
decisions were real; only one of them was written down where anyone would see it.

### Fixed: the theme button never changed its icon
It cycled the theme correctly, stamped the right attribute, and updated its own
tooltip and label, and it went on drawing the same monitor glyph throughout. The
code hid the other two with `element.hidden`, which is a property of HTMLElement.
SVG elements do not have one, so the assignment set a plain JavaScript property and
painted nothing different.

Two more glyphs were stuck the same way, including the slash on the Fill button that
is meant to lift once a fill colour is chosen. All three now set the attribute, and
the CSS says what `hidden` means for SVG, because the user agent stylesheet does
not. The end-to-end check missed every one of them because it read the same property
the code wrote; it now reads computed `display`. D37.

### Fixed: the Shapes and Text chevrons opened nothing
Moving their border onto the group, so they stopped being the only controls in the
row with a box around their chevron, was done with `overflow: hidden`. Those two
groups also contain their own popover, and the clip removed it: laid out at the
right size, in the right place, and painted nowhere. Both menus were unreachable.

The corners are rounded on each half now instead of clipped on the group. Every
existing check passed throughout, because the tests that use those menus reach into
them by id rather than opening them the way a person does. A new check opens every
chevron in the toolbar and hit tests the centre of the menu it claims to have
opened. D38.

### Changed: the capture sits on a solarized mat
A screenshot of an ordinary page is white at its edges, and on a white page it had
no edge at all. The result tab's background is now solarized base3 in light and
base03 in dark, warm and cool off-neutrals rather than paper white and near-black,
so the boundary between the image and the tab is visible in both themes. The toolbar
keeps its own surface, so it still reads as chrome above the mat. `--muted` was
darkened from `#71717a` to `#6b6b73`, because against the warm mat the old grey
measured 4.48:1 and three labels sit directly on it. D36.

### Changed: the store screenshots follow the harness
The listing pointed at `1-whole-page.png` and the harness had been producing
`shot-capture.png` for some time, so the table named five files that no longer
existed. It now follows `marketingShots()`, and the shots were regenerated against
the current interface.

### Changed: the repository names conventions, not products
Nothing under `src/` names another product, and CI fails if one appears. Claims
about identifiable competitors that were not sourced have been removed, keeping the
lesson each carried. `NOTICE.md` still names the work this is derived from, because
its licence requires that, and still disclaims association with any commercial
successor, because that is what a disclaimer is for. D34.

The scan was then widened, because cleaning only the shipped surface had simply
moved the problem into the documents: a working note naming a live product and
repeating its install count, a deferred task identifying an extension by store
history, a roadmap line asserting why a named competitor was removed. `docs/`,
`store/`, `tools/` and the root Markdown are now scanned on the same terms as
`src/`, with `NOTICE.md` the single exemption. Claims about identifiable third
parties are gone from the prose as well, including every unsourced assertion that a
particular extension shipped malware. The mechanism is what this project answers,
and the mechanism needs no defendant.

### Changed: the manifest said "as a single PNG"
It has saved JPEG since 1.6.0 and PDF since this release. Corrected to name all
three, at 118 of the 132 characters Chrome allows.

### Changed: the README rewritten
It was a feature tour that assumed the reader already trusted the project. It is now
a full technical README: architecture with the process diagram, a module reference
with real signatures and outputs, the port protocol, configuration, testing, the
release procedure, and the limitations stated up front rather than at the end. The
verification instructions moved near the top, because they are the claim everything
else rests on.

Stale numbers went with it. The verification guide said the source was "440 lines
across six files", written when that was true; it is 17 files and roughly 6,150
lines. `docs/LIMITATIONS.md` and `TASKS.md` both described `src/ui/result.js` as 452
lines, and it is 1,123. A document that quotes a number nobody rechecks is worse
than one that quotes none.

### Changed: git history rewritten before the repository was made public
The sanitisation above removed sentences from the working tree, and every one of
them was still readable in the commit that added it. Publishing a repository
publishes its history, so the history was rebuilt from the sanitised tree rather
than shipped with a set of claims the project had already decided not to make. D35.

### Changed: the progress panel says "Screen 4 of 11", not "Screenful 4 of 11"
`Screenful` is the word the code and the docs use for one `captureVisibleTab`
call, and it stays. It was never a word to put in front of a reader.

### Changed: the toolbar is grouped the way Preview groups its own
Tools, style, history and output, with a chevron on the groups that hold a set.
Shapes and Text are split buttons: the left half picks the tool, the right half
opens the inspector, so choosing Text no longer covers the canvas you are about to
click. D18.

### Added: shapes can be filled, and lines can be styled
A fill colour with its own opacity, solid, dashed and dotted strokes, arrowheads
on either end or both, and a stroke width in pixels. Existing shapes are
unaffected: every new key is optional and read through a defaulting accessor, so
nothing was migrated. D19, D20.

### Added: a settings file you can carry
Export every setting to a small `.json` file and import it anywhere. Settings are
never synced (D2), so this is the honest way to set the extension up on a second
machine. D24.

### Added: a support and feedback section in settings
It composes a message in your own email app and shows you exactly what "include
your version and settings" attaches, in full, before anything is composed. Nothing
is sent until you press send. D25.

### Added: the upload hand-off
Copies the image and opens the host you picked, so you paste it there. The
extension performs no upload and cannot. D16, D26.

### Fixed: a text box could never be typed into
Two separate causes. `.text-entry` had a class but no CSS rule had ever existed,
so the box was a static element appended to the end of the document and focusing
it threw the page to the bottom. And the browser's own mousedown focus ran after
the handler, stealing focus and firing a blur that committed the empty box and
removed it.

### Fixed: popovers could never close
`.pop[hidden]` and `.pop.paint` score identically, so the later `display: flex`
won and every popover was permanently visible. The end-to-end check that should
have caught it asserted `element.hidden`, which was true throughout. Checks now
ask the browser what it drew. D23.

### Fixed: chevrons rendered at the size of the icons they sat beside
`#toolbar button.icon svg` outscored `.caret`.

### Fixed: the upload popover opened outside the window
Its right-align class matched no rule at all. Popovers are now clamped against
`document.documentElement.clientWidth`, which excludes the scrollbar.

### Added: a warning before a reload destroys a capture
The service worker streams the screenfuls once and forgets them, so reloading the
result tab does not reload the screenshot, it destroys it along with every edit.
The tab now asks first.

### Changed: a new mark, a retro camera caricature on a teal disc
Used for the icon, the favicon and the social image.

## [1.6.1]: 2026-09-08

The store title, and a short name to go with it.

`openfullpage-1.6.1.zip`. SHA-256 `df5dd391c5cf2c90fb06ccb4ee876fb0ee92d3ab9e65f2db8d42b58409e70d40`

### Changed: the listing is called OpenFullPage - Capture Screen, Annotate, Save
The Chrome Web Store weights the title heavily in search, so it carries keywords
rather than only the product name.

### Added: a short name, so the title can change without changing filenames
`short_name` is `OpenFullPage`, and the download filename is built from that
rather than from the full title. Without it, tuning the listing would have
lengthened the prefix of every file a user saves, and the 40 character cap would
have truncated it mid word into `openfullpage-capture-screen-annotate-sav`.

Chrome caps `short_name` at 12 characters, which `OpenFullPage` exactly fits. An
invariant test now asserts that it exists, is within the cap, and that the title
begins with it.

## [1.6.0]: 2026-09-08

Finishing a shape hands it back to you, the actions are icons, and the download
format is a menu.

`openfullpage-1.6.0.zip`. SHA-256 `57d09a6da5d3556a9f7329ed12625efd02830a682d5ea355f17ba6750a2115b7`

### Changed: drawing a shape hands it back to the selection tool
Finish a box, an arrow or a line and the tool returns to selection with the new
shape already selected, ready to move, resize or restyle. This is the convention
in drawing tools generally, and the reason is that the next click after drawing
something is almost always aimed at the thing just drawn. Staying in the drawing
tool turned that click into a second shape.

Numbered steps are the exception, deliberately. Their whole purpose is 1, 2, 3 in
sequence, so that tool stays active. Making someone re-pick it between each number
would be worse rather than more consistent.

### Fixed: the colour swatches had turned into ellipses
A rule added in 1.5.0 to size the Copy and Download buttons matched every toolbar
button that was not an icon, which included the swatches, and stretched them
sideways. The rule now names the two buttons it was written for.

### Changed: Copy, Download and a new settings gear are icons
The three sit together at the right hand end of the row. The gear opens the
options page, which previously could only be reached through
`chrome://extensions`.

### Changed: the download format is a menu on the button
Rather than a separate format select sitting next to Download. Click Download,
pick PNG or JPEG, and it saves. The format you chose is remembered and shown
beside the filename, so the Save as box always reads as the whole name.

This is also the shape that scales: WebP and PDF become one more line in the menu
rather than another control in a row that is already full.

### Changed: the progress panel no longer sweeps
The scanning bar moved fast, moved in both directions, and had nothing to do with
how far along the capture was, so it read as noise. The panel fills downward as
screenfuls land, which says the same thing truthfully.

## [1.5.0]: 2026-09-08

Renamed to OpenFullPage. One toolbar row, and the filename is yours to edit.

`openfullpage-1.5.0.zip`. SHA-256 `d00a17c1f566facfda9c2690ba9bfb0a47c533796bdc63d92748ea10602f4d6d`

### Changed: the extension is called OpenFullPage
Scrollshot was already taken by at least two extensions in this exact category,
so a user searching for it would have found a competitor. The previous name, Full
Page Capture, is also occupied. OpenFullPage says the thing that actually
distinguishes this one: the source is published and the build is reproducible.

The download filename follows the manifest name, so it renamed itself. Released
artefacts keep the names they were published under.

### Changed: one horizontal row
The page title row is gone and the tools have moved up into it, so every tool,
the format, Copy and Download sit on a single row. It is sticky, and it is on
screen from the moment the tab opens rather than appearing when the capture
lands, so nothing jumps. The tools are inert until there is an image to use them
on.

The per tool hint line is gone with it. Every button already carries its name and
its keyboard shortcut in a tooltip, and that line is now the filename box.

### Added: the filename is editable before you save
A "Save as" box below the toolbar, prefilled with the generated name and with the
extension shown alongside it, following the format you pick. Enter saves, the way
every save dialog does.

This is the only place in the extension where a person's typed text becomes a path
handed to `chrome.downloads`, so it is treated as hostile: path separators,
traversal sequences, control characters and a leading dot are all removed, and a
trailing image extension is stripped so choosing PNG after typing "shot.png" does
not save "shot.png.png". Spaces, dots, dashes and underscores survive, because
people want them and none of them can escape the directory.

Covered by seven unit tests and an end to end check that types
`../../My Report: v2` into the box and asserts that what lands on disk is
`My Report- v2.png`.

## [1.4.0]: 2026-09-08

An animated progress panel, an icon toolbar, and downloads named after the page
they came from.

`fullpage-capture-1.4.0.zip`. SHA-256 `4405134316f33d38096484e82db2b1ea61a664934845fab6c076ba20d0b956d9`

### Added: a progress panel while capturing
An animated panel under the toolbar button, showing a page filling in as
screenfuls land, the percentage, and which page is being captured. Switch it off
in the options page; the toolbar icon reports progress either way.

It is a toolbar popup, not an overlay drawn into the page, and that is the whole
design. The page is what we photograph, so anything injected into it is inside the
screenshot: an in-page indicator would have to be hidden for every single
screenful and would strobe. The popup is browser chrome, so it animates steadily
for the entire capture and can never reach the image.

`default_popup` stays empty so one click still captures immediately. It is set
only for the duration of a capture, which means a second click during one shows
progress rather than doing nothing, and it is cleared whenever the worker starts
in case a capture was interrupted.

### Changed: the toolbar is icons now
Select, arrow, line, box, ellipse, highlighter, redact, text, numbered step and
crop are drawn rather than spelled, as are the three stroke widths and undo, redo
and delete. Every button keeps its `aria-label` and its tooltip with the keyboard
shortcut, so nothing is lost to a screen reader or to anyone who wants the name.

### Changed: download filenames carry the product, the time and the page
`fullpage-capture-20260908T142305-theguardian-com-world-live-2026-sep-07.png`

Product name, then an ISO 8601 basic format timestamp, then the page URL. Basic
format because the extended format's colons are illegal in filenames on Windows;
it is still ISO 8601 and still sorts chronologically as plain text. The URL comes
from the page itself, since `tab.url` is undefined without host permissions, and
everything outside `[a-z0-9-]` is stripped from both the name and the URL.

The product name is read from the manifest, so it follows any rename on its own.

### Fixed: a capture could hang forever if you switched tabs
`requestAnimationFrame` does not fire in a tab that is not being painted, so the
settle step waited for a frame that would never come. Switching tabs or covering
the window mid capture hung it with no way out. The frame is now raced against a
timer: the frame is the fast path, the timer is the guarantee.

### Fixed: a second progress panel silently stopped the first
The worker held one port. Chrome can have more than one of these documents alive
at a time, and a short lived second connection overwrote the reference to the live
one, whose disconnect then stopped every further update. It now holds a set, tells
all of them, and a panel that goes away removes only itself.

### Changed: no more em dashes anywhere
Prose, comments, commit messages, docs and UI strings, swept across the whole
repository and enforced from here on.

## [1.3.1]: 2026-09-08

Long pages are captured whole, and the page is walked once instead of twice.

`fullpage-capture-1.3.1.zip`. SHA-256 `180269a3758f42553a34ba43434ace0f5c7388f18a896e983142a6526c7877ef`

### Fixed: long pages were cut in half on a retina display
Chrome's 16384-pixel canvas limit is measured in *device* pixels, so at
`devicePixelRatio` 2 it holds only 8192 CSS pixels of page. Anything longer was
silently truncated: a 20,578-pixel Guardian live blog came back **40% captured**.

The planner now lowers the output scale until the whole page fits, and only
truncates if it still does not fit at half of CSS-pixel resolution. That live blog
is now captured in full, at 78%, and the result tab says so. Losing sharpness on
the pages that need it beats losing three fifths of the page.

MDN's `position` reference went from truncated at 16384 to complete at 82%.

### Changed: one pass down the page, not two
Capturing used to race down the whole page to trigger lazy images, scroll back to
the top, then walk it again taking screenshots. Now there is a single walk: each
stop waits for the images actually in shot to load, up to 700ms, and pages with no
lazy content never wait at all.

This is both faster and more correct. The old warm-up ran against a fixed budget
and lost the race on anything slower than it; the new wait is for the specific
images being photographed. Amazon's home page went from 2722 to 4487 pixels
captured, the extra height is content the warm-up pass had been missing.

The walk also re-plans when the page grows underneath it, which is normal on feeds
and live blogs, bounded at 400 screenfuls so an endlessly-growing page terminates.

### Fixed: the page is measured only once it has stopped moving
Preparation moves the page: sticky headers rejoin the flow, and cross-origin
frames report their height over an asynchronous round trip. The old code measured
after a fixed 400ms wait and got away with it only because the warm-up pass
happened to spend three more seconds afterwards. Removing that pass exposed the
real bug, a cross-origin frame finished expanding *during* the walk, so the first
screenfuls disagreed with the last and 288 pixels of frame went missing.

Measuring now waits for the document height to stop changing, up to two seconds,
and returns as soon as it is stable. A page that was never going to move costs
under 200ms. Caught by `--iframes --deep`.

### Fixed: hairline seams between screenfuls
At a fractional output scale, rounding each tile's origin and size independently
could leave a one-pixel gap between screenfuls. Both edges are now rounded, so
neighbouring tiles abut exactly.

## [1.3.0]: 2026-09-07

A real editor, opt-in advanced access, and extra capture modes. The result tab now
opens only when there is something to show.

`fullpage-capture-1.3.0.zip`. SHA-256 `9121e67aa1e24e1005c7ecba6672996860e10a30aa247eb7a87e69fa8a5de2b6`

### Changed: the capture no longer opens a tab up front
The result tab used to open at the start, because it did the stitching as
screenfuls arrived. That meant staring at an empty tab while the page scrolled.
The screenfuls are now held in the service worker, the page is restored, **and
then** the tab opens with the finished image.

### Added: the editor, rebuilt around live objects
Shapes are no longer committed strokes. Select one and you can drag it, drag its
handles to resize it, restyle it, or delete it, the model annotation tools and
Preview share. History is a stack of whole snapshots, so undo covers moves and
resizes as uniformly as it covers drawing.

- Tools: **Select, Arrow, Line, Box, Ellipse, Highlight, Redact, Text, Step, Crop**,
  each with a single-key shortcut.
- **Redact** resamples the pixels from the original rather than drawing a blur over
  them, and the export is flat, so a saved image has no original underneath.
- **Copy to the clipboard**: needed no permission: `navigator.clipboard.write`
  works from a focused page with a gesture.
- Shift constrains to squares, circles and 45° lines. Escape deselects, Backspace
  deletes. Tool, colour and width are remembered between captures.

### Added: advanced access, off by default
A settings page (`chrome://extensions` → Extension options) with two switches:

- **Capture inside cross-origin frames**: requests `webNavigation` and
  `<all_urls>`. Frames of any origin are then laid out at full height, using
  `event.source` identity matching, which works across origins where property
  access does not.
- **Extra capture modes**: visible area (`Alt+Shift+V`) and pick-an-element
  (`Alt+Shift+E`), plus a capture delay. No permission involved.

Both are off until switched on. [docs/ADVANCED-ACCESS.md](docs/ADVANCED-ACCESS.md)
states what each costs in plain words.

### Changed: the invariants, deliberately
This release relaxes one rule and adds another. Read the diff of
`test/lib/scan.js` alongside the code, which is what GOVERNANCE.md asks reviewers
to watch for.

- **Relaxed:** `optional_host_permissions` is no longer banned, so `<all_urls>`
  may be *offered*. Required `host_permissions` remains banned outright, and a new
  assertion caps what may be granted at install to exactly `activeTab`,
  `scripting` and `storage`.
- **Added:** the synced storage API is banned. Settings are stored locally; sync
  would copy them to Google's servers, which is a network path this extension
  otherwise does not have.
- Unchanged and still enforced: `connect-src 'none'`. Even with every optional
  permission granted, the extension can read a page and has no way to transmit
  what it read. That is the argument for allowing the option at all.

### Fixed
- `setIcon` was called once per screenful, so Chrome's icon reads overlapped and
  cancelled each other, throwing on most frames. Only real frame changes are sent
  now, and failures can no longer take a capture down.

### Testing
- `test/edit.test.js`, 26 tests over selection, hit testing, handle maths, move
  and resize, and undo across all of them.
- `run.mjs --edit` now drives selection, dragging, restyling and deletion with
  real mouse events, and asserts the pixels underneath a deleted shape come back
  exactly.
- `run.mjs --iframes` runs in **both** permission states and asserts the gate
  works: 400px of a cross-origin frame without advanced access, all 3000 with it.
- The harness reports uncaught exceptions and console errors from the worker, the
  driver page and the result tab. An extension that throws now prints a stack
  trace instead of hanging.

## [1.2.0]: 2026-09-07

Crop and annotate before you save, and same-origin iframes are captured in full.

`fullpage-capture-1.2.0.zip`. SHA-256 `56220d540b130465d6ac46743a01f1ea0fa15dfe1b5eae8664f1868c08d291c4`

### Added
- **An editor in the result tab**: crop, arrow, box, six colours, three widths, and
  undo/redo with Cmd/Ctrl+Z. The first step of [docs/ROADMAP.md](docs/ROADMAP.md).
  - The stitched capture is kept untouched on its own canvas and every edit
    re-renders from it. Undo is therefore exact, repeated edits never degrade the
    image, and `Revert all` always works.
  - Coordinates are stored against the original image, not the cropped view, so
    cropping twice, or cropping and undoing, moves nothing.
  - What the canvas shows is what gets downloaded.
- **Same-origin iframes are laid out at full height before capture**, so their
  content is captured instead of being left behind their own scrollbar. A 400px
  frame holding 3000px now contributes all 3000. This needs **no new permission**:
  the page holding the frame can read `contentDocument.scrollHeight` and set its
  height. Frame heights are restored afterwards along with everything else.

### Changed
- Adding no permissions: still `activeTab` and `scripting`, with `downloads`
  optional and requested only when you press Download.

### Documentation
- **Cross-origin iframes are the honest limit.** They render into the capture, but
  their height cannot be read from the parent, so only their visible box is
  included. Going further needs `webNavigation` + `<all_urls>`, access to every
  site you visit, which stays refused. Both behaviours are now asserted by
  `test/e2e/run.mjs --iframes`.

### Testing
- `test/edit.test.js`, 18 tests over the editing model: undo across a crop, redo
  branches being discarded on a new edit, arrow heads never outgrowing the arrow,
  clamping a selection to the image.
- `test/e2e/run.mjs --edit` drives the editor with real mouse events and asserts
  against **canvas pixels**: draw, undo back to a pixel-exact original, redo, crop,
  undo the crop, then download and confirm the saved file matches what was on
  screen.

## [1.1.0]: 2026-09-07

One click captures. The result opens in a tab, and permission to save is asked for
only when you actually save.

`fullpage-capture-1.1.0.zip`. SHA-256 `6a3a29abb7b8a545a8faad1d86e3ebeb590b4a2529f90249f854b8fe1f74a5db`

### Changed
- **No popup.** Clicking the toolbar button (or Alt+Shift+P) starts the capture
  immediately. There is no intermediate window and no second button.
- **The capture opens in a result tab** showing the finished image, its dimensions,
  a format choice and a Download button. It opens unfocused, alongside the page,
  because capturing reads whichever tab is active.
- **The downloads permission is requested from the Download button**, on a real
  click, instead of on first use of the extension. A capture you only look at, or
  drag out of the tab, needs no permission at all.
- **PNG or JPEG**, chosen at download time and re-encoded from the same canvas.
- **Progress is shown on the toolbar icon**: the page in the icon fills as
  screenfuls land, with an exact percentage on the badge. The frames are generated
  from the same source as the icon and verified by CI.
- **New icon**: crop marks around a tall page. Crop marks are the common sign for
  "capture"; the near-1:2 page is what says "the whole page". The accent colour is
  now reserved for progress, so amber in the toolbar means a capture is running.

### Removed
- **The `offscreen` permission.** Stitching moved into the result tab, which has a
  DOM of its own. Two required permissions remain: `activeTab` and `scripting`.

### Fixed
- `captureFilename` accepted `null` as a file extension, because a bare regex test
  coerces it to the string "null". Downloads could have been named `.null`.

### Documentation
- **Corrected the iframe claim.** V1 said cross-origin iframes might not capture.
  Measurement says otherwise: frame content *is* captured, including cross-origin,
  because captureVisibleTab photographs what is painted. What is not captured is
  content below a frame's own scrollbar. `test/e2e/run.mjs --iframes` covers it.
- [docs/ROADMAP.md](docs/ROADMAP.md) plans the annotation editor,
  crop, arrow, text, destructive redaction, plus PDF export and paper sizes, and
  records why `webNavigation` + `<all_urls>` are refused despite being what would
  make frame scrolling work.

## [1.0.0]: 2026-09-07

First release. Captures a whole page to a PNG, and nothing else.

`fullpage-capture-1.0.0.zip`. SHA-256 `dfb7df4568c324dbc784aa8f549013836fe9e1165d6e4fd15a42a256ad204925`

### Capture
- Click the toolbar button or press `Alt+Shift+P` to capture the active tab.
- Measures the page, walks it a viewport at a time, stitches the pieces on an
  offscreen canvas, and saves a PNG.
- **Sticky and fixed elements are de-duplicated**: sticky elements are returned to
  normal flow so they appear once at their real position, and fixed elements are
  kept in the first tile then hidden. Without this the output is visibly broken on
  most modern sites.
- **Lazy-loaded content is warmed up** before capture, so material below the fold is
  not captured blank.
- Correct on retina displays and at browser zoom: the scale is derived from the
  captured bitmap rather than assumed.
- Scrollbar gutters are cropped out of every tile.
- Backs off and retries when Chrome rate limits screen capture.
- Restores scroll position, sticky headers and animations even when a capture fails.
- Truncates at Chrome's 16384px canvas limit and says so rather than failing.
- Errors are explained in terms the user can act on.

### Security posture
- Manifest V3 with **no** `host_permissions`, `web_accessible_resources`,
  `externally_connectable`, `update_url` or `storage`.
- CSP sets `connect-src 'none'`: network access is structurally impossible.
- `downloads` is optional and requested on first save, not at install.
- No dependencies, no build step: the shipped zip is byte-identical to the source.

### Tooling and governance
- `test/invariants.test.js` enforces the security posture on every commit, with a
  deliberately poisoned fixture proving the checker still fires.
- `test/plan.test.js` covers tile arithmetic, canvas limits and filename sanitising.
- `test/e2e/` drives real Chrome and inspects the resulting PNG pixel by pixel.
- `tools/verify-crx` (Go) lets any user prove their install matches this repository.
- Icons are generated from `tools/icon-design.mjs`; CI asserts the committed PNGs
  match the design.
- [GOVERNANCE.md](GOVERNANCE.md) records a non-transfer covenant and a dated canary.
- Licensed GPL-3.0-only, crediting the MIT original by Peter Coles ([NOTICE.md](NOTICE.md)).

### Not in this release
Annotation, JPEG/PDF export, clipboard, an options page and translations are all
out of scope for V1. Any of them must leave the invariants above passing.
