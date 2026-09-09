# Review: flowchart shapes, exact hit testing, selection chrome, multi-select, text frames

Date: 2026-09-09
Branch: main, at `bf62d18`
Expires: 2026-12-08
Expires when: the work below ships and its decisions are written into DECISIONS.md

Read [README.md](README.md) in this directory for what a review record is and
what to do when this one expires.

> **The expiry event has happened.** The work below shipped on 2026-09-10 and its
> decisions are written into [DECISIONS.md](../DECISIONS.md) as D43 through D47.
> By this directory's own convention that makes this record redundant and the
> honest answer is to fold it in and delete it. It is left here for one reason:
> the argument it carries about HOW the work was reviewed, including the single
> voice caveat and the claims that did not survive, is not a decision and has no
> home in DECISIONS.md. Delete it, or keep it as a record of method, but do not
> quietly extend the date.

## What was reviewed

A plan to take the editor from five shapes and one selected object to fourteen
shapes, several selected objects, exact hit testing, eight resize handles, and a
border and background plate for text. Six workstreams by the end.

The plan itself is not in this repository. It lived in the review tooling's own
directory and was rewritten twice during the review. What survives is below.

## Method, and its limits

Three independent voices, each given the plan and the code and none of them
given the others' findings: a strategy voice, a design voice, an engineering
voice. Each reviewed against the plan and against the source, not against a
summary of it.

**The cross-model half did not run.** The second model was out of quota for the
whole review, so every phase ran with one voice rather than two. That matters
and is recorded rather than glossed: a finding both models reach independently
is much stronger evidence than a finding one model reaches, and none of what
follows has that behind it. What it has instead is that every load bearing
finding was **checked against the code by hand** before it was accepted. The
distinction between "verified" and "asserted" below is the whole value of this
document.

## The premise gate

The plan justified fourteen shapes with a claim about adoption: that the first
review a stranger writes will be about whether the editor feels finished. That
is a claim about growth being used to license feature work, and it went to the
maintainer rather than being auto-resolved.

**Settled: parity, not differentiation.** Shapes remove a reason to leave a bad
review. They do not win users. The wedge stays what [../../CLAUDE.md](../../CLAUDE.md)
says it is. Every expansion in the rest of the review was then judged against
whether it removes a **visible deficiency**, not against whether it sounded like
growth. Several candidates failed that test and were deferred, which is the
point of setting a premise before reviewing rather than after.

The one deliberate exception is the loupe, which is differentiation and is
scoped as such.

## Findings verified against the code

Four findings changed the plan. Each was checked by reading the file, not by
trusting the voice that raised it.

**1. The content security policy has a hole, and it is under the one sentence
the product is sold on.** `manifest.json:64` is
`script-src 'self'; object-src 'none'; connect-src 'none'; frame-src 'none'`.
There is no `default-src`, so `img-src`, `style-src`, `font-src` and `media-src`
are unrestricted, and an image element with a remote source is an open
exfiltration path. `connect-src 'none'` does not cover it. Meanwhile README line
3 promises the absence of network access can be proven in about five minutes,
and a stranger who spends those five minutes finds this first.

This was already written down as **T19**, priority 1, estimated 0.5d / 15m, with
the replacement string sitting ready in `TASKS.md`. It had simply stayed open.
Neither `test/invariants.test.js` nor `test/lib/scan.js` asserted anything about
`default-src` or `img-src`, so the promise had no test under it either.

**Decision: T19 lands first, on its own commit, with the invariant test.** Ahead
of every shape. It defends the only claim the product cannot afford to lose, and
it is fifteen minutes.

**2. The roadmap had already scoped this feature, and the plan did not read it.**
`docs/ROADMAP.md` **F29** named three shapes and gave reasons: a rounded
rectangle (because everything it is drawn around is rounded), a speech bubble
(because explaining a screenshot is the job), and the **loupe**, a circle that
redraws what is under it magnified, which the roadmap identifies as something
nobody else in the category has. It refused star and polygon as furniture that
no bug report needs.

The plan delivered the speech bubble, **dropped the loupe**, and substituted a
stadium for the rounded rectangle. A stadium is a pill at every aspect ratio,
which is not what F29 asked for: boxing a rounded interface element wants a
modest fixed radius. So after the plan there would still have been no shape that
did the thing F29 wanted, and the one genuinely differentiated shape in the
backlog would have been silently dropped by a plan that never mentioned it.

