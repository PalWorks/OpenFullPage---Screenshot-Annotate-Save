# Making store assets by rendering, not by generating

How the screenshots and promo tiles in [store/](../store/) were produced, written
so it can be handed to an agent working on a different project.

Nothing here uses an image model. Every pixel is either a real browser rendering
an HTML file, or a real run of the software photographing itself. That is not a
limitation worked around, it is the reason the results are usable.

## Read this part first, the rest is detail

**Most "generate an image" tasks are not illustration tasks. They are rendering
tasks wearing a costume.**

A store screenshot, a promo tile, an OG image, a pricing comparison, a feature
banner, a diagram, a certificate, a social card: every one of these is type,
shapes, colour and data. All four are things CSS does exactly, at any dimension,
with legible text. An image model does none of them reliably and cannot do the
last one at all.

So the decision rule is:

| The asset is | Use |
|---|---|
| Text, UI, charts, data, layout, screenshots of real software | **Render it.** HTML plus headless Chrome. This document. |
| A photograph, a painting, a texture, a mascot, an abstract background | An image model |
| Mostly the first with a little of the second | Render it, and drop the generated piece in as one `<img>` |

An agent that reaches for a diffusion model to make a 1400x560 promo tile will
produce something that is the wrong size, has misspelled text, and shows a fake
user interface that never existed. All three are fatal for a store listing, and
the third can get a listing rejected.

## Why it works so well

Headless Chrome is an image renderer that happens to arrive on every machine.

```
HTML + CSS  ->  Chrome DevTools Protocol  ->  PNG of exact pixel dimensions
```

What you get for free by choosing it:

- **Exact dimensions.** 1400x560 means 1400x560, not "about that, resampled".
- **Perfect text.** Real fonts, real kerning, real hinting, at any size.
- **Everything CSS can do.** Gradients, shadows, blend modes, transforms, masks,
  grid, `clip-path`, SVG. That is a very large design vocabulary.
- **Free iteration.** Rendering costs a second and no money, so you can try
  fifteen variants of a headline position rather than defending the first.
- **Determinism.** The same input gives the same bytes. Assets stop drifting.
- **It is diffable.** The source of the asset is text in version control. A
  reviewer can see that a claim in a tile changed.
- **Measurable correctness.** The page can be interrogated after layout, so
  "no text is clipped" becomes a test instead of an opinion.

