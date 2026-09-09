# TODOs

Work that was considered and deliberately deferred, with enough context that
picking it up in three months does not mean re-deriving the reasoning. Active work
lives in [TASKS.md](TASKS.md).

## Store listing and distribution

**What.** Screenshots, the listing copy, and the "verify it yourself" pitch as a
marketing asset rather than a doc.

**Why.** It is the step that turns a finished extension into an installed one.
Nothing else on any list here does that, and the listing is also where the
verifiability claim finally has a shipped artefact to point at.

**Pros.** It is the only item on any list here that converts work into users.
**Cons.** It is marketing, not code, and it was outside the blast radius of the plan
that generated this file.

**Context.** `store/LISTING.md` holds the current copy. The open question from
2026-09-08 is still open: the title `OpenFullPage - Capture Screen, Annotate, Save`
inverts the phrase people actually search ("screen capture", "screenshot"), and
"Screenshot" is missing entirely. The suggested alternative was
`OpenFullPage - Full Page Screenshot, Annotate & Save`.

**Effort.** M human / S with CC. **Priority.** P2. **Blocked by.** nothing.

## Keyboard accessible editing

**What.** Let a user who cannot use a pointer actually draw, move and resize.

**Why.** Today every drawing action is `pointerdown` / `pointermove` / `pointerup`
on the canvas. Tools can be selected by keyboard and then used for nothing. This is
a real accessibility gap, recorded as L14.

**Pros.** Removes a whole class of user who currently cannot use the editor at all.
**Cons.** It is a design problem, not just a code one: placing a shape without a
pointer needs a target model (a cursor, a grid, or tab-to-shape).

**Context.** The cheapest first step is arrow key nudging of an already selected
shape, because `moveShape()` in `src/lib/edit.js` already does exactly that and is
unit tested. Selection by keyboard (Tab through shapes) is the next step. Creation
by keyboard is the hard part.

**Effort.** L human / M with CC. **Priority.** P2. **Blocked by.** nothing.

## 44px touch targets

**What.** Enlarge toolbar controls from 30 x 28px to the 44px guideline.

**Why.** L15. Defensible on a desktop only extension, but it is a stated guideline
and we are not meeting it.

**Cons.** Directly worsens the toolbar density problem that task T6 exists to solve.
Doing this before T6 lands would break the layout.

**Effort.** S / S. **Priority.** P3. **Blocked by.** T6.

## `markSpecialElements` cost on very large pages

**What.** `getComputedStyle` on every element in the document, before every full
page capture (L4).

**Why.** On a 50,000 node page it is the slowest step before the walk begins.

**Cons.** The obvious alternative, a heuristic selector list, would miss elements and
reintroduce exactly the fragility that keeping it exhaustive avoids.

**Context.** Do not act on this without a measurement from a real page and a real
user report. Correctness first.

**Effort.** S / S. **Priority.** P3.

## Issue templates and discussions

**What.** GitHub issue templates, a discussions board.

**Why not now.** Solo project. Inviting contributions that cannot be serviced is
worse than not inviting them. `SECURITY.md` and `CONTRIBUTING.md` cover the two
paths that actually matter (reporting a vulnerability, and sending a change).

**Priority.** P3.