**Decision: the loupe and a real rounded rectangle are restored.** Fourteen
shapes, not twelve. F29's refusal of star and polygon stands.

**3. Exact hit testing would have repeated, for shapes, the bug D19 fixed for
handles.** `hits(shape, point)` at `src/lib/edit.js:417` takes no tolerance
argument. Its slack is hardcoded in image pixels: four for boxes, and
`max(width * 2, 10)` for lines. `shapeAt` at `:432` takes none either. Meanwhile
`pickTolerance()` at `src/ui/editor.js:525` returns `HANDLE_SIZE * screenScale()`,
and D19 exists precisely because a fixed count of image pixels becomes a
fraction of a screen pixel on a fourteen thousand pixel capture displayed at
about twelve percent.

Today this is masked, because a box shape's hit area is its whole bounding box
interior, which is enormous. Replacing that with "inside the shape, or within a
band of its outline" moves all the forgiveness into the band, and at twelve
percent a four pixel band is under half a screen pixel. **Shipped as drafted,
the workstream meant to make selection more accurate would have made it unusable
on exactly the captures this extension exists to produce.**

**Decision: `hits` and `shapeAt` take a tolerance, fed from `pickTolerance()` at
all three call sites (`editor.js:638`, `:685`, `:730`), defaulted so existing
tests keep passing, with a unit test asserting a shape is still selectable at a
0.12 display scale.**

**4. The render path has no error handling at all.** There is no `try` anywhere
in `src/ui/editor.js`. Every shape draws inside one `render()`, so a single
throw stops rendering permanently, with the user's annotations still in memory
and no way to see or save them, and nothing in the console. Three of the new
shapes do arithmetic that can produce a degenerate rectangle or a NaN, and the
loupe calls `drawImage` with a sample region that can reach past the edge of the
capture. `drawPixelated` already guards itself with `if (w < 1 || h < 1) return`,
which is the precedent.

**Decision: each shape draws inside a guard.** A shape that throws is skipped and
logged with its kind and rect; the frame still renders. Zero silent failures is
a rule in this repository and the render path was quietly exempt from it.

## Two defects the review found in code that already ships

Neither is in the plan. Both were found by voices reading the plan against the
source.

**The export leaks chrome.** `hideChrome` in `src/ui/editor.js` is used at four
lines: declared at 123, checked at 491 for the crop overlay only, set and unset
at 1281 and 1284. `flatten()` suppresses the selection outline by nulling
`selected`, which works. It never clears `hoverId`, and `drawHover` at `:501` is
guarded only by `hoverId && !preview && !pendingCrop`. So a keyboard Cmd+C or
Cmd+S, with the pointer resting on an unselected shape, bakes a 1.5px indigo
rectangle into the exported PNG and PDF. `pointerleave` masks it for mouse driven
exports, because you move off the canvas to reach the button, which is why it was
never seen. This shipped in F41 on 2026-09-09. One line: `if (hideChrome) return;`
at the top of `drawHover` and `drawSelection`.

**A loupe would have un-redacted a redaction.** This one is about the plan, but
the mechanism is in shipped code. `drawPixelated` samples the immutable base, and
its comment at `editor.js:341` promises "the export is flat, so what is saved
genuinely has no original underneath". The loupe was going to sample the base
too, for good reasons (D5, exact undo), and `render()` draws shapes in array
order. A loupe placed over a redaction would therefore sample the original pixels
underneath it and paint them back, magnified, into the exported file. Redact a
password, drop a loupe on it, export, and the PNG contains the password larger
than it was, under a comment promising otherwise.

**Decision: loupes sample a redacted base.** When a document holds both a loupe
and a redaction, the redactions are rendered once into a scratch copy of the base
and loupes sample that, cached against the redaction shapes' serialisation
because a scratch canvas per frame at 16,000px is not affordable. The acceptance
test is hostile and gates the shape: redaction over a known colour, loupe on top,
flatten, assert zero pixels of that colour survive.

## What the design voice changed

- **Corner radius is a property, not three tools.** Rect, rounded rect and
  stadium differ only in radius, and this repository already treats that kind of
  thing as a property: dash and fill live in popovers, not as separate tools. One
  Box tool plus a radius row in stroke style. At 19px a 0px and a 1.5px radius
  are the same picture, so three tools would have meant two illegible icons.