That last one is the biggest and most often missed. See [the guard](#4-the-guard-is-the-whole-trick).

## The pipeline

Three stages. A project that has no software to photograph skips stage two.

```
1. SUBJECT      write the thing worth photographing        (HTML, or a real app)
2. PHOTOGRAPH   drive the real software, capture it        (CDP, optional)
3. COMPOSE      put words on the photograph, render it     (HTML + CDP)
```

Keep them separate. Stage 3 must never invent anything that stage 2 did not
actually show: the composition adds a headline and a frame, and nothing else. That
separation is what makes the assets honest, and it makes them reviewable, because
the raw photographs can be committed next to the composed ones and the difference
is a diff rather than a promise.

---

## 1. The subject is most of the quality

This is where the first attempt on this project failed, and the failure is worth
describing because it is the one an agent will repeat.

The screenshot harness already existed and worked perfectly. It was pointed at the
project's end to end test fixture: a grey page of numbered bands labelled STICKY
HEADER and FIXED COOKIE BAR. The captures were technically flawless and completely
worthless, because nobody installs an extension to photograph grey bands.

**The harness was never the problem. The subject was.**

The fix was to write a page that deserves the feature being demonstrated:

- A fictional analytics report, seven screenfuls tall, so "captures the whole
  page" is visibly true rather than asserted.
- One chart with a deliberate spike in it, so the annotation demo has something
  worth pointing an arrow at.
- A table of contact details, so the redaction demo has something worth hiding.
- A consent card and a sticky header, so the hard cases the product handles are
  on screen while it handles them.

### Rules for a subject page

1. **Invent everything.** Names, companies, figures, email addresses. This will be
   published on a store listing. Never screenshot real customer data, a real
   person's name, or a real third party's branding.
2. **Make it deterministic.** No `Math.random()`, no `Date.now()`, no animation
   that has not finished. Two runs must produce identical bytes, otherwise every
   regeneration is a spurious diff.
3. **No network.** Inline the SVG, inline the CSS, use system fonts or fonts you
   ship. A subject that fetches is a subject that renders differently on a bad
   connection, and in CI renders blank.
4. **Give every feature something to do.** Walk the feature list and ask what on
   the page each one would act on. Anything with no answer needs adding to the
   page, or dropping from the asset set.
5. **Make it look like work.** Plausible density, plausible hierarchy, plausible
   dullness. A page that looks like a design mockup reads as fake.

---

## 2. Photographing real software

Skip this stage if the asset is purely designed. Use it when the asset must show
the actual product, which for a store listing it must.

The principle: **drive the real application and capture what it really draws.**
Never mock up a picture of your own user interface, because the mockup is a claim
about the product that nothing verifies, and it silently rots the day the toolbar
moves.

Chrome DevTools Protocol drives it. `Input.dispatchMouseEvent` clicks, and
`Page.captureScreenshot` photographs.

### Aim at content, not at fractions of the canvas

The mistake to avoid is `click at 60% across, 40% down`. That is not aimed at
anything, and it lands somewhere different at every zoom level and window size.

Convert a coordinate in the subject into a coordinate in the window, then click:

```js
// ix, iy are pixels in the captured image. Returns a viewport point to click.
const at = async (ix, iy) => JSON.parse(await evaluate(cdp, session, `(() => {
  const c = document.getElementById('canvas');
  const b = c.getBoundingClientRect();
  const s = b.width / c.width;          // how the image is scaled on screen
  return JSON.stringify({
    x: Math.round(b.left + ${ix} * s),
    y: Math.round(b.top  + ${iy} * s),
  });
})()`));

// Now an arrow can be drawn onto the revenue spike rather than near it.
await drag(await at(1010, 772), await at(716, 580));
```

Because the subject page is fixed and deterministic, image coordinates are stable
forever. Find them once by rendering the subject at full height and reading the
pixel positions off it.

### Hide the parts of your own product that are not the point

Overlays, onboarding hints, minimap panes and debug readouts will photobomb.
Suppress them the way the product itself suppresses them, through its real state,
not by reaching in and setting `style.display = 'none'`.

On this project the overview pane kept coming back, because setting `hidden` was
undone the next time the user scrolled. The fix was to set the same flag the
product's own settings page sets:

```js
pane.dataset.off = 'yes';   // the product's real switch, which sticks
pane.hidden = true;         // and the immediate effect
```

**If a thing reappears after you hide it, you hid it in the wrong place.**

---

## 3. Composing: putting words on a photograph

Now the useful part, and the part most agents do not think of.

Write the finished asset as an HTML page. Inline the photograph into it as a
`data:` URI. Render that page at exact dimensions. The composed asset is a text
file in version control that produces a PNG.

```js
const raw = readFileSync('raw/shot-capture.png').toString('base64');

const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; }
  body { width:1280px; height:800px; overflow:hidden;
         background:linear-gradient(160deg,#101e1c,#0c6f61);
         font:400 16px/1.4 Inter, system-ui, sans-serif; color:#eaf4f1; }
  h1   { position:absolute; left:64px; top:56px; margin:0;
         font-size:44px; font-weight:800; letter-spacing:-0.02em; max-width:15ch; }
  img  { position:absolute; left:160px; top:190px; width:960px;
         border-radius:10px; box-shadow:0 30px 70px rgb(0 0 0 / .45); }
</style>
<h1>The whole page, in one image</h1>
<img src="data:image/png;base64,${raw}">`;
```

Things worth knowing:

- **`data:` URIs keep it to one file** with no relative path problems. Use a
  `file://` URL instead when the asset pulls in several local files, so relative
  `src` and `@font-face` resolve normally.
- **Bleed is free.** `overflow:hidden` on a body of exact size lets an element run
  off the edge, which is what makes a tile look designed rather than boxed.
- **Wait for fonts.** `await document.fonts.ready` before capturing. A tile shot
  before its webfont arrives renders in the fallback and looks fine, just wrong.
  This is the most common silent failure in the whole method.
- **Try the variants.** Rendering is cheap, so write two or three designs and a
  `--all` flag that renders every one of them into a folder, then look at them
  side by side. Deciding from three real tiles beats defending the first idea.

---

## 4. The guard is the whole trick

An asset pipeline without a guard will eventually ship a tile with a clipped word
in it, and nobody will notice until a reviewer does.

Because the asset is a live page at capture time, it can be asked whether it is
correct. Do not eyeball it. Measure it.

```js
const NOTHING_CLIPPED = `(() => {
  const bad = [];
  const W = document.documentElement.clientWidth;
  const H = document.documentElement.clientHeight;
  for (const el of document.querySelectorAll('h1,h2,p,span,li')) {
    if (!el.textContent.trim() || el.children.length) continue;
    const r = el.getBoundingClientRect();
    if (r.right > W + 0.5 || r.bottom > H + 0.5 || r.left < -0.5 || r.top < -0.5) {
      bad.push(JSON.stringify(el.textContent.trim().slice(0, 30)) + ' falls outside the tile');
    }
  }
  return bad;
})()`;
```

Return a non-empty array and the render fails loudly. On this project that guard
caught a promo tile whose footer was sliced off, before the PNG was ever opened.

Worth guarding, in rough order of how often each one bites:

- No text outside the canvas, and none clipped by it.
- The headline does not overlap the screenshot or the frame.
- Contrast of every text colour against what is behind it clears 4.5:1.
- The output file is exactly the dimensions the store demands.
- Every `<img>` on the page actually loaded (`naturalWidth > 0`).
- No text is below the minimum legible size at the store's display scale.

---

## The renderer

Complete and dependency free. This is tested: it produced a tile at exactly
1400x560, rendered a 4,886px page at full height, and its guard correctly rejected
a deliberately squeezed layout.

```js
/**
 * Render an HTML file to a PNG of exact pixel dimensions, using headless Chrome.
 *
 *   node render.mjs card.html card.png 1400 560
 *   node render.mjs page.html page.png 1280 full
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME =
  process.env.CHROME_BIN ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));

const DEBUG_PORT = 9222 + (process.pid % 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      if (frame.method) return;
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      frame.error ? waiter.reject(new Error(frame.error.message)) : waiter.resolve(frame.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

/**
 * `check` is an expression evaluated in the page after layout. Return an array of
 * strings from it and the render fails with them.
 */
export async function render(htmlPath, outPath, { width, height, scale = 1, check = null, settle = 350 } = {}) {
  if (!CHROME) throw new Error('no Chrome found. Set CHROME_BIN.');

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=/tmp/render-${process.pid}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(150);
      try {
        target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl;
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('Chrome never opened its debugging port');

    const cdp = await Cdp.connect(target);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);

    const full = height === 'full';
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: full ? 1000 : height, deviceScaleFactor: scale, mobile: false,
    }, sessionId);

    // A file:// URL rather than Page.setDocumentContent, so relative <img src>,
    // stylesheets and fonts beside the HTML resolve the way the author meant.
    await cdp.send('Page.navigate', { url: pathToFileURL(resolve(htmlPath)).href }, sessionId);
    await sleep(settle);

    // Wait for fonts and images rather than guessing at a sleep. A tile rendered
    // before its webfont arrives fails silently: it looks fine, in the wrong face.
    await cdp.send('Runtime.evaluate', {
      expression: `Promise.all([
        document.fonts.ready,
        ...[...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })),
      ])`,
      awaitPromise: true,
    }, sessionId);

    if (check) {
      const res = await cdp.send('Runtime.evaluate', {
        expression: check, returnByValue: true, awaitPromise: true,
      }, sessionId);
      const problems = res.result.value ?? [];
      if (problems.length) throw new Error(`${htmlPath} failed its own check:\n  ${problems.join('\n  ')}`);
    }

    let clip;
    if (full) {
      const { cssContentSize } = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
      clip = { x: 0, y: 0, width, height: Math.ceil(cssContentSize.height), scale };
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: clip.height, deviceScaleFactor: scale, mobile: false,
      }, sessionId);
      await sleep(120);
    } else {
      clip = { x: 0, y: 0, width, height, scale };
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', clip, captureBeyondViewport: true,
    }, sessionId);

    writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    return { width: clip.width * scale, height: clip.height * scale };
  } finally {
    chrome.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , html, out, w = '1280', h = '800'] = process.argv;
  if (!html || !out) {
    console.error('usage: node render.mjs <in.html> <out.png> [width] [height|full]');
    process.exit(1);
  }
  const size = await render(html, out, { width: Number(w), height: h === 'full' ? 'full' : Number(h) });
  console.log(`${out}  ${size.width}x${size.height}`);
}
```

