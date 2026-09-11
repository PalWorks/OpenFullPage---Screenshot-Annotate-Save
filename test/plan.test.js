// SPDX-License-Identifier: GPL-3.0-only
//
// Tile arithmetic. The chrome.* surface cannot be unit tested, but this is
// where capture bugs actually come from, off-by-one tiling, retina scaling,
// oversized canvases, so it is isolated in src/lib/plan.js and tested here.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIMITS,
  MIN_EXPORT_SCALE,
  MIN_OUTPUT_SCALE,
  applyFilename,
  captureBasename,
  captureFilename,
  exportSize,
  fitsInViewport,
  planCapture,
} from '../src/lib/plan.js';

const page = (over = {}) => ({
  fullWidth: 1280,
  fullHeight: 4000,
  viewportWidth: 1280,
  viewportHeight: 800,
  devicePixelRatio: 1,
  ...over,
});

test('a page that fits needs one tile and no scrolling', () => {
  const m = page({ fullHeight: 700 });
  assert.ok(fitsInViewport(m));
  assert.deepEqual(planCapture(m).tiles, [{ x: 0, y: 0 }]);
});

test('tiles step by a full viewport and cover the whole page', () => {
  const plan = planCapture(page());
  assert.equal(plan.tiles.length, 5);
  assert.deepEqual(plan.tiles.at(0), { x: 0, y: 0 });
  assert.deepEqual(plan.tiles.at(-1), { x: 0, y: 3200 });
  // The last tile starts before the end, so the page is fully covered.
  assert.ok(plan.tiles.at(-1).y + 800 >= plan.height);
  assert.equal(plan.truncated, false);
});

test('a page taller than one step but not two still gets both tiles', () => {
  const plan = planCapture(page({ fullHeight: 801 }));
  assert.equal(plan.tiles.length, 2);
});

test('wide pages tile horizontally as well', () => {
  const plan = planCapture(page({ fullWidth: 3000, fullHeight: 1600 }));
  assert.deepEqual(
    plan.tiles,
    [
      { x: 0, y: 0 }, { x: 1280, y: 0 }, { x: 2560, y: 0 },
      { x: 0, y: 800 }, { x: 1280, y: 800 }, { x: 2560, y: 800 },
    ],
  );
});

test('a page that fits at full resolution is not scaled down', () => {
  const plan = planCapture(page({ fullHeight: 4000, devicePixelRatio: 2 }));
  assert.equal(plan.outputScale, 2);
  assert.equal(plan.captureScale, 2);
  assert.equal(plan.truncated, false);
});

// The bug this covers: a 20578px Guardian live blog on a retina Mac used to
// come back 40% captured, because 16384 device pixels is only 8192 CSS pixels
// at devicePixelRatio 2. Shrinking the output costs sharpness; truncating costs
// the user three fifths of what they asked for.
test('a long page is scaled down to fit rather than cut off', () => {
  const plan = planCapture(
    page({ fullWidth: 1512, fullHeight: 20578, viewportWidth: 1512, devicePixelRatio: 2 }),
  );

  assert.equal(plan.truncated, false, 'the whole page should be captured');
  assert.equal(plan.height, 20578);
  assert.ok(plan.outputScale < plan.captureScale, 'it should have been scaled down');
  assert.ok(plan.height * plan.outputScale <= LIMITS.maxSide);
  assert.ok(plan.width * plan.outputScale * plan.height * plan.outputScale <= LIMITS.maxArea);
});

test('scaling down stops at the floor, and past it the page is truncated', () => {
  const plan = planCapture(page({ fullHeight: 400000, devicePixelRatio: 2 }));
  assert.equal(plan.outputScale, MIN_OUTPUT_SCALE);
  assert.ok(plan.truncated, 'past the floor there is nothing left but to truncate');
  assert.ok(plan.height * plan.outputScale <= LIMITS.maxSide);
});

test('the output scale never exceeds the scale the page was captured at', () => {
  for (const devicePixelRatio of [0.5, 1, 1.5, 2, 3]) {
    for (const fullHeight of [700, 4000, 20000, 90000]) {
      const plan = planCapture(page({ fullHeight, devicePixelRatio }));
      assert.ok(plan.outputScale <= plan.captureScale || plan.outputScale === MIN_OUTPUT_SCALE);
      assert.ok(plan.width * plan.outputScale <= LIMITS.maxSide);
      assert.ok(plan.height * plan.outputScale <= LIMITS.maxSide);
    }
  }
});

