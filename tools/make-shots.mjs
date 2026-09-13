// Compose the Chrome Web Store screenshots.
//
// The store shows five 1280x800 pictures in a carousel, and they are the only
// part of a listing anyone looks at closely. A raw screenshot of the editor is
// honest and says nothing: a reader three seconds into a search result cannot
// tell what they are looking at, because the interesting thing about the picture
// is what the product just did, and a still picture of a toolbar does not say.
//
// So each one is a real screenshot with a sentence over it. The pixels underneath
// come from test/e2e/run.mjs --market, which drives the real extension in real
// Chrome over a real capture of store/demo/report.html. Nothing here redraws the
// product or mocks up an interface that does not exist. It crops what the harness
// photographed and puts a headline above it.
//
//   node test/e2e/run.mjs --market --shots store/screenshots/raw   # photograph
//   node tools/make-shots.mjs                                      # compose
//
// Not byte reproducible, and deliberately not claimed to be, for the same reason
// as tools/make-promo.mjs: Chrome renders text with the host's fonts. What is
// guaranteed is that the design has a source and the screenshot is real.
//
// Set FPC_CHROME if Chrome is somewhere unusual.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, until } from '../test/e2e/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SHOTS = join(REPO, 'store', 'screenshots');
const RAW = join(SHOTS, 'raw');
const DEBUG_PORT = 9336; // not 9333 or 9335: the e2e suite and make-promo own those.

const CHROME =
  process.env.FPC_CHROME ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p));

// The same two teals as tools/icon-design.mjs and tools/make-promo.mjs, so the
// five screenshots, the two promo tiles and the mark in the corner of all of
// them are one colour rather than three that nearly match.
const INK = {
  ground: '#06120F',
  groundTop: '#0C2721',
  tealLight: '#2FD6B8',
  cream: '#F6F1E4',
  muted: '#8FB3AA',
  chipEdge: 'rgba(143, 179, 170, 0.30)',
};

const FACE =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif';

const MARK = readFileSync(join(REPO, 'icons', 'icon128.png')).toString('base64');

/**
 * The five, in the order the store shows them.
 *
 * `mode` is how the screenshot is framed.
 *
 *   bleed   1180 wide, running off the bottom edge. Detail stays close to full
 *           size, which is what matters when the point of the picture is a
 *           pixelated email address or a menu full of file sizes.
 *   whole   960 wide, the entire 1280x800 inside the tile with nothing cut off.
 *           Only the first shot needs it: the subject there is a capture that is
 *           taller than the screen, and cropping the picture of it would be a
 *           poor way to say so.
 *
 * The headline says what the reader gets. The line under it says the thing that
 * is actually different, because every extension in this category can claim the
 * headline and most of them cannot claim the second line.
 */
const SHEET = [
  {
    file: 'shot-capture.png',
    raw: 'shot-capture.png',
    head: 'The whole page, in one image',
    sub: 'It scrolls the page for you and stitches the result. Seven screenfuls here, saved as a single picture.',
    mode: 'whole',
  },
  {
    file: 'shot-annotate.png',
    raw: 'shot-annotate.png',
    head: 'Mark up what matters',
    sub: 'Arrows, boxes, numbered steps and captions. Every mark stays an object you can move, restyle or delete.',
    mode: 'bleed',
  },
  {
    file: 'shot-redact.png',
    raw: 'shot-redact.png',
    head: 'Redaction that removes the pixels',
    sub: 'Not a blur laid over them. The exported file has no original underneath to recover.',
    mode: 'bleed',
  },
  {
    file: 'shot-save.png',
    raw: 'shot-save.png',
    head: 'PNG, JPEG, WebP or PDF',
    sub: 'It encodes the real image first, so the size beside each format is what that file would actually weigh.',
    mode: 'bleed',
  },
  {
    file: 'shot-tools.png',
    raw: 'shot-tools.png',
    head: 'Fifteen shapes, one chevron',
    sub: 'A full editor, not a cropping box. Every control can be switched off if you would rather not see it.',
    mode: 'bleed',
  },
];

/**
 * One 1280x800 store screenshot.
 *
 * The picture is 1180 wide inside a 1280 frame and runs off the bottom edge
 * rather than sitting in a box with air under it: a screenshot that is fully
 * contained reads as a thumbnail of something else, and one that bleeds reads as
 * a window onto it.
 */
