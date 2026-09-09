// PDF writing. The format is written by hand (no dependencies, rule 3), so the
// structure a reader depends on is asserted here rather than assumed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

import {
  MAX_PAGE_POINTS,
  PAGE_RATIO,
  PX_PER_POINT,
  buildPdf,
  deflate,
  planPdfPages,
  rgbaToRgb,
} from '../src/lib/pdf.js';

const text = (bytes) => Buffer.from(bytes).toString('latin1');

test('an image that already reads as a page becomes exactly one page', () => {
  const pages = planPdfPages(1000, 900);
  assert.deepEqual(pages, [{ y: 0, h: 900 }]);
});

test('a long capture is cut into pages of its own width, with no padding', () => {
  const width = 1000;
  const height = 5000;
  const pages = planPdfPages(width, height);

  const step = Math.round(width * PAGE_RATIO);
  assert.equal(pages.length, Math.ceil(height / step));
  // Every row of the image appears on exactly one page, in order.
  assert.equal(pages[0].y, 0);
  for (let i = 1; i < pages.length; i += 1) {
    assert.equal(pages[i].y, pages[i - 1].y + pages[i - 1].h);
  }
  assert.equal(pages.at(-1).y + pages.at(-1).h, height);
  for (const page of pages) assert.ok(page.h <= step, `${page.h} is taller than a page`);
});

/**
 * The bug this is here for: taking full pages off the top until the image runs
 * out left the remainder on the last page, which for 1700 pixels at an 849 pixel
 * step is a page two pixels tall. Valid PDF, obviously broken document.
 */
test('no page is a sliver: the height is divided evenly, not taken off the top', () => {
  for (const [width, height] of [[600, 1700], [1265, 4204], [800, 1131], [1000, 5001]]) {
    const pages = planPdfPages(width, height);
    const heights = pages.map((page) => page.h);
    const spread = Math.max(...heights) - Math.min(...heights);
    assert.ok(spread <= 1, `${width}x${height} produced pages ${heights.join(', ')}`);
    assert.equal(heights.reduce((a, b) => a + b, 0), height, `${width}x${height} lost rows`);
  }
});

test('an image one pixel taller than a page still becomes two sensible pages', () => {
  const pages = planPdfPages(100, Math.round(100 * PAGE_RATIO) + 1);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p) => p.h), [71, 71]);
});

test('no page can exceed what a reader will open', () => {
  const limit = Math.floor(MAX_PAGE_POINTS * PX_PER_POINT);
  // Wide enough that the ratio alone would ask for a page past the limit.
  for (const page of planPdfPages(20000, 60000)) assert.ok(page.h <= limit, `${page.h}`);
});

test('a zero sized image is refused rather than written', () => {
  assert.throws(() => planPdfPages(0, 100));
  assert.throws(() => planPdfPages(100, 0));
});

test('alpha is dropped, and the colour channels keep their order', () => {
  const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]);
  assert.deepEqual([...rgbaToRgb(rgba)], [1, 2, 3, 4, 5, 6]);
});

test('the image survives the round trip through FlateDecode', async () => {
  const samples = new Uint8Array(300).map((_, i) => (i * 7) % 256);
  const packed = await deflate(samples);
  assert.deepEqual([...inflateSync(Buffer.from(packed))], [...samples]);
});

test('the file a reader is handed has the structure a reader expects', async () => {
  const width = 4;
  const height = 3;
  const data = await deflate(new Uint8Array(width * height * 3).fill(200));
  const bytes = buildPdf([{ width, height, data }]);
  const body = text(bytes);

  assert.ok(body.startsWith('%PDF-1.4\n'), 'no header');
  assert.ok(body.endsWith('%%EOF\n'), 'no trailer');
  assert.ok(body.includes('/Type /Catalog'), 'no catalogue');
  assert.ok(body.includes('/Type /Pages /Count 1'), 'no page tree');
  assert.ok(body.includes(`/Width ${width} /Height ${height}`), 'the image is the wrong size');
  assert.ok(body.includes('/Filter /FlateDecode'), 'the image is not declared compressed');

  // The page is the image at 96 dpi, so 4 x 3 pixels is 3 x 2.25 points.
  assert.ok(body.includes('/MediaBox [0 0 3 2.25]'), `wrong MediaBox in: ${body.slice(0, 400)}`);
});

/**
 * The cross reference table is the one part of this format a reader will not
 * forgive, and a wrong offset produces a file that opens in one viewer and not
 * another. So: parse it back and check every entry points at its own object.
 */
test('every cross reference entry points at the object it claims', async () => {
  const data = await deflate(new Uint8Array(12).fill(1));
  const bytes = buildPdf([
    { width: 2, height: 2, data },
    { width: 2, height: 2, data },
  ]);
  const body = text(bytes);

  const at = body.lastIndexOf('startxref\n');
  const start = Number(body.slice(at + 'startxref\n'.length).split('\n')[0]);
  assert.equal(body.slice(start, start + 4), 'xref');

  const [, countLine] = body.slice(start).split('\n');
  const size = Number(countLine.split(' ')[1]);
  // Two pages: catalogue, page tree, three objects each, and the info record.
  assert.equal(size, 2 + 2 * 3 + 1 + 1);

  // Entry 0 is the free head of the chain, so object N is the N-th entry along.
  const table = body.slice(start + `xref\n0 ${size}\n`.length);
  for (let id = 1; id < size; id += 1) {
    const entry = table.slice(id * 20, (id + 1) * 20);
    assert.match(entry, /^\d{10} 00000 n \n$/, `entry ${id} is malformed: ${JSON.stringify(entry)}`);
    const offset = Number(entry.slice(0, 10));
    assert.equal(
      body.slice(offset, offset + `${id} 0 obj`.length),
      `${id} 0 obj`,
      `entry ${id} points at ${JSON.stringify(body.slice(offset, offset + 20))}`,
    );
  }
});

test('a producer with brackets in it cannot break out of the string', () => {
  const bytes = buildPdf([{ width: 1, height: 1, data: new Uint8Array([1]) }], {
    producer: 'a (b) \\ c',
  });
  assert.ok(text(bytes).includes('/Producer (a \\(b\\) \\\\ c)'));
});

test('a PDF with no pages is refused', () => {
  assert.throws(() => buildPdf([]));
});
