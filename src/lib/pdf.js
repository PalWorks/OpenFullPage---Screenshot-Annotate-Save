// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// PDF writing, by hand.
//
// There is no dependency and no build step (rule 3 in CLAUDE.md), so the file
// format is written here. It is a deliberately small subset of PDF 1.4: a
// catalogue, a page tree, and one Flate-compressed RGB image per page. Nothing
// else is needed to put a screenshot into a PDF, and every other feature is a
// surface to get wrong.
//
// WHY LOSSLESS, AND WHY NOT JPEG
//
// The obvious shortcut is to embed a JPEG, which PDF supports directly with
// /DCTDecode and which would be a dozen lines. It is rejected because this tool
// photographs text. JPEG rings around every glyph edge, and a PDF of a
// screenshot that softens the text is a worse artefact than the PNG it replaced.
// Raw RGB through /FlateDecode is lossless, and deflate is available to the page
// as CompressionStream without adding anything to the package.
//
// WHY PAGES AND NOT ONE ENORMOUS ONE
//
// A capture is often many screens tall. One page that shape is technically valid
// and practically useless: it cannot be printed and readers open it at 4%. The
// image is therefore cut into pages of its own width, no scaling and no margins,
// so nothing is resampled and the seams fall on exact pixel rows.

/** CSS pixels per PDF point. PDF units are 1/72 inch; the web assumes 96 dpi. */
export const PX_PER_POINT = 96 / 72;

/**
 * How tall a page may be relative to its width before it stops reading as a
 * page. A4, Letter and A3 all sit near this, so it is the ratio a reader expects
 * rather than an arbitrary cut.
 */
export const PAGE_RATIO = Math.SQRT2;

/** Acrobat refuses a page longer than 200 inches on either side. */
export const MAX_PAGE_POINTS = 14400;

/**
 * Cut an image into page-shaped horizontal slices.
 *
 * Nothing is padded and nothing is scaled: a capture that already reads as a
 * page produces exactly one page the size of the image.
 *
 * The count is decided first and the height is then divided as evenly as it
 * goes, rather than taking full pages off the top until the image runs out.
 * Walking it produced a final page of whatever happened to be left, which for a
 * 1700 pixel image at an 849 pixel step is a page two pixels tall: a valid PDF,
 * and an obviously broken-looking document.
 *
 * @returns {Array<{y: number, h: number}>} slices in image pixels, top to bottom
 */
export function planPdfPages(width, height, ratio = PAGE_RATIO) {
  if (!(width > 0) || !(height > 0)) throw new Error('An image needs a width and a height.');

  const byRatio = Math.max(1, Math.round(width * ratio));
  const byLimit = Math.max(1, Math.floor(MAX_PAGE_POINTS * PX_PER_POINT));
  const step = Math.min(byRatio, byLimit, height);

  const count = Math.ceil(height / step);
  const base = Math.floor(height / count);
  // The rows that do not divide evenly, one each to the pages at the top.
  const spare = height % count;

  const pages = [];
  let y = 0;
  for (let i = 0; i < count; i += 1) {
    const h = base + (i < spare ? 1 : 0);
    pages.push({ y, h });
    y += h;
  }
  return pages;
}

/**
 * zlib-wrapped deflate, which is exactly what /FlateDecode reads.
 *
 * CompressionStream is a platform API in both the browser and Node, so this
 * costs the package nothing.
 */
export async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA from a canvas becomes the RGB samples PDF wants. Alpha is dropped:
 *  the capture is composited onto white before it ever reaches here. */
export function rgbaToRgb(rgba) {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i];
    out[o + 1] = rgba[i + 1];
    out[o + 2] = rgba[i + 2];
  }
  return out;
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * Assemble the file.
 *
 * @param {Array<{width: number, height: number, data: Uint8Array}>} pages
 *   Each page's slice in image pixels, and its deflated RGB samples.
 * @param {{producer?: string}} [options]
 * @returns {Uint8Array}
 *
 * Deliberately no /Info date. The only thing a creation timestamp would add to a
 * file the user is about to share is the moment they took the screenshot, and
 * this is not a tool that puts things into your files without saying so.
 */
export function buildPdf(pages, { producer = 'OpenFullPage' } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('A PDF needs at least one page.');

  const encoder = new TextEncoder();
  const chunks = [];
  let offset = 0;

  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  };

  // Object 1 is the catalogue, 2 the page tree, then three objects per page:
  // the page, its content stream, and its image.
  const total = 2 + pages.length * 3 + 1;
  const starts = new Array(total + 1).fill(0);
  const pageObj = (i) => 3 + i * 3;

  const begin = (id) => {
    starts[id] = offset;
    push(`${id} 0 obj\n`);
  };
  const end = () => push('endobj\n');

  push('%PDF-1.4\n');
  // A comment of high bytes, which is how a reader is told the file is binary.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  end();

  begin(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${
    pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')
  }] >>\n`);
  end();

  pages.forEach((page, i) => {
    const id = pageObj(i);
    const width = round(page.width / PX_PER_POINT);
    const height = round(page.height / PX_PER_POINT);

    begin(id);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]` +
      ` /Resources << /XObject << /Im0 ${id + 2} 0 R >> >>` +
      ` /Contents ${id + 1} 0 R >>\n`,
    );
    end();

    // Place the image over the whole page. The transform is the page size, so
    // one image pixel lands on one PDF unit scaled by exactly PX_PER_POINT and
    // nothing is resampled.
    const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
    begin(id + 1);
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n`);
    push(content);
    push('endstream\n');
    end();

    begin(id + 2);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}` +
      ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode` +
      ` /Length ${page.data.length} >>\nstream\n`,
    );
    push(page.data);
    push('\nendstream\n');
    end();
  });

  const infoId = total;
  begin(infoId);
  push(`<< /Producer (${producer.replace(/([()\\])/g, '\\$1')}) >>\n`);
  end();

  // The cross reference table. Every entry is exactly twenty bytes, which is
  // the one part of this format a reader will not forgive.
  const xref = offset;
  const pad10 = (n) => String(n).padStart(10, '0');
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id += 1) table += `${pad10(starts[id])} 00000 n \n`;
  push(table);

  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