function page({ head, sub, mode, shot }) {
  const whole = mode === 'whole';
  // A screenshot is 1280x800, so its height follows from the width it is shown
  // at. `whole` sizes the window to the entire picture; `bleed` sizes it to the
  // room left under the headline and lets the rest run off the tile.
  const shotWidth = whole ? 960 : 1180;
  const frame = {
    left: whole ? 160 : 50,
    top: whole ? 196 : 214,
    width: shotWidth,
    height: whole ? Math.round((shotWidth * 800) / 1280) : 586,
    radius: whole ? '12px' : '12px 12px 0 0',
  };

  return `<!doctype html><meta charset="utf-8"><style>
  *{ margin:0; padding:0; box-sizing:border-box; }
  html, body { width: 1280px; height: 800px; }
  body {
    background:
      radial-gradient(110% 130% at 10% 0%, ${INK.groundTop} 0%, ${INK.ground} 60%),
      ${INK.ground};
    font-family: ${FACE};
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    position: relative;
  }
  .brand {
    position: absolute; top: 40px; left: 50px;
    display: flex; align-items: center; gap: 11px;
  }
  .brand img { width: 30px; height: 30px; display: block; }
  .brand span { color: ${INK.muted}; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  h1 {
    position: absolute; top: 92px; left: 50px; right: 50px;
    color: ${INK.cream}; font-size: 42px; font-weight: 800;
    letter-spacing: -0.032em; line-height: 1.04; text-wrap: balance;
  }
  p.sub {
    position: absolute; top: 148px; left: 50px; width: 940px;
    color: ${INK.muted}; font-size: 18px; line-height: 1.45; letter-spacing: -0.005em;
  }
  /* The window the screenshot is seen through. Rounded at the top, square at the
     bottom, because the bottom is off the edge of the tile and a curve there
     would read as a floating card that had been cut off by accident. */
  .frame {
    position: absolute;
    left: ${frame.left}px; top: ${frame.top}px;
    width: ${frame.width}px; height: ${frame.height}px;
    border-radius: ${frame.radius};
    overflow: hidden;
    border: 1px solid ${INK.chipEdge};
    ${whole ? '' : 'border-bottom: 0;'}
    box-shadow: 0 -1px 0 rgba(255,255,255,0.05) inset, 0 24px 70px -24px rgba(0,0,0,0.75);
    background: #fff;
  }
  .frame img { position: absolute; left: 0; top: 0; width: ${shotWidth}px; display: block; }
  </style>
  <div class="brand"><img src="data:image/png;base64,${MARK}" alt=""><span>OpenFullPage</span></div>
  <h1>${head}</h1>
  <p class="sub">${sub}</p>
  <div class="frame"><img src="data:image/png;base64,${shot}" alt=""></div>`;
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

async function shoot(cdp, session, { html, file }) {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    session,
  );
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, session);
  await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, session);
  // One frame for layout, one for the decode. The screenshots are a megabyte of
  // base64 each and the first tile of a run photographed a white box without it.
  await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      if (document.fonts) await document.fonts.ready;
    })()`,
    awaitPromise: true,
  }, session);

  // The headline and the line under it must not collide with the frame, and the
  // frame must not leave the tile. Checked rather than eyeballed, because these
  // are published and a clipped headline is the sort of thing that is only ever
  // noticed after submission.
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = [];
      const frame = document.querySelector('.frame').getBoundingClientRect();
      for (const sel of ['h1', 'p.sub', '.brand']) {
        const r = document.querySelector(sel).getBoundingClientRect();
        if (r.bottom > frame.top) out.push(sel + ' overlaps the screenshot frame');
        if (r.right > 1280 || r.left < 0) out.push(sel + ' runs off the side');
      }
      const img = document.querySelector('.frame img').getBoundingClientRect();
      if (img.bottom < frame.bottom) out.push('the screenshot is shorter than its frame');
      return out.join('\\n');
    })()`,
    returnByValue: true,
  }, session);
  if (result.value) throw new Error(`${file} would ship broken:\n${result.value}`);

  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 }, captureBeyondViewport: true },
    session,
  );
  const bytes = Buffer.from(data, 'base64');
  writeFileSync(join(SHOTS, file), bytes);
  return bytes.length;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const missing = SHEET.filter((s) => !existsSync(join(RAW, s.raw))).map((s) => s.raw);
  if (missing.length) {
    throw new Error(
      `no raw screenshots for: ${missing.join(', ')}\n` +
        'Photograph them first:\n' +
        '  node test/e2e/run.mjs --market --shots store/screenshots/raw',
    );
  }

  const { child, version } = await launch();
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    for (const entry of SHEET) {
      const shot = readFileSync(join(RAW, entry.raw)).toString('base64');
      const bytes = await shoot(cdp, sessionId, {
        html: page({ ...entry, shot }),
        file: entry.file,
      });
      console.log(`store/screenshots/${entry.file}  1280x800, ${bytes} bytes`);
    }
  } finally {
    cdp.close();
    child.kill('SIGKILL');
  }
}

await main();
