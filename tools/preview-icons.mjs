// Contact sheet for eyeballing the icon at the sizes Chrome actually uses.
// 16px is where icon designs fail, so it gets shown magnified alongside 128px.
import { writeFileSync } from 'node:fs';
import { encodePng } from './lib/png.mjs';
import { render } from './icon-design.mjs';

const CELL = 136;
const LIGHT = [241, 243, 244, 255]; // Chrome light toolbar
const DARK = [41, 42, 45, 255]; // Chrome dark toolbar
const W = CELL * 4, H = CELL * 2;
const sheet = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) sheet.set(i < W * H / 2 ? LIGHT : DARK, i * 4);

function blit(src, size, scale, ox, oy) {
  for (let y = 0; y < size * scale; y++) {
    for (let x = 0; x < size * scale; x++) {
      const s = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
      const d = ((oy + y) * W + ox + x) * 4;
      const a = src[s + 3] / 255;
      for (let k = 0; k < 3; k++) sheet[d + k] = Math.round(src[s + k] * a + sheet[d + k] * (1 - a));
    }
  }
}

for (const row of [0, 1]) {
  [[128, 1], [48, 2], [32, 4], [16, 8]].forEach(([size, scale], col) => {
    blit(render(size), size, scale, col * CELL + 4, row * CELL + 4);
  });
}

const out = process.argv[2] ?? 'icon-preview.png';
writeFileSync(out, encodePng(sheet, W, H));
console.log(`${out}, 128 | 48@2x | 32@4x | 16@8x, on light and dark toolbars`);