---

## Things that will go wrong

| Symptom | Cause | Fix |
|---|---|---|
| Text is in the wrong typeface | Captured before the webfont loaded | `await document.fonts.ready` before capturing |
| The image is blank or partly drawn | Captured before images decoded | Await every `img` that is not `complete` |
| Output is the right shape, wrong pixels | Device scale factor is not 1 | `--force-device-scale-factor=1` and set `deviceScaleFactor` |
| A scrollbar appears down the edge | Chrome drew one | `--hide-scrollbars` |
| Full page capture cuts off | Viewport never grew to the content | `Page.getLayoutMetrics`, resize, then `captureBeyondViewport: true` |
| A hidden panel keeps coming back | Hidden in the DOM, not in the app's state | Set the flag the app itself sets |
| Every run differs | Random data, timestamps, unfinished animation | Make the subject deterministic |
| `EADDRINUSE` on the debug port | A previous Chrome is still holding it | Derive the port from the pid; kill in a `finally` |
| Headless renders differently from real | A headless-only default | Compare once with `--headless=new` against a real window |
| Fonts differ between machines | System fonts vary | Ship the font file and `@font-face` it |

## The checks worth keeping

Do not claim an asset is right. Check it:

```bash
file store/screenshots/*.png            # exact dimensions, one line each
```

