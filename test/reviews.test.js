// Review records expire, and the suite is what enforces it.
//
// docs/reviews/ holds the argument behind a change: the premise that was
// challenged, the finding that was verified against the code, the option that
// was rejected. That material is worth keeping while the work is being built
// and is noise once it has shipped, so every record carries an expiry.
//
// An expiry date that nothing reads is a comment, and a comment is not a
// promise. This is the same method as the security invariants next door: the
// document cannot quietly outlive its usefulness, because the run that happens
// on every commit will say so. What to do when one fails is written in
// docs/reviews/README.md, and "move the date" is only one of the three answers.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { REPO_ROOT } from './lib/scan.js';

const REVIEWS = join(REPO_ROOT, 'docs', 'reviews');

/** Every record in docs/reviews/, README excluded: it is the convention, not a record. */
function records() {
  if (!existsSync(REVIEWS)) return [];
  return readdirSync(REVIEWS)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => ({ name, text: readFileSync(join(REVIEWS, name), 'utf8') }));
}

// Compared as strings, not as Date objects. An ISO date sorts correctly as
// text, and going through Date would pull in the local timezone, which would
// make the suite pass or fail depending on where it runs.
const today = () => new Date().toISOString().slice(0, 10);

test('every review record declares when it expires, and on what event', () => {
  for (const { name, text } of records()) {
    const date = text.match(/^Expires:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
    assert.ok(
      date,
      `docs/reviews/${name} has no "Expires: YYYY-MM-DD" line. ` +
        'See docs/reviews/README.md.',
    );

    // The date is only a backstop. The event is the real condition, and a
    // record that names a date but no event is one nobody can retire early.
    const when = text.match(/^Expires when:\s*(\S.*)$/m);
    assert.ok(
      when,
      `docs/reviews/${name} has no "Expires when: <event>" line. ` +
        'The date is a backstop; the event is what actually retires the record.',
    );
  }
});

test('no review record has outlived its expiry', () => {
  const now = today();

  for (const { name, text } of records()) {
    const date = text.match(/^Expires:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
    if (!date) continue; // The test above owns that failure.

    const when = text.match(/^Expires when:\s*(\S.*)$/m)?.[1] ?? 'unstated';
    assert.ok(
      date >= now,
      `docs/reviews/${name} expired on ${date} (today is ${now}).\n` +
        `It was meant to be retired when: ${when}\n` +
        'Three honest answers, from docs/reviews/README.md:\n' +
        '  1. The work shipped. Fold anything durable into docs/DECISIONS.md, delete the file.\n' +
        '  2. The work is still in flight. Move the date, and say in the commit why.\n' +
        '  3. The work was abandoned. Delete the file, or move it to TODOS.md.',
    );
  }
});

test('a record that has expired is actually caught', () => {
  // The gate is tested before the thing it gates, the same way
  // invariants.test.js poisons a fixture to prove the scanner fires.
  const expired = 'Expires: 2020-01-01\nExpires when: never, this is a fixture\n';
  const date = expired.match(/^Expires:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];

  assert.equal(date, '2020-01-01');
  assert.ok(date < today(), 'the comparison that fails a stale record does not fail');
});
