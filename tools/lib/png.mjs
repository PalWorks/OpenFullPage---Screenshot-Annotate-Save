// Minimal PNG encoder + supersampling rasteriser.
//
// Build tooling, never shipped. Exists so the icons are *derived* from a text
// description in this repo rather than pasted in as opaque binaries: anyone can
// re-run tools/make-icons.mjs and diff the result against the committed PNGs.

import { deflateSync, inflateSync } from 'node:zlib';

// PNG OUTPUT

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {Uint8Array} rgba length w*h*4 */
export function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none, so the bytes stay readable
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The pixels inside a PNG, whatever it was compressed with.
 *
 * `encodePng` compresses with `deflateSync(level: 9)`, and the exact bytes zlib
 * emits at a given level differ between zlib versions. Comparing whole files
 * therefore asserts "generated on a machine with our zlib", not "draws these
 * pixels", and fails on CI for a reason that has nothing to do with the icon.
 * Reading the pixels back out lets the check mean what it is supposed to mean.
 *
 * Handles 8-bit truecolour with alpha and all five scanline filters, which is
 * everything a re-encoder is likely to produce for these icons.
 */
export function decodePng(file) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (file[i] !== signature[i]) throw new Error('not a PNG');
  }

  let width = 0;
  let height = 0;
  const idat = [];
  for (let at = 8; at + 8 <= file.length;) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('expected 8-bit RGBA');
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const rgba = new Uint8Array(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? rgba[y * stride + x - bpp] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? rgba[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dl = Math.abs(p - left);
        const du = Math.abs(p - up);
        const dul = Math.abs(p - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter}`);
      }
      rgba[y * stride + x] = value & 0xff;
    }
  }

  return { width, height, rgba };
}

// RASTERISER

export function hex(value) {
  const s = value.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * A square canvas in unit coordinates: shapes are described in 0..1 regardless
 * of output size, so one description renders correctly at 16px and 128px.
 * Colour is stored premultiplied so downsampling composites correctly at edges.
 */
export class Canvas {
  constructor(size, samples = 4) {
    this.size = size;
    this.ss = samples;
    this.dim = size * samples;
    this.buf = new Float64Array(this.dim * this.dim * 4);
  }

  /**
   * @param {(x:number,y:number)=>number} coverage unit coords -> 0..1 inside-ness
   * @param {[number,number,number]|((x:number,y:number)=>[number,number,number])} paint
   * @param {number} alpha
   */
  fill(coverage, paint, alpha = 1) {
    const { dim, buf } = this;
    const constant = typeof paint !== 'function';
    for (let py = 0; py < dim; py++) {
      const y = (py + 0.5) / dim;
      for (let px = 0; px < dim; px++) {
        const x = (px + 0.5) / dim;
        const a = coverage(x, y) * alpha;
        if (a <= 0) continue;
        const [r, g, b] = constant ? paint : paint(x, y);
        const i = (py * dim + px) * 4;
        const inv = 1 - a;
        buf[i] = r * a + buf[i] * inv;
        buf[i + 1] = g * a + buf[i + 1] * inv;
        buf[i + 2] = b * a + buf[i + 2] * inv;
        buf[i + 3] = a + buf[i + 3] * inv;
      }
    }
  }

  /** Box-downsample the supersampled buffer and un-premultiply. */
  toRgba() {
    const { size, ss, dim, buf } = this;
    const out = new Uint8Array(size * size * 4);
    const n = ss * ss;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const i = ((y * ss + sy) * dim + (x * ss + sx)) * 4;
            r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
          }
        }
        r /= n; g /= n; b /= n; a /= n;
        const o = (y * size + x) * 4;
        if (a > 0) {
          out[o] = Math.round(Math.min(255, r / a));
          out[o + 1] = Math.round(Math.min(255, g / a));
          out[o + 2] = Math.round(Math.min(255, b / a));
        }
        out[o + 3] = Math.round(Math.min(255, a * 255));
      }
    }
    return out;
  }
}

// SHAPES
// Each returns a coverage function. Edges are hard; anti-aliasing comes from
// supersampling, which keeps the shape maths trivial and exact.

export function roundedRect(x, y, w, h, r) {
  const r2 = Math.min(r, w / 2, h / 2);
  return (px, py) => {
    if (px < x || px > x + w || py < y || py > y + h) return 0;
    const cx = Math.min(Math.max(px, x + r2), x + w - r2);
    const cy = Math.min(Math.max(py, y + r2), y + h - r2);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r2 * r2 ? 1 : 0;
  };
}

/** Coverage of `shape` restricted to `clip`, used to keep bands inside a page. */
export function clipped(shape, clip) {
  return (x, y) => shape(x, y) * clip(x, y);
}

/** Everything inside `shape` except `hole`, for outlines and cut-outs. */
export function subtract(shape, hole) {
  return (x, y) => shape(x, y) * (1 - hole(x, y));
}

export function union(...shapes) {
  return (x, y) => Math.max(...shapes.map((s) => s(x, y)));
}

export function polygon(points) {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? 1 : 0;
  };
}

export function verticalGradient(top, bottom, y0 = 0, y1 = 1) {
  const a = hex(top), b = hex(bottom);
  return (_x, y) => mix(a, b, Math.min(1, Math.max(0, (y - y0) / (y1 - y0))));
}