- Dimensions match the store's requirement exactly.
- The raw photographs are committed beside the composed assets, so the difference
  between what was captured and what was published is reviewable.
- Regenerating produces identical bytes. If it does not, something is not
  deterministic and will drift.
- Nothing on any asset is a real person, a real company, or real data.
- Every factual claim in the text on the asset is true of the shipped version.

## Chrome Web Store dimensions

Exact, and enforced on upload.

| Asset | Size | Notes |
|---|---|---|
| Screenshot | 1280x800 or 640x400 | Up to 5. 1280x800 unless you have a reason |
| Small promo tile | 440x280 | The one most people see, in search results |
| Marquee promo tile | 1400x560 | Only for featuring, but make it anyway |
| Icon | 128x128 | |

Treat the small tile and the marquee as hooks, not as feature lists. Their only
job is to earn the click; the screenshots on the listing page do the selling. A
tile crammed with five benefits converts worse than one that says one thing in
large type.

---

## The implementation in this repository

| File | What it is |
|---|---|
| [store/demo/report.html](../store/demo/report.html) | The subject. Invented analytics report, 4,886px tall, deterministic, no network |
| [test/e2e/run.mjs](../test/e2e/run.mjs) `--market` | Stage 2. Drives the real extension over CDP and writes `store/screenshots/raw/` |
| [tools/make-shots.mjs](../tools/make-shots.mjs) | Stage 3 for the five 1280x800 store screenshots |
| [tools/make-promo.mjs](../tools/make-promo.mjs) | Stage 3 for both promo tiles. Three designs, `--all` renders every one |

```bash
node test/e2e/run.mjs --market     # photograph
node tools/make-shots.mjs          # compose the screenshots
node tools/make-promo.mjs          # compose the tiles
node tools/make-promo.mjs --all /tmp/tiles   # every design, for comparison
```

The only requirement outside this repository is a Chrome or Chromium binary. No
API key, no network, no package install, which is the same standard the extension
itself is held to.
