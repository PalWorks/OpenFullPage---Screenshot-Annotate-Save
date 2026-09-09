# Review records

A review record is the argument behind a change, kept only while the argument is
still live.

[DECISIONS.md](../DECISIONS.md) holds what was decided and why, permanently, in
one or two paragraphs. That is the right length for a decision someone will read
in two years. It is the wrong length for the reasoning that produced it: the
premise that turned out to be wrong, the finding that changed the plan, the
option that was rejected and the reason it was rejected. That material is
valuable while the work is being built and is noise once it has shipped.

So it lives here, and it expires.

## The expiry rule

Every file in this directory carries two lines near the top:

```
Expires: YYYY-MM-DD
Expires when: <the event that makes this record redundant>
```

`Expires when` is the real condition. The date is a backstop for when the event
never happens, which is the usual way a document rots.

**The date is enforced.** `test/reviews.test.js` reads every record in this
directory and fails once the date has passed. A review record cannot quietly
outlive its usefulness, because the suite that runs on every commit will say so.
This is the same method as the rest of the repository: a promise that nothing
checks is not a promise.

## What to do when a record expires

Not "extend the date". The failing test is asking a question, and there are
three honest answers:

1. **The work shipped.** Fold anything durable into
   [DECISIONS.md](../DECISIONS.md) as a numbered record, then delete the file.
   This is the normal ending.
2. **The work is still in flight.** Move the date, and say in the commit message
   why the original estimate was wrong. That is information worth having.
3. **The work was abandoned.** Delete the file. If the reasoning is worth
   keeping, it belongs in [../../TODOS.md](../../TODOS.md) as a deferred item
   with its context, which is what that file is for.

## What belongs in a record

The parts of a review that a summary destroys:

- The premise that was challenged, and how it was resolved.
- Findings that were **verified against the code**, with file and line, and
  findings that were only asserted. The difference matters more than the finding.
- Decisions taken, and the option that was rejected.
- What was deferred, and to where.
- Which voices ran, and which were unavailable. A review with one voice is not
  the same evidence as a review with two, and the record should not flatter
  itself later.