test('the area limit is respected on wide pages, not just the side limit', () => {
  const plan = planCapture(page({ fullWidth: 8000, fullHeight: 60000, devicePixelRatio: 1 }));
  const area = plan.width * plan.outputScale * plan.height * plan.outputScale;
  assert.ok(area <= LIMITS.maxArea);
  assert.ok(plan.truncated);
});

test('truncation never produces a plan smaller than one viewport', () => {
  const plan = planCapture(page({ fullHeight: 999999, devicePixelRatio: 4 }));
  assert.ok(plan.height >= plan.tiles.length ? true : false);
  assert.ok(plan.tiles.length >= 1);
  assert.ok(plan.height >= 800);
});

test('a zero-height viewport cannot spin the tiling loop', () => {
  const plan = planCapture(page({ viewportHeight: 0, viewportWidth: 0, fullHeight: 3000 }));
  assert.ok(plan.tiles.length > 0);
  assert.ok(Number.isFinite(plan.tiles.length));
});

test('filenames carry the product, an ISO 8601 stamp, then the page URL', () => {
  const at = new Date(2026, 8, 8, 14, 23, 5);
  assert.equal(
    captureFilename({ product: 'Scrollshot', url: 'https://news.ycombinator.com/', date: at }),
    'scrollshot-20260908T142305-news-ycombinator-com.png',
  );
});

// Basic format, because the extended format's colons are illegal in filenames on
// Windows. It is still ISO 8601 and still sorts chronologically as plain text.
test('the timestamp is ISO 8601 basic format and sorts chronologically', () => {
  const url = 'https://example.com/';
  const earlier = captureFilename({ product: 'x', url, date: new Date(2026, 8, 8, 9, 4, 5) });
  const later = captureFilename({ product: 'x', url, date: new Date(2026, 8, 8, 14, 23, 5) });
  assert.match(earlier, /-20260908T090405-/);
  assert.ok(earlier < later, 'text order should follow time order');
});

test('the scheme and a leading www are dropped from the URL', () => {
  const name = captureFilename({ product: 'x', url: 'https://www.bbc.co.uk/news', date: new Date() });
  assert.ok(name.includes('bbc-co-uk-news'));
  assert.ok(!name.includes('https'));
  assert.ok(!name.includes('www'));
});

test('a page URL cannot smuggle a path into chrome.downloads', () => {
  const name = captureFilename({
    product: 'x',
    url: 'https://evil.test/../../etc/passwd\\stream:name',
  });
  for (const bad of ['/', '\\', '..', ':']) assert.ok(!name.includes(bad), bad);
  assert.match(name, /^x-\d{8}T\d{6}-[a-z0-9-]*\.png$/);
});

test('a missing product or URL still yields a usable filename', () => {
  for (const product of ['', null, undefined, '???', '   ']) {
    assert.match(captureFilename({ product, url: 'https://a.test/' }), /^capture-\d{8}T\d{6}-a-test\.png$/);
  }
  assert.match(captureFilename({ product: 'x' }), /^x-\d{8}T\d{6}-page\.png$/);
  assert.match(captureFilename(), /^capture-\d{8}T\d{6}-page\.png$/);
});

test('long product names and URLs are trimmed without a trailing separator', () => {
  const name = captureFilename({ product: 'a'.repeat(200), url: `https://b.test/${'c'.repeat(300)}` });
  // 40 product + 15 stamp + 70 site + 2 separators + 4 extension.
  assert.ok(name.length <= 131, `too long: ${name.length}`);
  assert.ok(!name.includes('--'));
});

test('the chosen download format decides the extension', () => {
  const at = new Date(2026, 8, 8, 14, 23, 5);
  const args = { product: 'x', url: 'https://a.test/', date: at };
  assert.equal(captureFilename({ ...args, extension: 'jpg' }), 'x-20260908T142305-a-test.jpg');
  assert.equal(captureFilename(args), 'x-20260908T142305-a-test.png');
});

test('a bogus extension cannot escape into the filename', () => {
  for (const bad of ['../../sh', 'png"', '', 'toolongext', null]) {
    assert.match(captureFilename({ product: 'x', url: 'https://a.test/', extension: bad }), /\.png$/);
  }
});

// The filename box is the one place a person types text that becomes a path
// handed to chrome.downloads, so it is the one place that has to assume the text
// is hostile.

