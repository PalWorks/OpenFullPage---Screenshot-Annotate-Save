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
// WHAT A TILE IS FOR
//
// It is not a summary of the product. The five screenshots do that, and they are
// on the listing page, which nobody reaches by accident. A tile is what a person
// sees in a grid of tiles while scanning for something else, and its only job is
// to be opened. So: one picture, very few words, and both legible at the size a
// store grid actually renders them, which is about half of the size below.
//
// The picture is the argument. A page seven screenfuls long, shown whole, is a
// thing you cannot get from the screenshot key, and it does not need a sentence
// explaining that it is unusual. The ribbon is a real render of
// store/demo/report.html at the width the extension captures it, not a drawing
// of a page.
//
// The shipped design draws nothing over that ribbon. An annotation at the scale
// a 440 pixel tile reduces a page to is two or three pixels across, so any mark
// large enough to read is larger than the product would ever draw, and a mark
// that is not to scale is a claim about the output rather than a picture of it.
// The `band` design below does carry one drawn box and arrow, and is the only
// place in this file where a pixel is invented.
//
//   node tools/make-promo.mjs              # the chosen design, into store/promo
//   node tools/make-promo.mjs --all <dir>  # every design, to compare
//
// Not byte reproducible, and deliberately not claimed to be. Chrome renders text
// with the host's fonts and hinting, so the same source on another machine gives
// a visually identical tile with different bytes. That is why there is no
// `--check` mode here, unlike tools/make-icons.mjs, whose icons come out of a
// rasteriser in this repository and are checked byte for byte. What this file
// guarantees is that the design has a source, not that the PNG is a constant.
//
// Set FPC_CHROME if Chrome is somewhere unusual.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, until } from '../test/e2e/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT = join(REPO, 'store', 'promo');
const DEMO = join(REPO, 'store', 'demo');
const DEBUG_PORT = 9335; // not 9333 or 9336: the e2e suite and make-shots own those.
const DEMO_PORT = 8791;

// What the extension captures the demo page at, so the ribbon has the proportions
// of a real capture rather than of a browser window that happens to be open.
const CAPTURE_WIDTH = 1265;

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
  mark: '#ef4444',
};

const FACE =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/**
 * Shared chrome for every tile: the ground, the faint grid and the type rules.
 * The designs differ in what they say and how the ribbon is placed, not in the
 * colour of the paper.
 */
