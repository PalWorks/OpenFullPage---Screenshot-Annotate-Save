// Draw the two Chrome Web Store promo tiles.
//
// The store asks for a 440x280 small tile and an optional 1400x560 marquee, and
// both were previously made by hand and committed as finished pixels, with no
// source anyone could edit. That is how the small tile came to have its footer
// line cut in half by the bottom edge: there was nothing to re-render, so the
// defect could only be fixed by redrawing the whole thing.
//
// This draws them from a description instead. The tiles are ordinary HTML laid
// out by real Chrome at exactly the sizes the store wants, screenshotted over
// the DevTools protocol, and written to store/promo/.
//
// Not byte reproducible, and deliberately not claimed to be. Chrome renders text
// with the host's fonts and hinting, so the same source on another machine gives
// a visually identical tile with different bytes. That is why there is no
// `--check` mode here, unlike tools/make-icons.mjs, whose icons come out of a
// rasteriser in this repository and are checked byte for byte. What this file
// guarantees is that the design has a source, not that the PNG is a constant.
//
//   node tools/make-promo.mjs
//
// Set FPC_CHROME if Chrome is somewhere unusual.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, until } from '../test/e2e/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT = join(REPO, 'store', 'promo');
const DEBUG_PORT = 9335; // not 9333: the e2e suite owns that one.

const CHROME =
  process.env.FPC_CHROME ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p));

// The mark is the shipped icon, read off disk rather than redrawn here. Two
// drawings of the same camera would drift apart the first time one was edited.
const MARK = readFileSync(join(REPO, 'icons', 'icon128.png')).toString('base64');

// The icon's own two teals, from tools/icon-design.mjs, so the tile and the mark
// in the corner of it are the same colour rather than two greens that nearly
// match. The near-black ground is darker than either: the tile sits in a grid of
// other tiles in the store, and the dark one is the one that reads as deliberate.
const INK = {
  ground: '#06120F',
  groundTop: '#0C2721',
  teal: '#12907E',
  tealLight: '#2FD6B8',
  cream: '#F6F1E4',
  muted: '#8FB3AA',
  line: 'rgba(47, 214, 184, 0.07)',
  chipEdge: 'rgba(143, 179, 170, 0.32)',
};

const FACE =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/**
 * Shared chrome for both tiles: the ground, the faint grid, the mark and the
 * wordmark. The two differ only in scale and in how much they can say, so the
 * parts that must not drift between them live here once.
 */
function shell({ width, height, pad, markSize, wordSize, grid, body }) {
  return `<!doctype html><meta charset="utf-8"><style>
  *{ margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; }
  body {
    background:
      radial-gradient(120% 140% at 12% 0%, ${INK.groundTop} 0%, ${INK.ground} 62%),
      ${INK.ground};
    font-family: ${FACE};
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    position: relative;
  }
  /* A grid, not a texture. It says "a page, measured" without drawing anything
     literal, and at this opacity it survives the store's own JPEG recompression
     where a finer one would turn into noise. */
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, ${INK.line} 1px, transparent 1px),
      linear-gradient(to bottom, ${INK.line} 1px, transparent 1px);
    background-size: ${grid}px ${grid}px;
  }
  .inner {
    position: relative; height: 100%;
    padding: ${pad}px;
    display: flex; flex-direction: column; justify-content: space-between;
    gap: ${Math.round(pad * 0.34)}px;
  }
  .brand {
    display: flex; align-items: center; flex: 0 0 auto;
    gap: ${Math.round(markSize * 0.34)}px;
  }
  .brand img { width: ${markSize}px; height: ${markSize}px; display: block; }
  .brand span {
    color: ${INK.cream};
    font-size: ${wordSize}px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }
  h1 {
    color: ${INK.cream};
    font-weight: 800;
    letter-spacing: -0.032em;
    text-wrap: balance;
  }
  h1 em { font-style: normal; color: ${INK.muted}; }
  .chips { display: flex; flex-wrap: wrap; }
  .chip {
    font-family: ${MONO};
    color: ${INK.muted};
    border: 1px solid ${INK.chipEdge};
    border-radius: 999px;
    white-space: nowrap;
  }
  .chip b { color: ${INK.tealLight}; font-weight: 600; }
  .mono { font-family: ${MONO}; }
  .face { font-family: ${FACE}; }
  </style><div class="grid"></div><div class="inner">${body}</div>`;
}

const brand = (markSize) =>
  `<div class="brand"><img src="data:image/png;base64,${MARK}" alt=""><span>OpenFullPage</span></div>`;

/**
 * The marquee, 1400x560. It has room for the argument, so it makes it: the
 * headline says what the product does and what it refuses, and the panel beside
 * it is the proof, a network log with nothing in it. That panel is the whole
 * pitch. Anyone can open DevTools and get the same empty list.
 */