- **The proposed grid did not fit.** Buttons are 30x28 (`result.html:135`), `.pop`
  padding is 7px, `.opts` gap is 6px. Seven columns inside 216px gives 23.7px per
  cell, a 21 percent shrink, below the size L15 already records as under the
  touch target guideline. Five columns, with section headings rather than
  hairline dividers, because a divider separates things you already understand
  and a label teaches a vocabulary you do not.
- **All shapes default on.** The first draft had most of them off, reasoning from
  D17. That was a misreading: D17 governs what is always visible, and the shapes
  popover is behind a chevron and costs no visible space. Defaulting them off
  would have built the flowchart set where nobody would find it.
- **Selection chrome went from six states to three.** Counted properly there were
  six, and two pairs collided: the marquee rectangle and the multi-selection box
  are both dashed indigo rectangles around several shapes, so "still dragging"
  and "these are selected" look identical; and the per-member outline was
  pixel-identical to the existing hover outline. The union box is cut. Three
  marks remain, one meaning each.
- **Every chrome stroke gets a white casing.** A 55 percent indigo hairline over
  a screenshot of a blue themed page is invisible, and this product's subject
  matter is web pages.
- **The plan made L14 worse and did not say so.** Nine new shapes with no
  keyboard creation path, a pointer only marquee, pointer only shift click.
  Arrow key nudge moves one denominator while the numerator grows. Accepted fix,
  cheaper than the marquee: Tab cycles the selection through z order, Space
  toggles membership, Enter places a default sized shape.

## What the engineering voice changed

- **The plan's central claim about multi-select was false.** It said keeping
  `selectedShape` "keeps the diff proportional to the behaviour change rather
  than rewriting every call site". `restyleSelection` (`editor.js:1036`) returns
  false on a multi-selection, and all six style setters route through it, so
  "setting a colour applies to every member" was unreachable and would have
  failed silently: the swatch updates, the shapes do not. `deleteSelection`
  returns false too, and the toolbar Delete greys out. Six setters have to be
  rewritten regardless, and the workstream was re-priced.
- **`pointerdown` collapses the selection before the drag starts** (`:730`), so
  group move would never have fired. The rule needed stating: if the pressed
  shape is already a member, do not touch the selection on pointerdown, and
  collapse on pointerup only if the pointer never moved.
- **The geometry table had two switches where the old code had one.** Returning a
  point list for some shapes and a discriminated object for others needs a switch
  to draw and a second switch to hit test, and the two can disagree, which is the
  bug that makes a shape draw here and select there. Replaced with one outline
  vocabulary: arcs flattened to polygons at construction, one point in polygon
  for all fourteen.
- **The tolerance fix contained the bug it was fixing.**
  `hits(shape, point, tolerance = 4)` defaults to the exact hardcoded value that
  is the defect, so any future call site inherits it silently and the tests stay
  green. The parameter is required.
- **`boundsOf` must stay the authored rect.** Once geometry returns points
  somebody will derive bounds from them. A callout tail and a cylinder cap can
  exceed `shape.rect`, and `resizeShape` reconstructs the rect from `boundsOf`,
  so a drawn extent would grow the shape on every drag frame.
- **The text rename touches thirteen sites, not four**, three of them in
  `result.js`, which the plan never mentioned. Two bite: assigning null to a
  canvas colour is ignored, so a frameless text would inherit the previous
  shape's colour (silent, order dependent, invisible to a unit test); and
  `result.js:650` calls `.toUpperCase()`, so a half-done rename does not degrade,
  it takes the editor out at first paint.
- **`hiddenButtons` is a denylist** (`settings.js:126`), so anything appended
  appears for every existing user regardless of defaults, and `sanitise` drops
  the first button when all are hidden, which with shape keys appended would be
  Select.

## Findings verified, smaller

- `sanitise` at `src/lib/settings.js:183` validates a stored tool name with
  `/^[a-z]{2,12}$/`. `parallelogram` is thirteen characters and would have been
  silently discarded on every reload. The fix is to validate against `TOOLS`,
  which is stricter than a wider pattern.