function shell({ width, height, grid, body, extra = '' }) {
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
  .brand { display: flex; align-items: center; }
  .brand img { display: block; }
  .brand span { color: ${INK.cream}; font-weight: 700; letter-spacing: -0.015em; }
  h1 { color: ${INK.cream}; font-weight: 800; letter-spacing: -0.035em; text-wrap: balance; }
  h1 em { font-style: normal; color: ${INK.tealLight}; }
  .foot { color: ${INK.muted}; font-family: ${MONO}; }
  /* The ribbon: a real capture of the demo page, shown whole and running off the
     tile at both ends, because a page that fits inside the frame is a page that
     did not need this extension. */
  .ribbon { position: absolute; overflow: hidden; background: #fff;
            box-shadow: 0 24px 60px -18px rgba(0,0,0,0.8); }
  .ribbon img { display: block; width: 100%; }
  /* The two marks. Drawn here, and the only invented pixels in the tile. */
  .arrow { position: absolute; }
  .box { position: absolute; border: 3px solid ${INK.mark};
         background: rgba(234, 179, 8, 0.34); border-radius: 3px; }
  ${extra}
  </style><div class="grid"></div>${body}`;
}

const brandMark = (size, word) =>
  `<div class="brand" style="gap:${Math.round(size * 0.34)}px">
     <img src="data:image/png;base64,${MARK}" alt="" style="width:${size}px;height:${size}px">
     <span style="font-size:${word}px">OpenFullPage</span>
   </div>`;

/** An arrow, drawn as SVG so it keeps its head at any size. */
const arrow = (w, h, style) => `
  <svg class="arrow" style="${style}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">
    <path d="M${w - 6} ${h - 6} L10 10" stroke="${INK.mark}" stroke-width="5" stroke-linecap="round"/>
    <path d="M6 6 L28 14 L14 28 Z" fill="${INK.mark}"/>
  </svg>`;

/**
 * Design one, "ribbon".
 *
 * The page runs off the top and the bottom of the tile and the words sit beside
 * it. The claim is made by the picture: this is one screenshot, and it does not
 * end where the screen does.
 */
const ribbonDesign = {
  small: (shot) => shell({
    width: 440, height: 280, grid: 44,
    body: `
      <div style="position:absolute; left:26px; top:22px;">${brandMark(30, 16)}</div>
      <h1 style="position:absolute; left:26px; top:84px; width:240px; font-size:41px; line-height:0.98;">
        The whole page.<br><em>One shot.</em>
      </h1>
      <div class="foot" style="position:absolute; left:26px; bottom:24px; font-size:12px;">
        Free and open source
      </div>
      <div class="ribbon" style="right:34px; top:-18px; width:136px; height:330px;
           border-radius:7px; transform:rotate(-3.5deg);">
        <img src="data:image/png;base64,${shot}" alt="">
      </div>`,
  }),
  marquee: (shot) => shell({
    width: 1400, height: 560, grid: 70,
    body: `
      <div style="position:absolute; left:64px; top:52px;">${brandMark(48, 25)}</div>
      <h1 style="position:absolute; left:64px; top:176px; width:660px; font-size:74px; line-height:0.98;">
        The whole page.<br><em>One screenshot.</em>
      </h1>
      <p style="position:absolute; left:64px; top:378px; width:600px; color:${INK.muted};
                font-size:21px; line-height:1.45;">
        Capture a page of any length, mark it up, and save it. Nothing is uploaded,
        because it has no way to upload anything.
      </p>
      <div class="foot" style="position:absolute; left:64px; bottom:44px; font-size:15px;">
        Free and open source, GPL-3.0
      </div>
      <div class="ribbon" style="right:168px; top:-56px; width:286px; height:680px;
           border-radius:12px; transform:rotate(-3.5deg);">
        <img src="data:image/png;base64,${shot}" alt="">
      </div>`,
  }),
};

/**
 * Design two, "figure".
 *
 * One number, as large as it will go. A page 4,886 pixels tall is a fact rather
 * than a claim, and a number is the one thing that reads at any size.
 */
const figureDesign = {
  small: (shot) => shell({
    width: 440, height: 280, grid: 44,
    body: `
      <div style="position:absolute; left:26px; top:22px;">${brandMark(30, 16)}</div>
      <div style="position:absolute; left:26px; top:86px;">
        <div style="color:${INK.tealLight}; font-size:64px; font-weight:800;
                    letter-spacing:-0.05em; line-height:0.9;">4,886px</div>
        <h1 style="margin-top:10px; font-size:29px; line-height:1.04; width:250px;">
          tall. One screenshot.
        </h1>
      </div>
      <div class="foot" style="position:absolute; left:26px; bottom:24px; font-size:12px;">
        Any length. No upload.
      </div>
      <div class="ribbon" style="right:30px; top:22px; width:112px; height:236px; border-radius:6px;">
        <img src="data:image/png;base64,${shot}" alt="">
      </div>`,
  }),
  marquee: (shot) => shell({
    width: 1400, height: 560, grid: 70,
    body: `
      <div style="position:absolute; left:64px; top:52px;">${brandMark(48, 25)}</div>
      <div style="position:absolute; left:64px; top:160px;">
        <div style="color:${INK.tealLight}; font-size:132px; font-weight:800;
                    letter-spacing:-0.05em; line-height:0.88;">4,886px</div>
        <h1 style="margin-top:18px; font-size:58px; line-height:1.02; width:720px;">
          tall, and still one screenshot.
        </h1>
      </div>
      <div class="foot" style="position:absolute; left:64px; bottom:44px; font-size:15px;">
        Capture, annotate, redact, save. Free and open source.
      </div>
      <div class="ribbon" style="right:120px; top:46px; width:250px; height:468px; border-radius:10px;">
        <img src="data:image/png;base64,${shot}" alt="">
      </div>`,
  }),
};

/**
 * Design three, "band".
 *
 * The words on a teal band across the picture, the way a thumbnail that has to
 * survive being shrunk usually solves it. The loudest of the three, and the one
 * that keeps the most of its meaning at a third of this size.
 */
const bandDesign = {
  small: (shot) => shell({
    width: 440, height: 280, grid: 44,
    extra: `.band { position:absolute; left:0; right:0; background:${INK.ground};
                   border-top:2px solid ${INK.tealLight}; }`,
    body: `
      <div class="ribbon" style="left:0; right:0; top:0; width:440px; height:158px;
           border-radius:0; transform:none;">
        <img src="data:image/png;base64,${shot}" alt="" style="margin-top:-14px">
      </div>
      <div class="box" style="left:44px; top:40px; width:150px; height:44px; border-width:2px;"></div>
      ${arrow(52, 52, 'left:236px; top:62px;')}
      <div class="band" style="top:158px; bottom:0; padding:16px 26px;">
        <h1 style="font-size:30px; line-height:1.02;">Screenshot the <em>whole page</em></h1>
        <div class="foot" style="margin-top:8px; font-size:12px;">
          Annotate, redact, save. Free.
        </div>
      </div>`,
  }),
  marquee: (shot) => shell({
    width: 1400, height: 560, grid: 70,
    extra: `.band { position:absolute; left:0; right:0; background:${INK.ground};
                   border-top:2px solid ${INK.tealLight}; }`,
    body: `
      <div class="ribbon" style="left:0; right:0; top:0; width:1400px; height:340px;
           border-radius:0; transform:none;">
        <img src="data:image/png;base64,${shot}" alt="" style="margin-top:-40px">
      </div>
      <div class="box" style="left:150px; top:96px; width:330px; height:96px;"></div>
      ${arrow(110, 110, 'left:640px; top:140px;')}
      <div class="band" style="top:340px; bottom:0; padding:34px 64px;">
        <div style="display:flex; align-items:center; gap:28px;">
          ${brandMark(46, 24)}
          <h1 style="font-size:52px; line-height:1.0;">Screenshot the <em>whole page</em></h1>
        </div>
        <div class="foot" style="margin-top:16px; font-size:16px;">
          Capture any length, annotate it, redact it, save as PNG, JPEG, WebP or PDF. Free and open source.
        </div>
      </div>`,
  }),
};

const DESIGNS = { ribbon: ribbonDesign, figure: figureDesign, band: bandDesign };

/** The one that ships. Change this, do not edit a PNG. */
const CHOSEN = 'ribbon';

function serveDemo(port) {
  const server = createServer((req, res) => {
    const name = req.url === '/' ? '/report.html' : req.url.split('?')[0];
    try {
      const body = readFileSync(join(DEMO, name.replace(/\.\./g, '')));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
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

/**
 * The ribbon: the demo page, whole, at the width the extension captures it.
 *
 * Rendered here rather than read off disk so the tiles cannot drift from the
 * page the screenshots are taken of. It is the same document, photographed
 * twice for two purposes.
 */
async function renderRibbon(cdp, session) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${DEMO_PORT}/` }, session);
  await until('the demo page', async () => {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.readyState === "complete" && !!document.querySelector(".kpis")',
      returnByValue: true,
    }, session);
    return result.value ? true : null;
  }, { timeoutMs: 15000 });

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'document.documentElement.scrollHeight',
    returnByValue: true,
  }, session);
  const height = result.value;

  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: CAPTURE_WIDTH, height, deviceScaleFactor: 1, mobile: false }, session);
  await cdp.send('Runtime.evaluate', {
    expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
    awaitPromise: true,
  }, session);

  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: CAPTURE_WIDTH, height, scale: 1 },
    captureBeyondViewport: true,
  }, session);
  return data;
}

