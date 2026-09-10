// Inspect a stitched capture of the fixture page and prove the things that
// dimensions alone cannot: that the sticky header appears once, the fixed bar
// appears once, lazy content actually loaded, and every one of the 40 numbered
// bands is present exactly once and in order.
//
// A tiling bug shows up here as a duplicated or missing band; the old
// repeat-the-navbar-on-every-tile failure would show as a second header.

import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

import { encodePng } from '../../tools/lib/png.mjs';

// PNG DECODING

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buffer) {
  let offset = 8; // signature
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dest = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? dest[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      dest[i] = value & 0xff;
    }
  }

  return {
    width,
    height,
    channels,
    pixel(x, y) {
      const i = y * stride + x * channels;
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}

// FIXTURE CHECKS

const near = (a, b, tolerance = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

const HEADER = [0x43, 0x38, 0xca];
const BAR = [0x18, 0x18, 0x1b];
const ODD = [0xf4, 0xf4, 0xf5];
const EVEN = [0xe4, 0xe4, 0xe7];
const LAZY_LOADED = [0xdc, 0xfc, 0xe7];
const LAZY_MISSING = [0xfe, 0xe2, 0xe2];
const LATECOMER = [0xa1, 0x62, 0x07];

/** Rows where a colour appears in the left margin, collapsed into ranges. */
function bandsOf(img, colour, x = 4) {
  const bands = [];
  let start = null;
  for (let y = 0; y < img.height; y += 1) {
    const hit = near(img.pixel(x, y), colour);
    if (hit && start === null) start = y;
    if (!hit && start !== null) {
      bands.push([start, y - 1]);
      start = null;
    }
  }
  if (start !== null) bands.push([start, img.height - 1]);
  return bands;
}

export function verifyFixture(path) {
  const img = decodePng(readFileSync(path));
  const problems = [];
  const notes = [];

  notes.push(`image ${img.width}x${img.height}`);

  // 1. The sticky header must appear exactly once, at the very top.
  const headers = bandsOf(img, HEADER);
  if (headers.length !== 1) {
    problems.push(`sticky header appears ${headers.length} times: ${JSON.stringify(headers)}`);
  } else {
    const [from, to] = headers[0];
    if (from !== 0 || to < 55 || to > 70) problems.push(`header band is ${from}..${to}, expected 0..63`);
    else notes.push(`sticky header once at ${from}..${to}`);
  }

  // 2. The fixed cookie bar belongs to the first tile only.
  const bars = bandsOf(img, BAR);
  if (bars.length !== 1) {
    problems.push(`fixed bar appears ${bars.length} times: ${JSON.stringify(bars)}`);
  } else {
    notes.push(`fixed bar once at ${bars[0][0]}..${bars[0][1]}`);
  }

  // 2b. The latecomer is only fixed once the page has been scrolled, so tagging
  //     the page once before the walk cannot see it. It belongs in the picture
  //     where it sits at the top of the page and nowhere else. Read at the right
  //     margin, which is the only column it occupies.
  const late = bandsOf(img, LATECOMER, img.width - 10);
  if (late.length !== 1) {
    problems.push(
      `the element that turns fixed on scroll appears ${late.length} times: ${JSON.stringify(late)}`
        + ' (what is fixed is not being reconsidered as the page is walked)',
    );
  } else if (late[0][0] < 290 || late[0][1] > 375) {
    problems.push(`the latecomer sits at ${late[0][0]}..${late[0][1]}, expected about 300..360`);
  } else {
    notes.push(`the element that turns fixed on scroll appears once, at ${late[0][0]}..${late[0][1]}`);
  }

  // 3. Lazy content below the fold must have loaded during the warm-up pass.
  const loaded = bandsOf(img, LAZY_LOADED);
  const missing = bandsOf(img, LAZY_MISSING);
  if (loaded.length === 0) problems.push('lazy-loaded block never resolved');
  else notes.push(`lazy block loaded at ${loaded[0][0]}..${loaded.at(-1)[1]}`);
  if (missing.length > 0) problems.push(`lazy block still unloaded at ${JSON.stringify(missing)}`);

  // 4. Every one of the 40 bands must sit exactly where it belongs. Sampling
  //    three points inside each expected band catches a duplicated tile (the
  //    colours stop alternating) and a dropped one (they shift by 100px).
  //    Rows covered by the fixed bar are skipped rather than misread.
  const barRange = bars[0] ?? [-1, -1];
  const inBar = (y) => y >= barRange[0] && y <= barRange[1];
  let checked = 0;

  for (let k = 0; k < 40; k += 1) {
    const expected = k % 2 === 0 ? ODD : EVEN;
    const top = 64 + k * 100;
    const samples = [top + 8, top + 50, top + 92].filter((y) => !inBar(y));
    if (samples.length === 0) continue;

    for (const y of samples) {
      if (!near(img.pixel(4, y), expected)) {
        problems.push(
          `band ${k + 1} wrong at y=${y}: got ${img.pixel(4, y)}, expected ${expected} ` +
            '(a tile was duplicated, dropped or misaligned)',
        );
        break;
      }
    }
    checked += 1;
  }

  if (checked < 38) problems.push(`only ${checked} of 40 bands could be sampled`);
  else if (!problems.length) notes.push(`all ${checked} sampled bands correct and in order`);

  // 5. Nothing below the last band except the lazy block.
  if (img.height !== 4204) problems.push(`expected a 4204px tall page, got ${img.height}`);

  return { problems, notes };
}

const FRAME_A = [0xfc, 0xa5, 0xa5];
const FRAME_B = [0xf8, 0x71, 0x71];
const CROSS_A = [0x86, 0xef, 0xac];
const CROSS_B = [0x4a, 0xde, 0x80];

/** Total rows painted in any of the given colours. */
function rowsOf(img, colours, x = 4) {
  let count = 0;
  for (let y = 0; y < img.height; y += 1) {
    if (colours.some((c) => near(img.pixel(x, y), c))) count += 1;
  }
  return count;
}

/**
 * The iframe fixture. Settles what is and is not captured inside frames:
 * a same-origin frame is laid out at full height and captured entirely, while
 * a cross-origin one contributes only what is on screen.
 */
export function verifyIframes(path, { deepFrames = false } = {}) {
  const img = decodePng(readFileSync(path));
  const problems = [];
  const notes = [];

  notes.push(`image ${img.width}x${img.height}`);

  // The same-origin frame holds 10 blocks of 300px. All of it should be here.
  const sameOrigin = rowsOf(img, [FRAME_A, FRAME_B]);
  if (sameOrigin < 2900) {
    problems.push(
      `same-origin frame contributed ${sameOrigin}px, expected about 3000, ` +
        'frame expansion is not working',
    );
  } else {
    notes.push(`same-origin frame fully captured (${sameOrigin}px of 3000)`);
  }

  // The cross-origin frame is the whole point of the opt-in permission: without
  // it only the visible box appears, with it the frame is expanded like any other.
  const crossOrigin = rowsOf(img, [CROSS_A, CROSS_B]);
  if (crossOrigin === 0) {
    problems.push('cross-origin frame did not render at all');
  } else if (deepFrames) {
    if (crossOrigin < 2900) {
      problems.push(
        `advanced access is granted but the cross-origin frame contributed only ${crossOrigin}px`,
      );
    } else {
      notes.push(`cross-origin frame fully captured with advanced access (${crossOrigin}px of 3000)`);
    }
  } else if (crossOrigin > 900) {
    problems.push(
      `cross-origin frame contributed ${crossOrigin}px without advanced access, ` +
        'the opt-in permission is not gating anything',
    );
  } else {
    notes.push(`cross-origin frame limited to its visible box (${crossOrigin}px) without advanced access`);
  }

  return { problems, notes };
}

/** Nearest-neighbour thumbnail, so a human can glance at a very tall capture. */
export function thumbnail(path, out, targetWidth = 300) {
  const img = decodePng(readFileSync(path));
  const step = Math.ceil(img.width / targetWidth);
  const w = Math.floor(img.width / step);
  const h = Math.floor(img.height / step);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = img.pixel(x * step, y * step);
      rgba.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  writeFileSync(out, encodePng(rgba, w, h));
  return { out, width: w, height: h };
}

if (process.argv[1]?.endsWith('verify.mjs')) {
  const { problems, notes } = verifyFixture(process.argv[2]);
  if (process.argv[3]) console.log('  thumb', JSON.stringify(thumbnail(process.argv[2], process.argv[3])));
  for (const note of notes) console.log(`  ok   ${note}`);
  for (const problem of problems) console.log(`  FAIL ${problem}`);
  process.exitCode = problems.length ? 1 : 0;
}
