// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// What the capture can be written out as, described once.
//
// Three lists used to say this: DOWNLOAD_FORMATS in settings.js decided what a
// stored preference could be, EXTENSIONS in result.js decided what the file was
// called, and the markup decided what the menu offered. Adding WebP meant
// editing all three, and a format present in two of them and absent from the
// third fails silently: a remembered preference that the menu cannot show, or a
// menu entry that sanitise() throws away on every reload.

/**
 * Every output format, in the order the download menu lists them.
 *
 * `quality` says whether the encoder takes one. PNG and PDF do not: PNG is
 * lossless by definition and the PDF path writes deflated RGB rather than going
 * through the canvas encoder at all.
 */
export const OUTPUT_FORMATS = {
  png: {
    label: 'PNG',
    extension: 'png',
    mime: 'image/png',
    quality: false,
    note: 'Lossless, larger file',
  },
  jpeg: {
    label: 'JPEG',
    extension: 'jpg',
    mime: 'image/jpeg',
    quality: true,
    note: 'Smaller file, slight loss',
  },
  webp: {
    label: 'WebP',
    extension: 'webp',
    mime: 'image/webp',
    quality: true,
    note: 'Smallest file at the same quality, and every current browser reads it',
  },
  pdf: {
    label: 'PDF',
    extension: 'pdf',
    mime: 'application/pdf',
    quality: false,
    note: 'Lossless, one page, or several if the capture is very long',
  },
};

export const DOWNLOAD_FORMATS = Object.keys(OUTPUT_FORMATS);

/** Formats whose encoder takes a quality, so the control can be offered or not. */
export const LOSSY_FORMATS = DOWNLOAD_FORMATS.filter((name) => OUTPUT_FORMATS[name].quality);

/** The file extension for a format. PNG for anything unrecognised. */
export const extensionOf = (format) => OUTPUT_FORMATS[format]?.extension ?? 'png';

/**
 * Encode a canvas, or throw saying why it could not be.
 *
 * `canvas.toBlob` reports failure by handing its callback `null`. It does not
 * throw and it does not reject, so the previous code, which wrapped it in a
 * promise and resolved whatever arrived, turned every encoding failure into a
 * `null` blob travelling on to `URL.createObjectURL`. The user saw a download of
 * the string "null", or nothing at all, and the console said nothing.
 *
 * It is not a theoretical failure. `toBlob` hands back null when the canvas
 * exceeds what the encoder can hold, which a full page capture reaches sooner
 * than anything else this extension does, and when the browser does not know
 * the mime type, which is how an unsupported format would arrive here.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} mime
 * @param {number} [quality] 0 to 1, ignored by encoders that have no quality
 * @returns {Promise<Blob>}
 */
export function encodeOrThrow(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`This capture could not be encoded as ${mime}. It may be too large for the encoder. Try PNG, or crop it first.`));
      },
      mime,
      quality,
    );
  });
}