function marquee() {
  const body = `
  ${brand(52)}
  <div style="display:flex; gap:56px; align-items:center; flex:0 1 auto; min-height:0;">
    <div style="flex:1 1 0; min-width:0;">
      <h1 style="font-size:54px; line-height:1.06;">
        Screenshot the whole page.<br><em>Nothing leaves your computer.</em>
      </h1>
      <div class="chips" style="gap:12px; margin-top:28px;">
        <span class="chip" style="font-size:16px; padding:10px 18px;">Full page capture</span>
        <span class="chip" style="font-size:16px; padding:10px 18px;">Annotate and redact</span>
        <span class="chip" style="font-size:16px; padding:10px 18px;"><b>0</b> network requests</span>
      </div>
    </div>
    <div style="flex:0 0 420px;">
      <div class="mono" style="border:1px solid ${INK.chipEdge}; border-radius:14px;
                  overflow:hidden; background:rgba(6,18,15,0.72); font-size:14px;">
        <div style="display:flex; align-items:center; gap:10px; padding:14px 18px;
                    border-bottom:1px solid ${INK.chipEdge}; color:${INK.cream};">
          <span style="width:9px; height:9px; border-radius:50%;
                       background:${INK.tealLight}; display:inline-block;"></span>
          Network
        </div>
        <div style="display:flex; gap:40px; padding:11px 18px; color:${INK.muted};
                    border-bottom:1px solid ${INK.chipEdge};">
          <span>Name</span><span>Status</span><span>Type</span><span>Size</span>
        </div>
        <div class="face" style="padding:38px 18px; text-align:center;
                    color:${INK.muted}; font-size:15px; line-height:1.5;">
          No requests.<br>The extension has nowhere to send anything.
        </div>
        <div style="padding:13px 18px; border-top:1px solid ${INK.chipEdge};
                    color:${INK.muted};">
          <b style="color:${INK.tealLight};">0</b> requests
          &nbsp;&nbsp; <b style="color:${INK.tealLight};">0 B</b> transferred
        </div>
      </div>
    </div>
  </div>
  <div class="mono" style="flex:0 0 auto; font-size:15px; color:${INK.muted};">
    Free and open source, GPL-3.0
  </div>`;
  return shell({ width: 1400, height: 560, pad: 64, markSize: 52, wordSize: 26, grid: 70, body });
}

/**
 * The small tile, 440x280. It is shown at roughly a third of the marquee's width
 * and is the one that has to survive being scanned in a grid, so it carries one
 * idea and one proof and nothing else.
 *
 * The layout is a flex column with the footer pushed down by `margin-top:auto`
 * rather than positioned absolutely, which is the fix for the footer that used
 * to be cut in half: the text cannot leave the padded box, whatever the host's
 * fonts do to its measured height.
 */
function smallTile() {
  const body = `
  ${brand(38)}
  <h1 style="font-size:37px; line-height:1.1;">
    The whole page.<br><em>Nothing sent anywhere.</em>
  </h1>
  <div class="chips" style="gap:9px;">
    <span class="chip" style="font-size:13px; padding:8px 14px;"><b>0</b> network requests</span>
    <span class="chip" style="font-size:13px; padding:8px 14px;">GPL-3.0</span>
  </div>`;
  return shell({ width: 440, height: 280, pad: 28, markSize: 38, wordSize: 19, grid: 44, body });
}

async function launch() {
  if (!CHROME) throw new Error('no Chrome found, set FPC_CHROME to its path');
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const logs = [];
  child.stderr.on('data', (d) => logs.push(String(d)));

  const version = await until(
    'the devtools endpoint',
    async () => {
      try {
        const res = await globalThis.fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        return res.ok ? res.json() : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 20000 },
  ).catch((error) => {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\nchrome output:\n${logs.join('')}`);
  });

  return { child, version };
}

async function shoot(cdp, session, { html, width, height, file, padding }) {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    session,
  );
  // setDocumentContent rather than a data: URL, because a data: URL of this size
  // is a URL long enough that Chrome has opinions about it, and the base64 mark
  // makes it that size on its own.
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, session);
  await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, session);
  // One frame for layout, one for the fonts to settle. Without this the first
  // tile of a run occasionally screenshots before the mark has decoded.
  await cdp.send('Runtime.evaluate', {
    expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
    awaitPromise: true,
  }, session);
  await cdp.send('Runtime.evaluate', {
    expression: 'document.fonts ? document.fonts.ready.then(() => true) : true',
    awaitPromise: true,
  }, session);

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const pad = ${JSON.stringify(String(padding))};
      const out = [];
      for (const el of document.querySelectorAll('.inner *')) {
        if (!el.textContent.trim() && el.tagName !== 'IMG') continue;
        const r = el.getBoundingClientRect();
        const over =
          (r.top < ${padding} - 1 && 'above the top padding') ||
          (r.bottom > ${height} - ${padding} + 1 && 'below the bottom padding') ||
          (r.left < ${padding} - 1 && 'left of the padding') ||
          (r.right > ${width} - ${padding} + 1 && 'right of the padding');
        if (over) out.push(el.tagName.toLowerCase() + ' "' +
          el.textContent.trim().slice(0, 40) + '" sits ' + over +
          ' (top ' + Math.round(r.top) + ', bottom ' + Math.round(r.bottom) + ')');
      }
      return out.join('\\n');
    })()`,
    returnByValue: true,
  }, session);
  if (result.value) {
    throw new Error(`${file} would ship with content outside its padded box:\n${result.value}`);
  }

  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true },
    session,
  );
  const out = join(OUT, file);
  writeFileSync(out, Buffer.from(data, 'base64'));
  return { out, bytes: Buffer.from(data, 'base64').length };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { child, version } = await launch();
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    for (const tile of [
      { html: marquee(), width: 1400, height: 560, padding: 64, file: 'marquee-1400x560.png' },
      { html: smallTile(), width: 440, height: 280, padding: 28, file: 'small-tile-440x280.png' },
    ]) {
      const { out, bytes } = await shoot(cdp, sessionId, tile);
      console.log(`${out.replace(`${REPO}/`, '')}  ${tile.width}x${tile.height}, ${bytes} bytes`);
    }
  } finally {
    cdp.close();
    child.kill('SIGKILL');
  }
}

await main();
