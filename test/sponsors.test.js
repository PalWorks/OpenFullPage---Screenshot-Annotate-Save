// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// F42. The feature is a list and a link, so the tests are about what can get
// into the list and what happens while it is empty.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SPONSORS, sponsorLink, usableSponsors } from '../src/lib/sponsors.js';
import { REPO_ROOT } from './lib/scan.js';

test('it ships with nowhere to send money, so the section stays hidden', () => {
  // The plumbing and the covenant landed together. Turning it on is one entry in
  // sponsors.js, and until there is one the options page must show nothing: a
  // heading over an empty space reads as a broken page.
  assert.deepEqual(SPONSORS, []);
  assert.deepEqual(usableSponsors(), []);

  const markup = readFileSync(join(REPO_ROOT, 'src/ui/options.html'), 'utf8');
  const at = markup.indexOf('id="thanks"');
  assert.ok(at > 0, 'the options page has no donations section');
  const tag = markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at));
  assert.ok(tag.includes('hidden'), 'the donations section does not start hidden');
});

test('only an https address we chose can become a link', () => {
  const good = sponsorLink({ label: 'X', url: 'https://example.org/give', note: 'n' });
  assert.equal(good.url, 'https://example.org/give');

  // Every one of these is a way a link becomes something other than a link.
  for (const url of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>1</script>',
    'http://example.org/give',
    'chrome-extension://abc/options.html',
    'file:///etc/passwd',
    'https://example.org/give"onmouseover="x',
    'https://example.org/give<script>',
    '//example.org/give',
    '',
    null,
    undefined,
  ]) {
    assert.equal(sponsorLink({ label: 'X', url }), null, String(url));
  }
});

test('a link keeps its own label and note rather than borrowing markup', () => {
  const link = sponsorLink({ url: 'https://example.org/give' });
  assert.equal(link.label, 'Support');
  assert.equal(link.note, '');
  // Numbers and objects become strings rather than reaching the DOM as they are.
  const odd = sponsorLink({ label: 7, url: 'https://example.org/give', note: { a: 1 } });
  assert.equal(typeof odd.label, 'string');
  assert.equal(typeof odd.note, 'string');
});

test('the covenant says what the feature does, in the file that carries it', () => {
  // The amendment lands before or with the feature and never quietly afterwards.
  // This is the check that keeps those two facts attached to each other.
  const governance = readFileSync(join(REPO_ROOT, 'GOVERNANCE.md'), 'utf8');
  assert.ok(
    governance.includes('No monetisation that creates an obligation'),
    'GOVERNANCE.md still bans monetisation flatly, so the donations feature contradicts it',
  );
  for (const promise of [
    'No feature is ever gated, delayed or degraded',
    'Nothing is ever asked for inside a capture or an editor',
    'Every rupee is published',
  ]) {
    assert.ok(governance.includes(promise), `the amendment dropped: ${promise}`);
  }
});