- `TEXT_FAMILIES` is an **array** at `src/lib/settings.js:32` and an **object**
  at `src/lib/edit.js:51`, same exported name, deliberately duplicated with a
  comment saying why. `settings.js:193` calls `.includes` on it and is correct
  only because it happens to read the array. This is why the text glyph colour
  became `shape.ink` rather than `shape.textColour`: there is already a
  `textColour` **setting**, and two things with one name at different layers is
  exactly the trap above, one level down.
- `SHAPE_TOOLS` is hand maintained at `src/ui/result.js:63`, separate from
  `TOOLS` in the model and separate again from the popover markup. Three lists,
  fourteen entries each. They will drift. Either derive it or add an invariant
  test that the three agree.
- `selectedShape(doc)` appears eleven times in `editor.js`, not the eighteen the
  plan claimed. The plan had counted from memory.

## Claims that did not survive

Recorded because a review that only lists what it found is flattering itself.

- **The migration argument was wrong and was withdrawn.** The plan's stated
  reason for doing this now was that the changes would be awkward to migrate
  later. They would not: nothing is persisted between sessions except style
  keys, and the document lives only for the life of one result tab. The plan
  said so itself, three pages further down, and contradicted its own headline
  reason.
- **One voice recommended cutting five of the seven requested shapes.** It had
  read the plan but not the conversation, so it read a direct request as the
  plan author's invention. The request stood. The reconciliation with F29 came
  out of the same finding and was worth having, which is the useful pattern: a
  wrong conclusion can still be sitting on a real observation.

## Accepted, deferred, refused

| | Item | Where it went |
|---|---|---|
| Accepted | Shift constrains while resizing, not only while drawing | this work. `constrain()` exists and was wired only to drawing |
| Accepted | Arrow keys nudge, Shift for ten pixels, one undo step per burst | this work. First real progress on L14 |
| Accepted | Alt drag duplicates | this work. Duplicating a shape is impossible today by any means |
| Accepted | Every shape gets its own switch on the options page | this work. README promises each control can be switched off individually, and at fourteen shapes behind one chevron that promise was about to become false |
| Deferred | Right click menu carrying z order | TASKS.md. Genuinely unreachable today, but a context menu is a new surface outside this blast radius |
| Deferred | Snapping and alignment guides | TASKS.md. Real work, and nothing is visibly deficient without it |
| Refused | Group and ungroup | Multi-select already delivers moving several things together. A persistent grouping model duplicates it |
| Refused | A draggable callout tail | A callout is aimed by moving the balloon, not the tail |
| Refused | Connectors that stay attached | This is what separates an annotator from a diagram tool, and it is a different product decision |

Accepting the first three finishes **F27**, which F41 had already half built. That
is why they were taken: they live in handlers this work rewrites anyway.

## What the review cost and what it changed

The plan went from 504 lines to 964. It gained a stated premise, a security
prerequisite ahead of all of it, two restored shapes, a corrected hit testing
model, an error handling section, six previously unlisted edge cases, six
previously unlisted tests, an effort estimate in the roadmap's own two scale
format, and a section naming what this work displaces.

Three of those were shipping defects: the CSP hole, the tolerance defect, and the
hover outline baked into exported files. One (F29) was a documented decision
about to be overwritten without anyone noticing. One (the loupe over a redaction)
would have broken a guarantee the code comments state explicitly.

The clearest signal in the whole review came from two voices that never saw each
other's work reaching the same place from opposite ends: the design voice, from
counting visual states, and the engineering voice, from reading `flatten()`, both
concluded that chrome leaks into the export and nothing tests otherwise. Neither
had the other's context. That agreement is worth more than either finding alone,
and it is the closest this single-model review came to cross-model evidence.

## Still open at the time of writing

- The toolbar preview. `CLAUDE.md` requires a before and after preview for a
  toolbar change, and the first draft of the plan made the preview an output
  rather than a prerequisite, which meant asking approval for work whose visible
  half was unspecified. The preview comes before the markup is touched.
- **There is no rollback.** This ships as a zip to a store whose review takes
  days, and rule 2 forbids the remote config a feature flag would need. A bug
  that ships is live for days. That is the strongest argument in the whole
  review for keeping the invariant tests honest and for landing the security fix
  as its own reviewable commit.
- `TASKS.md` T14 already asks for `src/ui/result.js` to be split before F6 and
  F27 touch it again. This work touches it again. The debt is real and is now
  written down twice.