test('a typed filename keeps the characters people actually want', () => {
  assert.equal(applyFilename('My Report v2', 'png'), 'My Report v2.png');
  assert.equal(applyFilename('report_2026-09-08', 'jpg'), 'report_2026-09-08.jpg');
  assert.equal(applyFilename('notes.v1.final', 'png'), 'notes.v1.final.png');
});

test('a typed filename cannot escape the download directory', () => {
  const separator = String.fromCharCode(92);
  for (const hostile of [
    '../../etc/passwd',
    `..${separator}..${separator}windows${separator}system32`,
    '/absolute/path',
    'stream:name',
    '....//....//x',
  ]) {
    const out = applyFilename(hostile, 'png');
    for (const bad of ['/', separator, ':', '..']) {
      assert.ok(!out.includes(bad), `${hostile} produced ${out}`);
    }
    assert.match(out, /^[A-Za-z0-9 ._-]+\.png$/);
  }
});

test('a typed filename cannot start with a dot and hide the file', () => {
  assert.equal(applyFilename('.bashrc', 'png'), 'bashrc.png');
  assert.equal(applyFilename('...', 'png'), 'capture.png');
});

test('an empty or unusable typed filename falls back rather than failing', () => {
  for (const empty of ['', '   ', null, undefined, '///', '???']) {
    assert.match(applyFilename(empty, 'png'), /^[A-Za-z0-9-]+\.png$/);
  }
});

test('the extension is not doubled up when the user types one', () => {
  assert.equal(applyFilename('shot.png', 'png'), 'shot.png');
  assert.equal(applyFilename('shot.png', 'jpg'), 'shot.jpg');
  assert.equal(applyFilename('shot.jpeg', 'png'), 'shot.png');
  // Only a trailing image extension is taken off, not a dot in the middle.
  assert.equal(applyFilename('v1.2.report', 'png'), 'v1.2.report.png');
});

test('a typed filename is length capped without a trailing separator', () => {
  const out = applyFilename('a'.repeat(400), 'png');
  assert.ok(out.length <= 124, `too long: ${out.length}`);
  assert.match(out, /^a+\.png$/);
});

test('a bogus extension cannot escape through the typed filename either', () => {
  for (const bad of ['../sh', 'png"', '', 'toolongext', null]) {
    assert.match(applyFilename('report', bad), /^report\.png$/);
  }
});

test('the basename and the full filename agree', () => {
  const args = { product: 'OpenFullPage', url: 'https://a.test/b', date: new Date(2026, 8, 8, 1, 2, 3) };
  assert.equal(`${captureBasename(args)}.png`, captureFilename(args));
  assert.equal(captureBasename(args), 'openfullpage-20260908T010203-a-test-b');
});

test('an export scale gives the size the file will actually be', () => {
  assert.deepEqual(exportSize(1265, 4204, 0.5), { w: 633, h: 2102, scale: 0.5 });
  assert.deepEqual(exportSize(800, 600, 1), { w: 800, h: 600, scale: 1 });
});

test('an export never upscales, because enlarging a screenshot invents detail', () => {
  assert.deepEqual(exportSize(100, 50, 2), { w: 100, h: 50, scale: 1 });
  assert.deepEqual(exportSize(100, 50, 99), { w: 100, h: 50, scale: 1 });
});

test('an export scale is clamped to something worth keeping, at both ends', () => {
  const tiny = exportSize(1265, 4204, 0.0001);
  assert.equal(tiny.scale, MIN_EXPORT_SCALE);
  assert.equal(tiny.w, 127);
});

test('a scale that would round a side away still produces a picture', () => {
  // Three pixels at a tenth is 0.3, and a canvas of width 0 throws rather than
  // encoding an empty file.
  const { w, h } = exportSize(3, 3, MIN_EXPORT_SCALE);
  assert.ok(w >= 1 && h >= 1, `rounded to ${w}x${h}`);
});

test('the scale reported back is the one that was used, not the one asked for', () => {
  // The readout shows this, so a clamp the reader cannot see would make the
  // menu say one thing and the file be another.
  assert.equal(exportSize(100, 100, 5).scale, 1);
  assert.equal(exportSize(100, 100, 0).scale, MIN_EXPORT_SCALE);
  assert.equal(exportSize(100, 100, NaN).scale, 1);
});

test('a size of nothing is treated as one pixel rather than dividing by it', () => {
  assert.deepEqual(exportSize(0, 0, 1), { w: 1, h: 1, scale: 1 });
  assert.deepEqual(exportSize(NaN, NaN, 1), { w: 1, h: 1, scale: 1 });
});
