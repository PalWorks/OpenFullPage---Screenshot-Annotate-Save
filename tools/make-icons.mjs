// Render the shipped icon PNGs from tools/icon-design.mjs.
//
// The icons are generated, not pasted in: `node tools/make-icons.mjs --check`
// re-renders and compares, so a reviewer can confirm the committed binaries
// really are the design in this repo and not something swapped in later. CI
// runs the check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng } from './lib/png.mjs';
import { PROGRESS_SIZES, PROGRESS_STEPS, render } from './icon-design.mjs';

const SIZES = [16, 32, 48, 128];
const check = process.argv.includes('--check');
let failed = false;

function emit(relative, png) {
  const path = new URL(`../${relative}`, import.meta.url);
  if (!check) {
    writeFileSync(path, png);
    return;
  }
  // Pixels, not bytes. Deflate output at a given level differs between zlib
  // versions, so comparing whole files would report every icon as changed on a
  // machine whose zlib is not the one they were generated on. See the same
  // reasoning in test/icons.test.js.
  const onDisk = decodePng(readFileSync(path));
  const fresh = decodePng(png);
  if (
    onDisk.width !== fresh.width ||
    onDisk.height !== fresh.height ||
    !Buffer.from(onDisk.rgba).equals(Buffer.from(fresh.rgba))
  ) {
    failed = true;
    console.log(`${relative} DIFFERS FROM the design`);
  }
}

if (!check) mkdirSync(new URL('../icons/progress', import.meta.url), { recursive: true });

for (const size of SIZES) {
  emit(`icons/icon${size}.png`, encodePng(render(size), size, size));
}

// Toolbar animation: the page fills as tiles land.
for (let step = 1; step <= PROGRESS_STEPS; step += 1) {
  for (const size of PROGRESS_SIZES) {
    const png = encodePng(render(size, step / PROGRESS_STEPS), size, size);
    emit(`icons/progress/p${step}-${size}.png`, png);
  }
}

const total = SIZES.length + PROGRESS_STEPS * PROGRESS_SIZES.length;
if (failed) {
  console.error('\nCommitted icons do not match tools/icon-design.mjs. Re-run without --check.');
  process.exit(1);
}
console.log(check ? `all ${total} icons match the design` : `wrote ${total} icons`);
