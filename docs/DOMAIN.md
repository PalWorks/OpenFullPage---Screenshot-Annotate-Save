# Domain

The vocabulary the code assumes. An agent that does not know `captureScale` from
`outputScale` will write a bug that looks correct.

## The capture

**Screenful.** One `chrome.tabs.captureVisibleTab` call: a photograph of exactly
what is painted in the viewport right now. Chrome will not photograph anything
outside it, which is why a full page capture is a walk rather than a single call.

This is the word the code and these documents use, and it stays. It is not the word
the interface uses: the progress panel counts "Screen 4 of 11", because `screenful`
is precise and unfamiliar, and the panel is read by someone waiting rather than by
someone reading the source.

**Tile.** A planned stop on that walk, as `{x, y}` in document coordinates. The
planner produces the list; the walk visits each one, scrolls there, waits, and takes
a screenful. Tiles and screenfuls correspond one to one, but a tile records where we
*asked* to be and the screenful records where the page actually *landed* (the last
row and column clamp against the document edge, so they differ).

**Region.** The part of the document being captured, as `{x, y, w, h}` in CSS
pixels. Full page mode uses the whole document. Visible area mode uses the current
viewport. Element mode uses the box of the element the user picked.

**Plan.** The output of `planCapture()` in `src/lib/plan.js`: the tile list, the
output dimensions, the origin, the two scales, and whether the result had to be
truncated. Everything the walk and the stitcher need, computed before either runs.

## The two scales, which is where capture bugs live

**captureScale.** CSS pixels to captured pixels. It is `devicePixelRatio`, and
Chrome folds browser zoom into that, so this one number covers both a retina display
and a user at 150% zoom. A 1000px wide viewport on a retina Mac yields a 2000px wide
screenful, so `captureScale` is 2.

**outputScale.** CSS pixels to pixels in the finished image. Normally equal to
`captureScale`. It is lower only when the page is too long to fit inside Chrome's
canvas limits at full resolution, in which case the planner reduces it rather than
cutting content off. It is never higher: the stitcher never upscales.

Both limits are in **device** pixels, which is the reason long pages used to come
back cut in half on retina displays: a 16384px canvas only holds 8192 CSS pixels of
page at `devicePixelRatio` 2.

**MIN_OUTPUT_SCALE (0.5).** The floor. Below roughly half resolution body text stops
being readable, so a smaller image would not be a worse copy of the page, it would
be a useless one. Pages that still do not fit are truncated, and the result tab says
so.

**Truncation.** What happens when even the floor scale cannot fit the region inside
the canvas limits. Content is lost, and the user is told. Fixing this properly is
F10 (multi part export) in [ROADMAP.md](ROADMAP.md).

## Canvas limits

Chrome refuses a canvas wider or taller than **16384px**, and very large ones fail to
allocate well before the theoretical maximum, so the planner also caps total area at
**128 megapixels**. Both are enforced in `LIMITS` in `src/lib/plan.js`.

## Page preparation

**Marking.** Before measuring, every `position: fixed` element is tagged
`data-fpc-fixed` and every `position: sticky` element `data-fpc-sticky`. Marking is
done with data attributes and the visual change with `chrome.scripting.insertCSS`,
never by injecting a `<script>`.

**Unsticking.** `PREPARE_CSS` returns sticky elements to normal flow so they appear
once, at their real position, instead of riding down every screenful. This changes
the document height, which is why the page is prepared before it is measured.

**Hiding fixed elements.** `HIDE_FIXED_CSS` is inserted after the first screenful,
so a fixed header appears once at the top and then stops repeating. A cookie banner
is a fixed element, so it is already absent from every screenful except the first.

**Re-marking.** `markSpecialElements()` runs once, before the walk, and cannot tag
what is not fixed yet. Plenty of headers and floating cards are ordinary elements
until a script makes them fixed on the first scroll, and those rode every screenful.
`remarkFixed()` asks the question again after each scroll and before each
photograph, and lifts marks as well as applying them: something that has stopped
being fixed has rejoined the flow and belongs in the picture where it now sits. D63.

**Settling.** Waiting for the page to stop changing height, and for the images
actually in shot to finish loading, rather than sleeping a fixed amount. A page with
no lazy content waits almost nothing.

## The editor

**Document.** `{width, height, past[], present, future[]}`. History is a stack of
whole snapshots rather than a list of draw commands, which is what makes undo
uniform across drawing, moving, resizing, restyling and cropping.

**Present.** `{shapes[], crop, selected}`.

**Shape.** A live object, not a baked stroke. Once drawn it can be selected, moved,
resized, restyled or deleted. Kinds carry the model: `arrow`, `line`, `text`,
`counter`, and the eleven in `GEOMETRY_KINDS` (`rect`, `highlight`, `pixelate`,
`ellipse`, `rhombus`, `triangle`, `hexagon`, `parallelogram`, `cylinder`, `callout`,
`loupe`), each described once as path operations that the canvas and the hit tester
both read.

**Tool entry.** What the Shapes popover offers, which is not the same list.
`SHAPE_TOOLS` in `src/lib/edit.js` holds fourteen entries, because **Rounded box**
and **Stadium** pick `rect` and set a corner radius rather than adding two kinds to
the model. Anything that needs the list derives it from `SHAPE_TOOLS` rather than
repeating it: the hand-written copy went stale within one release, and the sweep
tested twelve shapes without a word about the two it had never heard of. D51.

**Paint.** One of the five things a shape can be given a colour for, declared once in
`PAINTS`: `border` and `fill` on a shape, `text`, `frame` and `plate` on a caption.
Every colour popover in the product is built from that description, so a control
cannot exist in one panel and be missing from another. Four of the five offer **no
colour** as a real stored value, not an absence: `null` means the reader asked for
nothing to be drawn, and `undefined` means they never said. Text is the exception,
because `inkOf` falls back to the frame colour and then to near-black, so the control
would promise something the model does not do. D57, D62.

**commit vs amend.** `commit()` records a new state and makes the previous one
undoable. `amend()` changes the present without touching history, used for live
selection and for the in progress part of a drag.

**Crop.** A window onto the original image, never a destructive cut. `effectiveCrop`
returns the full image when no crop is set.

**Base.** The stitched original capture, kept untouched. Every frame re-renders from
it. Never draw into it.

**Flatten.** Rendering without the selection handles, for export. What you see is
what you get, minus the chrome.

**Redaction is the one destructive edit.** Pixelate resamples coarsely from the
original and paints it back, and because the export is a flat PNG or JPEG there is
no layer underneath it in the saved file. This is deliberate and it is the reason
no layered export format may be added without revisiting it.

## Filenames

**Basename.** `product-timestamp-site`, for example
`openfullpage-20260908T142305-theguardian-com`. The product part comes from the
manifest `short_name`, not `name`, so rewriting the store listing for SEO never
lengthens a filename. The timestamp is ISO 8601 basic format because the extended
format's colons are illegal in filenames on Windows.

**Sanitising.** Everything outside `[a-z0-9-]` is stripped from the generated parts,
and the filename box the user can type into is treated as hostile: no path
separators, no traversal, no control characters, no leading dot.