async function shoot(cdp, session, { html, width, height, file, dir }) {
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false }, session);
  // setDocumentContent rather than a data: URL, because a data: URL of this size
  // is a URL long enough that Chrome has opinions about it, and the ribbon makes
  // it that size on its own.
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, session);
  await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, session);
  await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      if (document.fonts) await document.fonts.ready;
    })()`,
    awaitPromise: true,
  }, session);

  // Every word has to be inside the tile. A headline clipped by the right edge is
  // the defect this file was written to stop happening twice.
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = [];
      for (const el of document.querySelectorAll('h1, .foot, .brand span, div')) {
        if (!el.textContent.trim() || el.children.length) continue;
        const r = el.getBoundingClientRect();
        if (r.left < -1 || r.top < -1 || r.right > ${width} + 1 || r.bottom > ${height} + 1) {
          out.push('"' + el.textContent.trim().slice(0, 40) + '" is outside the tile');
        }
      }
      return out.join('\\n');
    })()`,
    returnByValue: true,
  }, session);
  if (result.value) throw new Error(`${file} would ship clipped:\n${result.value}`);

  const { data } = await cdp.send('Page.captureScreenshot',
    { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true },
    session);
  const bytes = Buffer.from(data, 'base64');
  writeFileSync(join(dir, file), bytes);
  return bytes.length;
}

async function main() {
  const allAt = process.argv.indexOf('--all');
  const dir = allAt > -1 ? process.argv[allAt + 1] : OUT;
  if (allAt > -1 && !dir) throw new Error('--all needs a directory to write to');
  mkdirSync(dir, { recursive: true });

  const server = await serveDemo(DEMO_PORT);
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

    const shot = await renderRibbon(cdp, sessionId);

    const wanted = allAt > -1 ? Object.keys(DESIGNS) : [CHOSEN];
    for (const name of wanted) {
      const design = DESIGNS[name];
      const prefix = allAt > -1 ? `${name}-` : '';
      for (const [kind, width, height] of [['small-tile-440x280', 440, 280], ['marquee-1400x560', 1400, 560]]) {
        const html = kind.startsWith('small') ? design.small(shot) : design.marquee(shot);
        const file = `${prefix}${kind}.png`;
        const bytes = await shoot(cdp, sessionId, { html, width, height, file, dir });
        console.log(`${join(dir, file).replace(`${REPO}/`, '')}  ${width}x${height}, ${bytes} bytes`);
      }
    }
  } finally {
    cdp.close();
    child.kill('SIGKILL');
    server.close();
  }
}

await main();
