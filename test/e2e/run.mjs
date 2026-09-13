// End-to-end capture against real Chrome.
//
// Verifies the gates in V1-SPEC §10 steps 1-4: a real page is measured,
// prepared, tiled, stitched and saved, with sticky headers appearing once and
// below-the-fold content actually loaded.
//
// The extension is copied to a temp directory and two permissions are widened,
// because a driven browser cannot produce the user gestures they depend on:
//
//   * `downloads` moves from optional to required, chrome.permissions.request
//     needs a click.
//   * `host_permissions` is added, `activeTab` is granted per toolbar click on
//     a specific tab, and there is no way to simulate that click.
//
// Nothing else is altered and the capture path exercised is identical, but note
// what this therefore does *not* prove: that activeTab alone is sufficient in
// normal use. That is verified by hand, see docs/TESTING.md.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, evaluate, sleep, until } from './cdp.mjs';
import { planPdfPages } from '../../src/lib/pdf.js';
import { SHAPE_TOOLS } from '../../src/lib/edit.js';
import { DOWNLOAD_FORMATS, extensionOf } from '../../src/lib/encode.js';
import { TOOLBAR_BUTTONS } from '../../src/lib/settings.js';
import { PAINTS } from '../../src/lib/edit.js';
import { decodePng, thumbnail, verifyFixture, verifyIframes } from './verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CHROME =
  process.env.FPC_CHROME ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p));
const PORT = 8787;
const CROSS_ORIGIN_PORT = 8788; // a genuinely different origin, with no network
// The store demo page, served from store/demo/ rather than test/e2e/fixture/.
// --market photographs a page that will be published, and the fixture is built to
// be measured rather than looked at: grey bands and a bar that says STICKY HEADER.
// Keeping them apart means neither has to compromise for the other.
const DEMO_PORT = 8789;
const DEBUG_PORT = 9333;
const VIEWPORT = { width: 1280, height: 800 };

// Typed into the filename box by --edit. Every path separator, the traversal, and
// the reserved colon must be gone by the time it reaches disk.
const TYPED_NAME = '../../My Report: v2';
const EXPECTED_NAME = /^My Report- v2\.(png|jpg|webp|pdf)$/;

// FIXTURES

/**
 * Press Finish now while a capture is running.
 *
 * The case this exists for is the one the panel cannot tell apart from a slow
 * page: a page that will never finish loading. There is no way to fake that
 * reliably in a fixture, so this proves the mechanism instead. On a page long
 * enough to still be walking, the button appears, is pressed, and the capture
 * comes back short and says so.
 */
async function exerciseStopButton(cdp, driver, progressUrl, ok) {
  const problems = [];

  await evaluate(
    cdp,
    driver,
    `(async () => {
      const me = await chrome.tabs.getCurrent();
      await chrome.tabs.create({ url: ${JSON.stringify(progressUrl)}, windowId: me.windowId, active: false });
    })()`,
  );

  const target = await until('the progress panel to open', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'page' && t.url === progressUrl);
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  await cdp.send('Runtime.enable', {}, sessionId);

  try {
    // Hidden until a screenful has landed. Asserting that it starts hidden is
    // half the point: a button offering to finish a capture that has captured
    // nothing would hand back an empty image.
    const startsHidden = await evaluate(
      cdp,
      sessionId,
      `(() => { const b = document.getElementById('stop'); return !b || b.hidden; })()`,
    );
    if (startsHidden !== true) problems.push('Finish now was offered before any screenful had landed');
    else ok('Finish now stays hidden until there is something to finish with');

    const at = await until(
      'Finish now to appear',
      async () => {
        const state = JSON.parse(
          await evaluate(
            cdp,
            sessionId,
            `JSON.stringify({
              shown: !document.getElementById('stop').hidden,
              percent: document.getElementById('percent').textContent,
              hint: document.getElementById('hint').textContent,
            })`,
          ),
        );
        return state.shown ? state : null;
      },
      { timeoutMs: 30000, everyMs: 50 },
    ).catch(() => null);

    if (!at) {
      problems.push('Finish now never appeared during a capture of a long page');
      return problems;
    }
    ok(`Finish now appeared at ${at.percent}, well before the end`);
    if (process.env.FPC_SHOT_DIR) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const name = join(process.env.FPC_SHOT_DIR, 'progress-stoppable.png');
      writeFileSync(name, Buffer.from(data, 'base64'));
      console.log(`  shot ${name}`);
    }
    if (!/finish now/i.test(at.hint)) problems.push(`the hint did not mention finishing early: ${at.hint}`);

    await evaluate(cdp, sessionId, `document.getElementById('stop').click()`, { userGesture: true });
    const after = JSON.parse(
      await evaluate(
        cdp,
        sessionId,
        `JSON.stringify({
          disabled: document.getElementById('stop').disabled,
          hint: document.getElementById('hint').textContent,
        })`,
      ),
    );
    if (!after.disabled) problems.push('Finish now stayed clickable after it was pressed');
    else ok('pressing it disables it, so it cannot be asked twice');
    if (!/finishing/i.test(after.hint)) problems.push(`the panel did not say it was finishing: ${after.hint}`);
    else ok('the panel says it is finishing after this screen, not that it already has');
  } catch (error) {
    problems.push(`Finish now: ${error.message}`);
  } finally {
    await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
  }

  return problems;
}

/**
 * Open the progress page while a capture is running and watch it move.
 *
 * It connects after the capture has already begun, which is the case that used to
 * show 0% until the next screenful landed, so the replay of the last known
 * progress on connect is the thing most worth proving here.
 */
async function watchProgress(cdp, driver, progressUrl, ok) {
  const problems = [];

  // It has to open in the driver's own window. Anywhere else it becomes the
  // active tab of the window being captured, and captureVisibleTab then
  // photographs the progress panel instead of the page, or stalls retrying.
  await evaluate(
    cdp,
    driver,
    `(async () => {
      const me = await chrome.tabs.getCurrent();
      await chrome.tabs.create({ url: ${JSON.stringify(progressUrl)}, windowId: me.windowId, active: false });
    })()`,
  );

  const target = await until('the progress panel to open', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'page' && t.url === progressUrl);
  });
  const targetId = target.targetId;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  await until(
    'the progress page to render',
    async () => (await evaluate(cdp, sessionId, `!!document.getElementById('percent')`)) === true,
    { timeoutMs: 15000, everyMs: 100 },
  );

  const read = async () =>
    JSON.parse(
      await evaluate(
        cdp,
        sessionId,
        `JSON.stringify({
          state: document.body.dataset.state ?? 'loading',
          percent: document.getElementById('percent').textContent,
          what: document.getElementById('what').textContent,
          title: document.getElementById('page').textContent,
          bar: document.getElementById('bar').style.width,
          fill: document.getElementById('filled').style.height,
        })`,
      ),
    );

  try {
    const moving = await until(
      'the progress panel to report a live capture',
      async () => {
        const s = await read();
        // Only a real message counts. The initial markup must not pass for one.
        return s.state === 'progress' ? s : null;
      },
      { timeoutMs: 30000, everyMs: 150 },
    );
    ok(`progress panel joined mid capture at ${moving.percent} (${moving.what})`);

    if (process.env.FPC_SHOT_DIR) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const name = join(process.env.FPC_SHOT_DIR, 'progress.png');
      writeFileSync(name, Buffer.from(data, 'base64'));
      console.log(`  shot ${name}`);
    }
    if (!moving.title) problems.push('the progress panel never showed the page title');
    else ok(`it named the page being captured (${moving.title.slice(0, 30)})`);

    const seen = [];
    const done = await until(
      'the progress panel to reach Done',
      async () => {
        const s = await read();
        if (seen.at(-1) !== s.state) seen.push(s.state);
        return s.state === 'done' ? s : null;
      },
      { timeoutMs: 45000, everyMs: 150 },
    ).catch((error) => {
      problems.push(`${error.message}; states seen: ${seen.join(' -> ')}`);
      return null;
    });
    if (!done) return problems;
    if (done.percent !== '100%') problems.push(`finished at ${done.percent}, not 100%`);
    else ok('it finished at 100% and said Done');
    if (done.bar !== '100%' || done.fill !== '100%') {
      problems.push(`bar ${done.bar} and fill ${done.fill} did not both reach 100%`);
    } else ok('the bar and the page fill both reached 100%');
  } catch (error) {
    problems.push(`progress panel: ${error.message}`);
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  return problems;
}

/**
 * The one thing headless cannot see: Chrome's own toolbar popup.
 *
 * `--progress` opens progress.html as an ordinary tab, which proves the panel,
 * its port and its arithmetic but says nothing about whether the panel is ever
 * put in front of the user. That part is `chrome.action.openPopup()`, it is
 * browser chrome rather than a page, and headless Chrome will not open it. So
 * this check exists, needs `--headed`, and fails if the popup does not appear.
 *
 * Without it the whole feature can stop working and every check still passes:
 * the popup opening is the promise, and until now it was only a promise.
 */
async function watchToolbarPopup(cdp, extensionId, ok) {
  const problems = [];
  const url = `chrome-extension://${extensionId}/src/ui/progress.html`;

  const target = await until(
    'Chrome to open the progress popup under the toolbar button',
    async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((t) => t.url === url);
    },
    { timeoutMs: 20000, everyMs: 100 },
  ).catch((error) => {
    problems.push(`${error.message}: chrome.action.openPopup() never produced a popup`);
    return null;
  });
  if (!target) return problems;
  ok('the toolbar popup opened by itself when the capture started');

  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  await cdp.send('Runtime.enable', {}, sessionId);

  // A popup that is open but never told anything is the same to the user as no
  // popup at all, so the check is that it counts, not merely that it exists.
  const moving = await until(
    'the popup to show live progress',
    async () => {
      const s = JSON.parse(
        await evaluate(
          cdp,
          sessionId,
          `JSON.stringify({
            state: document.body.dataset.state ?? 'loading',
            percent: document.getElementById('percent').textContent,
            what: document.getElementById('what').textContent,
          })`,
        ),
      );
      return s.state === 'progress' ? s : null;
    },
    { timeoutMs: 30000, everyMs: 150 },
  ).catch((error) => {
    problems.push(`the popup opened but never counted: ${error.message}`);
    return null;
  });
  if (moving) ok(`it counted in the popup, reaching ${moving.percent} (${moving.what})`);

  if (process.env.FPC_SHOT_DIR) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const name = join(process.env.FPC_SHOT_DIR, 'toolbar-popup.png');
    writeFileSync(name, Buffer.from(data, 'base64'));
    console.log(`  shot ${name}`);
  }

  return problems;
}

function serveFixture(port, indexName = 'index.html', root = join(HERE, 'fixture')) {
  const server = createServer((req, res) => {
    const name = req.url === '/' ? `/${indexName}` : req.url.split('?')[0];
    try {
      const body = readFileSync(join(root, name.replace(/\.\./g, '')));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function stageExtension(deepFrames) {
  const dir = mkdtempSync(join(tmpdir(), 'fpc-ext-'));
  for (const entry of ['manifest.json', 'src', 'icons']) {
    cpSync(join(REPO, entry), join(dir, entry), { recursive: true });
  }

  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // `downloads` always: every run saves. `webNavigation` only when the run is
  // meant to have advanced access, it is the flag the extension actually tests,
  // so leaving it optional simulates the default install even though the harness
  // must hold <all_urls> for captureVisibleTab to work at all.
  const granted = deepFrames ? ['downloads', 'webNavigation'] : ['downloads'];
  manifest.permissions = [...manifest.permissions, ...granted];
  manifest.optional_permissions = manifest.optional_permissions.filter(
    (p) => !granted.includes(p),
  );
  // captureVisibleTab accepts only <all_urls> or activeTab, not host patterns.
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // --stale simulates the one thing the port protocol version exists to catch:
  // Chrome replaces the service worker on an update and leaves the pages it
  // opened running the old code. The two ends cannot be made to disagree by
  // editing the shared constant, because both read the same file, so the
  // worker alone is pointed at a copy that claims a later version. The result
  // tab and the progress panel still read the real one, which is exactly the
  // shape of a new worker talking to an old page.
  if (process.argv.includes('--stale')) {
    const real = join(dir, 'src', 'lib', 'protocol.js');
    const future = readFileSync(real, 'utf8')
      .replace(/export const PROTOCOL_VERSION = \d+;/, 'export const PROTOCOL_VERSION = 999;');
    writeFileSync(join(dir, 'src', 'lib', 'protocol-future.js'), future);
    const worker = join(dir, 'src', 'background.js');
    writeFileSync(
      worker,
      readFileSync(worker, 'utf8').replace("'./lib/protocol.js'", "'./lib/protocol-future.js'"),
    );
  }

  // --frozen simulates the one failure captureVisibleTab has that nothing in
  // the pipeline can see: it hands back the last frame the compositor
  // presented, so a screenful can arrive that is the previous one, placed at
  // the new scroll position because the page really did move. It cannot be
  // provoked from outside, because it is a race inside Chrome's compositor,
  // so the worker's own capture step is made to serve the previous frame once.
  // An unrepaired build then stitches one screenful twice and drops the one
  // that should have been there, which verifyFixture reports as a duplicated
  // and a missing band.
  if (process.argv.includes('--frozen')) {
    const worker = join(dir, 'src', 'background.js');
    const shim = `globalThis.__fpcFrozen = { calls: 0, served: 0, last: null };
async function captureViewport(windowId, delay) {
  globalThis.__fpcFrozen.calls += 1;
  if (globalThis.__fpcFrozen.calls === 2 && globalThis.__fpcFrozen.last) {
    globalThis.__fpcFrozen.served += 1;
    return { dataUrl: globalThis.__fpcFrozen.last, delay };
  }
  const taken = await captureViewportForReal(windowId, delay);
  globalThis.__fpcFrozen.last = taken.dataUrl;
  return taken;
}
async function captureViewportForReal(windowId, delay) {
  let current = delay;`;
    const source = readFileSync(worker, 'utf8');
    const target = 'async function captureViewport(windowId, delay) {\n  let current = delay;';
    if (!source.includes(target)) throw new Error('--frozen cannot find the capture step to freeze');
    writeFileSync(worker, source.replace(target, shim));
  }

  return dir;
}

function stageProfile(downloadDir) {
  const dir = mkdtempSync(join(tmpdir(), 'fpc-profile-'));
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(
    join(dir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false },
      profile: { default_content_setting_values: {} },
    }),
  );
  return dir;
}

// EDITOR DRIVING

/** CDP's modifier bitmask, for drags that hold a key down. */
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * A real mouse drag, so the editor sees genuine pointer events.
 *
 * `held` is a list of modifier names. They go on every event of the drag, press
 * and moves and release alike, because that is what holding a key down looks
 * like and the editor reads the modifier off the move events.
 */
async function dragOn(cdp, session, from, to, steps = 8, held = []) {
  const modifiers = held.reduce((mask, name) => mask | (MODIFIERS[name] ?? 0), 0);
  const at = (i) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  });

  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1, modifiers }, session);
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', ...at(i), button: 'left', buttons: 1, modifiers }, session);
  }
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1, modifiers }, session);
  await sleep(120);
}

/**
 * Somewhere on the canvas that is actually on the screen, and the part of the
 * image it lands in.
 *
 * A capture is often six screens tall while the window is one, so a point given
 * as a fraction of the picture is usually below the bottom of the window, and a
 * press there does not land where it was aimed: it is clamped to the edge of the
 * window. A shape then appears somewhere else, or not at all, and a check
 * written that way can pass for a reason that has nothing to do with what it
 * says. So the box is measured now, the drag is placed inside the window, and
 * the region to read afterwards comes from the same rectangle.
 */
async function visibleSpot(cdp, session, { across = 0.3, down = 220 } = {}) {
  return JSON.parse(await evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const b = c.getBoundingClientRect();
    const s = c.width / b.width;
    const top = Math.max(b.top, 140) + 40;
    const from = { x: Math.round(b.left + b.width * 0.3), y: Math.round(top) };
    const to = {
      x: Math.round(b.left + b.width * (0.3 + ${across})),
      y: Math.round(top + ${down}),
    };
    const at = (pt) => ({ x: Math.round((pt.x - b.left) * s), y: Math.round((pt.y - b.top) * s) });
    const a = at(from);
    const z = at(to);
    return JSON.stringify({
      from,
      to,
      middle: { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) },
      scan: { x: a.x - 24, y: a.y - 24, w: (z.x - a.x) + 48, h: (z.y - a.y) + 48 },
    });
  })()`));
}

/**
 * A real right click, so the canvas menu opens the way it does for a person.
 *
 * A synthetic `contextmenu` event would prove the handler runs and nothing
 * about whether Chrome reaches it: the menu depends on the press landing on the
 * canvas and on preventDefault stopping the browser's own menu, and neither of
 * those is exercised by a dispatched event object.
 */
/**
 * Drag a range input to a value, the way a pointer would leave it.
 *
 * `input` is what a drag fires and `change` is what release fires, and a control
 * listening for only one of them answers a keyboard and not a mouse, or the
 * other way round. Both go out, so neither can be the one that was never wired.
 */
async function setRange(cdp, session, id, percent) {
  const value = await evaluate(cdp, session, `(() => {
    const slider = document.getElementById(${JSON.stringify(id)});
    if (!slider) return 'missing';
    slider.value = String(${percent});
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return slider.value;
  })()`);
  await sleep(90);
  return value;
}

async function rightClickOn(cdp, session, at) {
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', ...at, button: 'right', buttons: 2, clickCount: 1 }, session);
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', ...at, button: 'right', buttons: 0, clickCount: 1 }, session);
  await sleep(140);
}

/**
 * A real key press, the way the browser delivers one.
 *
 * `text` is what makes Chrome treat it as a character key rather than a bare
 * code, and without the virtual key code the event arrives with an empty `key`,
 * which is exactly the shape of bug a dispatched KeyboardEvent cannot find.
 */
async function pressKey(cdp, session, { key, code, vk, text = key, modifiers = 0 }) {
  const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  // No `text` with a modifier held: Chrome treats a keyDown carrying text as a
  // character being typed, and an accelerator is not a character.
  await cdp.send('Input.dispatchKeyEvent',
    { type: 'keyDown', ...common, ...(modifiers ? {} : { text }) }, session);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, session);
  await sleep(90);
}

/** Move the pointer without pressing anything, so hover handlers run. */
async function moveTo(cdp, session, at) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, buttons: 0 }, session);
  await sleep(90);
}

/**
 * A real double click, so the editor's own `dblclick` listener fires.
 *
 * `clickCount` is what makes the browser call the second press a double click,
 * and it has to be on the press and the release of both, or Chrome counts two
 * separate clicks and no `dblclick` is ever dispatched.
 */
async function doubleClickOn(cdp, session, at) {
  for (const clickCount of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount }, session);
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount }, session);
  }
  await sleep(120);
}

const canvasState = (cdp, session) =>
  evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    return JSON.stringify({
      width: c.width, height: c.height,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      undo: !document.getElementById('undo').disabled,
      redo: !document.getElementById('redo').disabled,
    });
  })()`).then(JSON.parse);

/**
 * How many pixels in a region are dark.
 *
 * "Not the colour it used to be" is not the same statement as "not drawn", and
 * the difference is exactly what a missing guard looks like: canvas ignores a
 * colour it cannot parse and keeps the one it already had, so a shape drawn with
 * no colour comes out in whatever was set last, which here is black. Counting
 * the dark pixels is how a check can tell those two apart.
 */
const countDark = (cdp, session, rect) =>
  evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const d = c.getContext('2d').getImageData(${rect.x}, ${rect.y}, ${rect.w}, ${rect.h}).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) n += 1;
    }
    return n;
  })()`);

/** How many pixels of a colour are inside a region of the canvas. */
const countColour = (cdp, session, rect, rgb) =>
  evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const d = c.getContext('2d').getImageData(${rect.x}, ${rect.y}, ${rect.w}, ${rect.h}).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - ${rgb[0]}) < 24 && Math.abs(d[i+1] - ${rgb[1]}) < 24 && Math.abs(d[i+2] - ${rgb[2]}) < 24) n++;
    }
    return n;
  })()`);

const clickButton = (cdp, session, selector) =>
  evaluate(cdp, session, `document.querySelector(${JSON.stringify(selector)}).click()`);


/**
 * The export size.
 *
 * Driven on the opened image, where the picture is a known 600 by 400 and the
 * arithmetic can be checked rather than merely observed to change.
 *
 * The check that earns its place is the last one: the measured sizes have to
 * fall when the scale does. They are cached, and the cache key used to vary
 * only by format and quality, so a scale change left the menu confidently
 * reporting the size of an image that was no longer the one about to be
 * written.
 */
async function exerciseExportSize(cdp, session, check) {
  // The slider is opt in as of 1.10.0: two sliders over one output file asked
  // the reader which one changed the size, so the second is a setting. Switch it
  // on here, and check it actually appeared, because a block that silently drove
  // a hidden control would pass by reading the values it set itself.
  // Written the way the options page writes it, and written again on each poll.
  // A single raw set of one key loses a race it cannot see: settings are saved by
  // read, modify, write over the whole object (L34), so a save already in flight
  // from the paste above finishes afterwards and puts the old value back. The
  // options page goes through the queue in src/lib/settings.js and does not have
  // this problem; a test reaching straight into storage does.
  const switchOn = () => evaluate(cdp, session,
    `new Promise((r) => chrome.storage.local.set({ exportSizeControl: true }, () => r(1)))`)
    .catch(() => 0);
  await switchOn();
  const shown = await until('the export size row to appear', async () => {
    const hidden = await evaluate(cdp, session,
      'document.getElementById("export-size")?.hidden ?? true').catch(() => true);
    if (hidden === false) return true;
    await switchOn();
    return null;
  }, { timeoutMs: 8000, everyMs: 250 }).catch(() => false);
  check(shown,
    'switching on the export size control left the row hidden, so the setting does nothing',
    'the export size row appears when the setting is switched on');

  const read = () => evaluate(cdp, session, `JSON.stringify({
    dims: document.getElementById('export-dims').textContent,
    out: document.getElementById('export-scale-out').textContent,
    png: document.querySelector('#formats [data-size="png"]').textContent,
  })`).then(JSON.parse);

  const wasOpen = await evaluate(cdp, session,
    'document.getElementById("formats").hidden === false');
  check(!wasOpen, 'the download menu was already open before the export size checks ran',
    'the download menu starts closed for the export size checks');
  if (!wasOpen) await clickButton(cdp, session, '#download');

  const settled = (label) => until(label, async () => {
    const now = await read();
    return now.png !== '…' ? now : null;
  }, { timeoutMs: 60000, everyMs: 250 });

  const full = await settled('the sizes to measure at full size');
  check(/600 by 400/.test(full.dims),
    `the readout says "${full.dims}" for a 600 by 400 picture at 100%`,
    `the readout says what the file will be, not what the slider is (${full.dims})`);

  await evaluate(cdp, session, `(() => {
    const r = document.getElementById('export-scale');
    r.value = '50';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(200);

  const half = await read();
  check(/300 by 200/.test(half.dims),
    `at 50% the readout says "${half.dims}", expected 300 by 200`,
    'halving the size halves both sides, and the readout says so');
  check(half.out === '50%', `the slider readout says "${half.out}"`, 'the slider says where it is');

  const measured = await settled('the sizes to re-measure at the smaller size');
  check(bytesOf(measured.png) < bytesOf(full.png),
    `PNG measured ${full.png} at full size and ${measured.png} at half, so the sizes are cached against the old picture`,
    `the measured sizes follow the export size (PNG ${full.png} to ${measured.png})`);

  // Put it back: the saves that follow are checked against real files.
  await evaluate(cdp, session, `(() => {
    const r = document.getElementById('export-scale');
    r.value = '100';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluate(cdp, session, 'document.body.click()');
  await sleep(200);
}

/**
 * The pen and the eraser.
 *
 * The pen rides the shape sweep for "does it draw at all", because it is in
 * SHAPE_TOOLS and the sweep is derived from that list. What the sweep cannot
 * see is the two things that make a pen a pen rather than a line, and both are
 * checked in pixels here rather than by reading the model: a model kept tidy
 * proves nothing about what landed on the canvas.
 */
async function exerciseFreehand(cdp, session, check) {
  const RED = [0xef, 0x44, 0x44];

  // Undo only until the part of the canvas this check dirtied is clean again,
  // never until the undo button goes grey. Undoing everything would reach into
  // the checks either side, which is exactly the failure TESTING.md records:
  // the loupe redaction had less to change, and the reported defect surfaced
  // three hundred lines from its cause.
  const tidy = async (scan, baseline, label) => {
    let ink = await countColour(cdp, session, scan, RED);
    for (let i = 0; i < 12 && ink > baseline + 30; i += 1) {
      await clickButton(cdp, session, '#undo');
      await sleep(140);
      ink = await countColour(cdp, session, scan, RED);
    }
    check(ink <= baseline + 30,
      `${label} survived every undo this check had (${ink} pixels left, started at ${baseline})`,
      `the ${label} block leaves the canvas the way it found it`);
  };

  await clickButton(cdp, session, '[data-pop="pop-border"]');
  await clickButton(cdp, session, '[data-paint="border"][data-colour="#ef4444"]');
  await clickButton(cdp, session, '[data-pop="pop-border"]');

  const spot = await visibleSpot(cdp, session, { across: 0.2, down: 120 });
  const box = await evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const b = c.getBoundingClientRect();
    return JSON.stringify({ left: b.left, top: b.top, scale: c.width / b.width });
  })()`).then(JSON.parse);
  const toImage = (pt) => ({
    x: Math.round((pt.x - box.left) * box.scale),
    y: Math.round((pt.y - box.top) * box.scale),
  });

  // An arc. Drawn so that a stroke which kept only its two ends would leave the
  // top of the arc empty, which is exactly what the check reads.
  const startAt = { x: spot.from.x, y: spot.from.y + 90 };
  const endAt = { x: spot.from.x + 160, y: spot.from.y + 90 };
  const rise = 80;

  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '[data-tool="pen"]');
  await sleep(150);


  // What was in these two boxes before the stroke existed. The capture
  // underneath is a real page, not a blank sheet, so "some red" is not proof.
  const midX = Math.round((startAt.x + endAt.x) / 2);
  const apexAt = toImage({ x: midX, y: startAt.y - rise });
  const chordAt = toImage({ x: midX, y: startAt.y });
  const apexWas = await countColour(cdp, session,
    { x: apexAt.x - 14, y: apexAt.y - 14, w: 28, h: 28 }, RED);
  const chordWas = await countColour(cdp, session,
    { x: chordAt.x - 10, y: chordAt.y - 6, w: 20, h: 12 }, RED);

  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', ...startAt, button: 'left', buttons: 1, clickCount: 1 }, session);
  for (let i = 1; i <= 28; i += 1) {
    const t = i / 28;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(startAt.x + (endAt.x - startAt.x) * t),
      y: Math.round(startAt.y - Math.sin(t * Math.PI) * rise),
      button: 'left',
      buttons: 1,
    }, session);
  }
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', ...endAt, button: 'left', buttons: 0, clickCount: 1 }, session);
  await sleep(300);

  // The top of the arc, where a straight line between the two ends never goes.
  const apex = apexAt;
  const chord = chordAt;
  const apexBox = { x: apex.x - 14, y: apex.y - 14, w: 28, h: 28 };
  const chordBox = { x: chord.x - 10, y: chord.y - 6, w: 20, h: 12 };
  const onApex = await countColour(cdp, session, apexBox, RED);
  const onChord = await countColour(cdp, session, chordBox, RED);

  check(onApex > apexWas + 20,
    `the freehand stroke put nothing at the top of the arc (${apexWas} pixels before, ${onApex} after), so it was flattened to a line`,
    `a freehand stroke keeps the curve it was drawn as (${apexWas} to ${onApex} pixels at the top of the arc)`);
  check(onChord <= chordWas + 20,
    `the stroke drew straight between its two ends (${chordWas} to ${onChord} pixels), which is a line and not the arc that was drawn`,
    'and draws nothing along the straight line between its ends, which is what a flattened stroke would be');

  await tidy({ x: apexBox.x - 40, y: apexBox.y - 10, w: 240, h: 160 }, 0, 'freehand');

  // Three shapes, one eraser drag across all of them, one undo to put them all
  // back. Erasing three things and needing three undos is the kind of defect
  // that reads to a user as "the undo is broken".
  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '[data-tool="rect"]');
  await sleep(120);

  const row = { y: spot.from.y + 40 };
  for (let i = 0; i < 3; i += 1) {
    const x = spot.from.x + i * 64;
    await dragOn(cdp, session, { x, y: row.y }, { x: x + 44, y: row.y + 44 }, 4);
  }
  await sleep(250);

  const a = toImage({ x: spot.from.x - 10, y: row.y - 10 });
  const z = toImage({ x: spot.from.x + 190, y: row.y + 60 });
  const scan = { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };

  const drawn = await countColour(cdp, session, scan, RED);
  check(drawn > 0, 'the three shapes to erase drew nothing', `three shapes drew ${drawn} pixels to erase`);

  await clickButton(cdp, session, '[data-tool="eraser"]');
  await sleep(150);
  await dragOn(cdp, session,
    { x: spot.from.x + 10, y: row.y + 22 },
    { x: spot.from.x + 170, y: row.y + 22 }, 28);
  await sleep(300);

  const erased = await countColour(cdp, session, scan, RED);
  check(erased === 0,
    `dragging the eraser across three shapes left ${erased} pixels behind`,
    'dragging the eraser across three shapes removes every one of them');

  await evaluate(cdp, session, `document.getElementById('undo').click()`, { userGesture: true });
  await sleep(350);
  const back = await countColour(cdp, session, scan, RED);
  check(Math.abs(back - drawn) < drawn * 0.05,
    `one undo after an eraser drag restored ${back} of ${drawn} pixels, so the drag left one undo step per shape`,
    'one undo puts back everything a single eraser drag removed');

  await tidy(scan, 0, 'eraser');
  await clickButton(cdp, session, '[data-tool="select"]');
}

/**
 * Opening an image the reader already had, rather than one we captured.
 *
 * Driven against a bare result page, which is exactly what the tab is when it
 * is opened from anywhere other than a capture. The file is built in the page
 * and delivered by a real `paste` event, because that is the whole point of the
 * paste trigger: it rides the reader's own gesture and therefore needs no
 * clipboard permission. A test that called the importer directly would prove
 * nothing about the thing that actually matters here.
 */
async function exerciseImport(cdp, session, check) {
  const state = () => evaluate(cdp, session, `JSON.stringify({
    landing: document.getElementById('landing').offsetHeight > 0,
    canvas: !document.getElementById('canvas').hidden,
    status: document.getElementById('status').textContent,
    filename: document.getElementById('filename').value,
    w: document.getElementById('canvas').width,
    h: document.getElementById('canvas').height,
    opened: (window.__opened || []).length,
    openedUrl: (window.__opened || [])[0] || '',
  })`).then(JSON.parse);

  const paste = (build) => evaluate(cdp, session, `(async () => {
    const dt = new DataTransfer();
    ${build}
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  })()`);

  const png = (name, w, h) => `
    const c = document.createElement('canvas');
    c.width = ${w}; c.height = ${h};
    const g = c.getContext('2d');
    g.fillStyle = '#2563eb'; g.fillRect(0, 0, ${w}, ${h});
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: 'image/png' }));`;

  // A recorder, not a stand-in. This used to replace window.open and return null,
  // which is exactly what Chrome returns when it refuses to open a popup, so the
  // check passed against a build where the second image went nowhere at all. The
  // hand-off is a real tab now and is looked for as one; this only proves that
  // window.open is not how it gets there, because a file chooser blocks it.
  await evaluate(cdp, session, `(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; })()`);

  const idle = await state();
  check(idle.landing && !idle.canvas,
    `a result tab opened with no capture showed no landing surface (${JSON.stringify(idle)})`,
    'a result tab opened with no capture offers to open an image instead of dead ending');

  const wiring = await evaluate(cdp, session, `JSON.stringify({
    button: Boolean(document.getElementById('open')),
    accept: document.getElementById('open-file').accept,
  })`).then(JSON.parse);
  check(wiring.button, 'the toolbar carries no Open control', 'the toolbar carries an Open control');
  check(!wiring.accept.includes('image/*') && wiring.accept.includes('image/png'),
    `the file dialog accepts "${wiring.accept}", which admits more than the decoder does`,
    'the file dialog offers exactly the raster types the decoder accepts, not image/*');

  // Pasting words is not a failed image paste. It must do nothing at all.
  await paste(`dt.setData('text/plain', 'just some words');`);
  await sleep(250);
  const afterText = await state();
  check(!afterText.canvas && afterText.landing,
    `pasting text opened something (${JSON.stringify(afterText)})`,
    'pasting text into the tab does nothing, because it is not a failed image paste');

  // An SVG is a drawing, not a picture, and the refusal has to say so.
  await paste(`dt.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' }));`);
  await sleep(250);
  const afterSvg = await state();
  check(!afterSvg.canvas && /SVG/.test(afterSvg.status),
    `an SVG was not refused by name (canvas ${afterSvg.canvas}, status "${afterSvg.status}")`,
    'an SVG is refused, and the reason says what to open instead');

  // The real thing.
  await paste(png('holiday.png', 600, 400));
  const opened = await until('the pasted image to open', async () => {
    const now = await state();
    return now.canvas ? now : null;
  }, { timeoutMs: 15000, everyMs: 200 });

  check(opened.w === 600 && opened.h === 400,
    `the pasted image opened at ${opened.w}x${opened.h}, expected 600x400`,
    `a pasted image opens at its own size (${opened.w}x${opened.h})`);
  check(!opened.landing,
    'the landing surface still occupies space behind the image, so it is pushing the canvas around',
    'the landing surface takes no space once there is a picture');
  check(opened.filename === 'holiday',
    `the filename box says "${opened.filename}", expected the file's own name without its extension`,
    'the filename box opens on the name the file arrived with, without its extension');

  const middle = await evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const d = c.getContext('2d').getImageData(300, 200, 1, 1).data;
    return JSON.stringify([d[0], d[1], d[2]]);
  })()`).then(JSON.parse);
  check(Math.abs(middle[2] - 235) < 30 && middle[0] < 80,
    `the opened image drew ${middle} in the middle, not the blue it was made of`,
    'the pixels of the opened image are really on the canvas');

  // The critical one. A second paste must not open over a picture that is
  // already here: the unload guard cannot save it, because the tab never
  // unloads, so a stray paste would silently destroy the work.
  await paste(png('second.png', 40, 40));
  await sleep(400);
  const afterSecond = await state();
  check(afterSecond.w === 600 && afterSecond.h === 400,
    `pasting over an open picture replaced it (${afterSecond.w}x${afterSecond.h}), destroying whatever was drawn on it`,
    'pasting while a picture is open leaves that picture exactly as it was');
  const handoff = await until('the hand-off tab to open', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'page' && t.url.includes('#open=')) ?? null;
  }, { timeoutMs: 8000, everyMs: 200 }).catch(() => null);
  check(Boolean(handoff),
    'the second image did not reach a new tab: no tab is showing a hand-off url',
    'the second image really opened in a new tab, not just in a message');
  check(afterSecond.opened === 0,
    `the hand-off went through window.open (${afterSecond.opened} calls), which Chrome blocks while a file chooser is open`,
    'the hand-off does not use window.open, so the file dialog cannot block it');
  if (handoff) await cdp.send('Target.closeTarget', { targetId: handoff.targetId });
}

/**
 * The size of a numbered step, as a number rather than as a drag.
 *
 * A step was sized from the stroke width and nothing else, so the only way to
 * get a bigger one was to draw thicker lines, and once placed it was final. The
 * checks that earn their place are the drawn ones: the disc on the canvas has to
 * be the size that was set, because a control that sets a value the renderer
 * ignores is worse than no control, and a slider drag has to undo as one step.
 */
async function exerciseCounterSize(cdp, session, check) {
  const closeAll = () => evaluate(cdp, session, `(() => {
    for (const p of document.querySelectorAll('.pop')) p.hidden = true;
    for (const b of document.querySelectorAll('[data-pop]')) b.setAttribute('aria-expanded', 'false');
  })()`);

  // It lives under the step's own chevron now, and nowhere else (D70). A second
  // copy left behind in Stroke style would be two controls for one value.
  const placement = await evaluate(cdp, session, `JSON.stringify({
    inStroke: !!document.querySelector('#pop-style #counter-px, #pop-style #counter-size'),
    inOwn: !!document.querySelector('#pop-counter #counter-px')
      && !!document.querySelector('#pop-counter #counter-size'),
  })`).then(JSON.parse);
  check(placement.inOwn && !placement.inStroke,
    `the step size is in the wrong popover: ${JSON.stringify(placement)}`,
    'the step size lives under the numbered step chevron, and not in Stroke style');

  await clickButton(cdp, session, '[data-tool="counter"]');
  await sleep(120);
  const opened = await evaluate(cdp, session,
    '!document.getElementById("pop-counter").hidden');
  check(!opened,
    'picking the numbered step tool also opened its size popover, over the canvas',
    'picking the numbered step tool leaves its size popover closed');

  await clickButton(cdp, session, '[data-pop="pop-counter"]');
  await sleep(120);
  const shown = await evaluate(cdp, session, `(() => {
    const p = document.getElementById('pop-counter');
    return getComputedStyle(p).display !== 'none' && p.getClientRects().length > 0;
  })()`);
  check(shown,
    'the numbered step chevron did not show its size popover',
    'the numbered step chevron opens its size popover');

  // Dragged, then drawn. The slider's input keeps the field in step, and 160
  // across is well clear of the default, which follows the stroke width.
  const paired = await evaluate(cdp, session, `(() => {
    const range = document.getElementById('counter-size');
    range.value = '160';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('counter-px').value;
  })()`);
  check(paired === '160',
    `the slider moved to 160 and the field says ${paired}`,
    'moving the step size slider updates the exact field');

  // The two ends of the field. Past the largest step it clamps and the slider
  // sits at its own end; emptied, it puts back what it showed instead of a
  // default. Both left at 160 afterwards for the drawing below.
  const edges = await evaluate(cdp, session, `(() => {
    const field = document.getElementById('counter-px');
    const range = document.getElementById('counter-size');
    field.value = '900';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    const high = { field: field.value, range: range.value };
    field.value = '160';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.value = '';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ high, emptied: field.value });
  })()`).then(JSON.parse);
  check(edges.high.field === '800' && edges.high.range === '400',
    `900 typed gave field ${edges.high.field} and slider ${edges.high.range}, not 800 and 400`,
    'a size past the largest clamps to 800, with the slider at its end');
  check(edges.emptied === '160',
    `an emptied field became ${edges.emptied} rather than putting back 160`,
    'an emptied size field puts back the size it showed');
  await closeAll();
  await sleep(120);

  // Real viewport coordinates, from the canvas box. Fractions here place the
  // step at the top left corner, where the scan below never looks, and the check
  // then reports a step 0 pixels across without saying that nothing was drawn.
  const box = await evaluate(cdp, session, `(() => {
    const b = document.getElementById('canvas').getBoundingClientRect();
    return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height });
  })()`).then(JSON.parse);
  const middle = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
  await dragOn(cdp, session, middle, middle, 1);
  await sleep(250);

  // The disc is the only dark thing on a flat blue picture, so a scan through
  // its middle measures it. Counting pixels rather than reading the model: the
  // suite checks what was drawn, never what the editor believes. The blue the
  // picture is made of has a low red channel and a high blue one; anything else
  // on the row belongs to a step. `from` and `to` are fractions of the width, so
  // two steps on the same row can be measured apart.
  const measure = (from = 0, to = 1) => evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const row = c.getContext('2d').getImageData(0, Math.round(c.height / 2), c.width, 1).data;
    let widest = 0;
    let run = 0;
    for (let x = Math.round(c.width * ${from}); x < Math.round(c.width * ${to}); x += 1) {
      run = row[x * 4] < 90 && row[x * 4 + 2] > 180 ? 0 : run + 1;
      if (run > widest) widest = run;
    }
    return widest;
  })()`);
  const escape = () => evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  const across = await measure();
  check(Math.abs(across - 160) <= 24,
    `a step set to 160px across was drawn ${across}px across`,
    `a numbered step is drawn the size that was set (${across}px for 160)`);

  // A slider dragged over a selected step is one undo step, not one per pixel.
  // Three live positions and a release, then a single undo has to put the step
  // back to 160, with the selection dropped first so its outline is not counted
  // as part of the disc.

  await clickButton(cdp, session, '[data-tool="select"]');
  await dragOn(cdp, session, middle, middle, 1);
  await sleep(120);
  await evaluate(cdp, session, `(() => {
    const range = document.getElementById('counter-size');
    for (const v of ['200', '240', '280']) {
      range.value = v;
      range.dispatchEvent(new Event('input', { bubbles: true }));
    }
    range.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await escape();
  await sleep(200);
  const dragged = await measure();
  check(Math.abs(dragged - 280) <= 24,
    `a selected step dragged to 280px was drawn ${dragged}px across`,
    `the slider resizes a selected step (${dragged}px for 280)`);

  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await escape();
  await sleep(200);
  const undone = await measure();
  check(Math.abs(undone - 160) <= 24,
    `one undo after a slider drag left the step ${undone}px across, not back at 160`,
    `a whole slider drag is undone in one step (${undone}px, back to 160)`);

  // A key held on the slider. Chrome fires change on every arrow press, auto
  // repeat included, so without the key-up rule each press was its own undo
  // step. Real key events through CDP, since a synthetic one does not move a
  // range. Page Up moves it a tenth of its travel, which is easy to see.
  await clickButton(cdp, session, '[data-tool="select"]');
  await dragOn(cdp, session, middle, middle, 1);
  await sleep(120);
  await clickButton(cdp, session, '[data-pop="pop-counter"]');
  await sleep(120);
  await evaluate(cdp, session, 'document.getElementById("counter-size").focus()');
  const pageUp = { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...pageUp }, session);
  for (let i = 0; i < 2; i += 1) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', autoRepeat: true, ...pageUp }, session);
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...pageUp }, session);
  await sleep(120);
  const held = Number(await evaluate(cdp, session, 'document.getElementById("counter-size").value'));
  await closeAll();
  await escape();
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await escape();
  await sleep(200);
  const afterHeld = await measure();
  check(held > 160 && Math.abs(afterHeld - 160) <= 24,
    `a held key took the slider to ${held}, and one undo left the step ${afterHeld}px across`,
    `a key held on the slider is one undo step (${held} held, ${afterHeld}px after one undo)`);

  // Typed, then a click on a different step before the field was left. The
  // canvas moves the selection before the field's change arrives, and the size
  // used to land on the step clicked. A small second step at the left edge, the
  // centre one selected and sized by typing, then the left one clicked.
  await clickButton(cdp, session, '[data-pop="pop-counter"]');
  await sleep(120);
  await evaluate(cdp, session, `(() => {
    const range = document.getElementById('counter-size');
    range.value = '40';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await closeAll();
  await clickButton(cdp, session, '[data-tool="counter"]');
  const edge = { x: Math.round(box.x + box.width * 0.1), y: middle.y };
  await dragOn(cdp, session, edge, edge, 1);
  await sleep(150);
  await clickButton(cdp, session, '[data-tool="select"]');
  await dragOn(cdp, session, middle, middle, 1);
  await sleep(120);
  await clickButton(cdp, session, '[data-pop="pop-counter"]');
  await sleep(120);
  await evaluate(cdp, session, `(() => {
    const field = document.getElementById('counter-px');
    field.focus();
    field.select();
  })()`);
  await cdp.send('Input.insertText', { text: '220' }, session);
  await sleep(120);
  await dragOn(cdp, session, edge, edge, 1);
  await sleep(150);
  await closeAll();
  await escape();
  await sleep(200);
  const centre = await measure(0.25, 1);
  const left = await measure(0, 0.25);
  check(Math.abs(centre - 220) <= 24 && Math.abs(left - 40) <= 12,
    `typed 220 then clicked another step: the centre one is ${centre}px and the clicked one ${left}px`,
    `a typed size stays on the step being edited when another is clicked (${centre}px, ${left}px)`);

  await clickButton(cdp, session, '[data-tool="select"]');
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
}

/**
 * Purpose made screenshots of the real product, for the store and the site.
 *
 * Deliberately not the same pass as exerciseEditor: that one ends cropped and
 * covered in test marks. These are what a person would actually see, drawn on
 * purpose, at the 1280x800 the Chrome Web Store asks for.
 *
 * Every position here is a capture pixel aimed at a feature of
 * store/demo/report.html: the one spike on the revenue chart, the first figure
 * on the page, the email column of the accounts table. That page is captured at
 * scale 1, so a capture pixel is a CSS pixel of it and the numbers were read off
 * it with getBoundingClientRect rather than guessed. The pass this replaced
 * placed everything at fractions of the canvas, and a fraction points somewhere
 * else the moment the page behind it changes length.
 */
async function marketingShots(cdp, session, dir) {
  // The Chrome Web Store takes 1280x800 or 640x400 and nothing else. The window
  // is 1280x800 but browser chrome eats 87 of those pixels, so the page viewport
  // is overridden to the exact size the store wants.
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, session);
  await sleep(350);

  // Put the overview pane away, through the same switch the options page uses.
  // It is a navigator for a long capture and it is faded until the pointer
  // arrives, so in a still photograph it reads as an empty white box sitting on
  // the picture rather than as a control. Setting `hidden` here would not hold:
  // the pane owns that attribute and takes itself back whenever the zoom or the
  // scroll changes, which is why this sets the switch instead.
  await evaluate(cdp, session, `(() => {
    const pane = document.getElementById('overview');
    pane.dataset.off = 'yes';
    pane.hidden = true;
  })()`);

  /** Where a given point of the capture is on screen, at whatever the zoom is. */
  const at = async (ix, iy) => JSON.parse(await evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const b = c.getBoundingClientRect();
    const s = b.width / c.width;
    return JSON.stringify({
      x: Math.round(b.left + ${ix} * s),
      y: Math.round(b.top + ${iy} * s),
    });
  })()`));

  /** Scroll until that band of the capture sits just under the toolbar. */
  const show = async (iy) => {
    await evaluate(cdp, session, `(() => {
      const c = document.getElementById('canvas');
      const b = c.getBoundingClientRect();
      const s = b.width / c.width;
      window.scrollTo(0, Math.max(0, Math.round(b.top + window.scrollY + ${iy} * s - 150)));
    })()`);
    await sleep(280);
  };

  /**
   * Shut every popover before a shot.
   *
   * Belt and braces rather than trusting a second click on the trigger to
   * toggle: a popover left open is invisible in the run log and obvious in the
   * published picture, and these are published.
   */
  const closePops = () => evaluate(cdp, session, `(() => {
    for (const p of document.querySelectorAll('.pop')) p.hidden = true;
    for (const b of document.querySelectorAll('[data-pop]')) b.setAttribute('aria-expanded', 'false');
  })()`);

  /** Fit the whole height, or go back to reading width. */
  const fit = async (which) => {
    await clickButton(cdp, session, '[data-pop="pop-zoom"]');
    await sleep(160);
    await clickButton(cdp, session, `#pop-zoom [data-fit="${which}"]`);
    await sleep(220);
    await closePops();
    await sleep(260);
  };

  // 1. THE WHOLE PAGE, AT ONCE.
  //
  // Fit the height and all 4,886 pixels of the report are on screen together,
  // which is the one thing this does that the screenshot key does not. The file
  // bar above reads the true size, so the ribbon is not asking to be believed.
  await fit('height');
  await evaluate(cdp, session, 'window.scrollTo(0, 0)');
  await sleep(300);
  await shoot(cdp, session, join(dir, 'shot-capture.png'));

  await fit('width');
  await evaluate(cdp, session, 'window.scrollTo(0, 0)');
  await sleep(260);

  // 2. ANNOTATION.
  //
  // A filled box around the headline figure, an arrow into the one peak on the
  // chart, and two numbered steps setting a reading order. Every mark lands on
  // something a person would actually want to point at.
  await show(196);

  await clickButton(cdp, session, '[data-pop="pop-border"]');
  await clickButton(cdp, session, '[data-paint="border"][data-colour="#ef4444"]');
  await clickButton(cdp, session, '[data-pop="pop-fill"]');
  await clickButton(cdp, session, '[data-paint="fill"][data-colour="#eab308"]');
  await closePops();
  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '#pop-shapes [data-tool="rect"]');
  await closePops();
  // The Recurring revenue card: 53,234, 278 wide, 175 tall.
  await dragOn(cdp, session, await at(44, 226), await at(340, 418));

  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '#pop-shapes [data-tool="arrow"]');
  await closePops();
  // Into the peak at 687,557, from clear air below and right of it.
  await dragOn(cdp, session, await at(1010, 772), await at(716, 580));

  await clickButton(cdp, session, '[data-tool="counter"]');
  const first = await at(366, 243);
  await dragOn(cdp, session, first, first, 1);
  const second = await at(1044, 800);
  await dragOn(cdp, session, second, second, 1);

  await clickButton(cdp, session, '[data-tool="select"]');
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await closePops();
  await sleep(240);
  await shoot(cdp, session, join(dir, 'shot-annotate.png'));

  // 3. REDACTION.
  //
  // Three of the eight contact addresses in the accounts table, which leaves the
  // five underneath readable: the picture carries its own before and after, and
  // the claim that the pixels are gone is easier to believe beside the ones that
  // are still there.
  await show(1236);
  await clickButton(cdp, session, '[data-tool="pixelate"]');
  await dragOn(cdp, session, await at(384, 1351), await at(586, 1520));
  await clickButton(cdp, session, '[data-tool="select"]');
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await closePops();
  await sleep(240);
  await shoot(cdp, session, join(dir, 'shot-redact.png'));

  // 4. SAVING.
  //
  // The format menu encodes the real image to fill in the sizes, so what it
  // says PNG, JPEG, WebP and PDF would weigh is what they weigh.
  await show(196);
  await evaluate(cdp, session, `document.getElementById('download').click()`);
  await sleep(500);
  await shoot(cdp, session, join(dir, 'shot-save.png'));
  await evaluate(cdp, session, `document.getElementById('download').click()`);
  await sleep(220);

  // 5. THE TOOLBOX.
  //
  // Fifteen shapes behind one chevron. The fifth shot used to be the upload hand
  // off, which explains a policy where this shows a capability, and the policy
  // is already the whole of the listing copy.
  await closePops();
  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await sleep(320);
  await shoot(cdp, session, join(dir, 'shot-tools.png'));
  await closePops();

  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, session);
}

/**
 * Run the rendered-page checks in a tab and report what they found.
 *
 * Asks the browser what it actually drew rather than what the stylesheet meant,
 * which is the only way to catch a rule that lost on specificity.
 */
async function auditPage(cdp, session, label, problems, log) {
  const script = readFileSync(join(HERE, 'page-audit.js'), 'utf8');
  const found = JSON.parse(await evaluate(cdp, session, script));

  if (found.lowContrastCount > 0) {
    const worst = found.lowContrast
      .map((f) => `${f.cls || f.tag} ${f.ratio}:1 needs ${f.need} ("${f.text}")`)
      .join('; ');
    problems.push(`${label}: ${found.lowContrastCount} low contrast, ${worst}`);
  } else {
    log(`${label}: every visible label meets its contrast minimum`);
  }

  if (found.hscroll || found.overflow.length > 0) {
    problems.push(`${label}: content wider than the window: ${found.overflow.join(', ') || 'document scrolls'}`);
  } else {
    log(`${label}: nothing overflows the window`);
  }

  if (found.brokenImages.length > 0) problems.push(`${label}: broken images ${found.brokenImages.join(', ')}`);
  if (found.headingSkips.length > 0) problems.push(`${label}: heading levels skip ${found.headingSkips.join(', ')}`);
}

/**
 * Screenshot a page for eyeballing, and for the store listing.
 *
 * A UI check that only asserts numbers cannot see that a chevron is as large as
 * the glyph beside it, or that a popover runs off the edge of the window. This
 * is the mechanism for looking.
 */
async function shoot(cdp, session, file) {
  await cdp.send('Page.enable', {}, session);
  const { data } = await cdp.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false }, session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  shot ${file}`);
}

/** Open a popover and leave it open, so the screenshot shows it. */
const openPopover = (cdp, session, trigger) =>
  evaluate(cdp, session, `document.querySelector('${trigger}').click()`);

/**
 * Inline text entry.
 *
 * The box is created in JS and positioned in document coordinates, which only
 * works if CSS makes it absolute. When the rule was missing it was a static input
 * appended to <body>, so it landed below the whole page and focus() scrolled the
 * tab to the bottom. That is why this asserts where the box actually is on screen
 * rather than that it exists.
 */
async function exerciseTextEntry(cdp, session, check, p, problems) {
  // Text lives behind its own combo button now, which both picks the tool and
  // opens the type inspector. The click on the canvas closes the inspector.
  await clickButton(cdp, session, '#text-combo');
  const at = p(0.32, 0.3);
  await dragOn(cdp, session, at, at, 1);

  const box = JSON.parse(await evaluate(cdp, session, `(() => {
    const i = document.querySelector('.text-entry');
    if (!i) return JSON.stringify({ missing: true });
    const r = i.getBoundingClientRect();
    return JSON.stringify({
      tag: i.tagName,
      position: getComputedStyle(i).position,
      onScreen: r.top > -4 && r.bottom < innerHeight + 4 && r.left > -4 && r.width > 0,
      focused: document.activeElement === i,
      scrollY: Math.round(window.scrollY),
      maxScroll: Math.round(document.documentElement.scrollHeight - innerHeight),
    });
  })()`));

  check(!box.missing, 'clicking with the text tool opened no text box', 'the text tool opens a text box');
  if (box.missing) {
    const why = await evaluate(cdp, session, `JSON.stringify({
      pressed: document.getElementById('text-combo').getAttribute('aria-pressed'),
      cursor: document.getElementById('canvas').style.cursor,
      inputs: document.querySelectorAll('input').length,
    })`);
    problems.push(`text entry never opened: ${why}`);
    return;
  }
  check(box.position === 'absolute',
    `the text box is position: ${box.position}, so it cannot sit where it was clicked`,
    'the text box is positioned against the page, not appended to the end of it');
  check(box.onScreen, `the text box is off screen: ${JSON.stringify(box)}`,
    'the text box appears where it was clicked');
  check(box.focused, 'the text box did not take focus', 'the text box takes focus, ready to type');
  check(box.maxScroll <= 0 || box.scrollY < box.maxScroll - 20,
    `focusing the text box scrolled the page to the bottom (${box.scrollY} of ${box.maxScroll})`,
    'focusing it does not throw the page to the bottom');

  check(box.tag === 'TEXTAREA',
    `the text box is a <${box.tag.toLowerCase()}>, which cannot hold a second line`,
    'the text box is a textarea, so a caption can be more than one line');

  // Two lines. The box has to grow to show the second one: a box that hides the
  // line being typed is worse than the single line box it replaced.
  const grown = JSON.parse(await evaluate(cdp, session, `(() => {
    const i = document.querySelector('.text-entry');
    const one = i.getBoundingClientRect().height;
    i.value = 'Hi there\\nHello wide world\\nEnd';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ one, two: i.getBoundingClientRect().height });
  })()`));
  check(grown.two > grown.one + 4,
    `the text box did not grow for a second line (${grown.one} then ${grown.two})`,
    `the text box grows with what is typed (${Math.round(grown.one)} to ${Math.round(grown.two)}px)`);

  // Enter is a newline now, so it must NOT commit. This is the regression that
  // would make multi-line text impossible to type.
  const beforeEnter = await countColour(cdp, session, { x: 0, y: 0, w: 900, h: 600 }, [239, 68, 68]);
  await evaluate(cdp, session, `(() => {
    document.querySelector('.text-entry')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(120);
  const stillOpen = await evaluate(cdp, session, `String(!!document.querySelector('.text-entry'))`);
  check(stillOpen === 'true', 'Enter closed the text box, so a second line cannot be typed',
    'Enter does not commit, it starts a new line');

  // Escape does commit, and both lines have to reach the canvas.
  await evaluate(cdp, session, `(() => {
    document.querySelector('.text-entry')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(220);
  const after = await countColour(cdp, session, { x: 0, y: 0, w: 900, h: 600 }, [239, 68, 68]);
  check(after > beforeEnter,
    `committing the text drew nothing (${beforeEnter} then ${after} red pixels)`,
    `the typed text was drawn onto the canvas (${after - beforeEnter} pixels)`);
  check(!(await evaluate(cdp, session, `String(!!document.querySelector('.text-entry'))`) === 'true'),
    'Escape left the text box open', 'Escape finishes the text');

  // Double click reopens it with the words already in it, which is the whole
  // difference between restyling text and editing it.
  await clickButton(cdp, session, '[data-tool="select"]');
  await doubleClickOn(cdp, session, p(0.33, 0.31));
  await sleep(200);
  const reopened = await evaluate(cdp, session,
    `JSON.stringify(document.querySelector('.text-entry')?.value ?? null)`).then(JSON.parse);
  check(reopened === 'Hi there\nHello wide world\nEnd',
    `double clicking the text reopened it holding ${JSON.stringify(reopened)}`,
    'double clicking a text shape reopens it with its own words');

  // Alignment moves the pixels. Centre the block and the shorter line has to
  // shift right, which no amount of restyling would do on its own.
  if (reopened !== null) {
    await evaluate(cdp, session, `(() => {
      document.querySelector('.text-entry')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()`);
    await sleep(200);
  }
  const flush = await canvasSignature(cdp, session);
  await clickButton(cdp, session, '[data-pop="pop-text"]');
  await clickButton(cdp, session, '[data-align="center"]');
  await sleep(220);
  const centred = await canvasSignature(cdp, session);
  check(centred !== flush, 'centring the text changed nothing on the canvas',
    'centring redraws the block, so the setting reaches the pixels');

  // Justify needs a line that is not the last one and has more than one word in
  // it, which is why the typed text is three lines. The last line of a justified
  // block is set flush left, exactly as it is in print, so a two line block would
  // draw identically to left aligned and prove nothing.
  await clickButton(cdp, session, '[data-align="justify"]');
  await sleep(220);
  // Justification is the one alignment whose result is worth looking at rather
  // than only measuring, so it is offered to the shot directory like the rest.
  if (process.env.FPC_SHOT_DIR) {
    await shoot(cdp, session, join(process.env.FPC_SHOT_DIR, 'text-justified.png'));
  }
  const justified = await canvasSignature(cdp, session);
  check(justified !== centred && justified !== flush,
    'justify drew what left or centre drew, so the words were not spread',
    'justify spreads the words, and draws something neither of the others do');

  // And back. Left align has to reproduce the original rendering exactly, which
  // is a stronger statement than "it changed": it says nothing else moved.
  await clickButton(cdp, session, '[data-align="left"]');
  await sleep(220);
  check(await canvasSignature(cdp, session) === flush,
    'going back to left align did not reproduce the original drawing',
    'left align draws exactly what it drew before, so nothing else was disturbed');
  await evaluate(cdp, session, `document.body.click()`);

  // Undo back to where this function found the canvas, and no further: undoing
  // blind would take the shapes the earlier checks drew with it. The step count
  // is asserted as well as the outcome, so a stray extra commit is caught rather
  // than quietly absorbed by a longer loop.
  let steps = 0;
  const red = () => countColour(cdp, session, { x: 0, y: 0, w: 900, h: 600 }, [239, 68, 68]);
  while (steps < 10 && await red() > beforeEnter) {
    await clickButton(cdp, session, '#undo');
    await sleep(90);
    steps += 1;
  }
  check(await red() <= beforeEnter && steps <= 6,
    `undoing the text took ${steps} steps and left ${(await red()) - beforeEnter} of its pixels behind`,
    `undo removed the text in ${steps} steps and left the shapes drawn before it`);
}

/**
 * A cheap checksum of what is actually painted on the canvas.
 *
 * Used where the question is "did this setting reach the pixels", which counting
 * a colour cannot answer once more than one shape uses that colour. It also lets
 * a check say something stronger than "something changed": setting the alignment
 * back has to reproduce the original signature exactly.
 */
async function canvasSignature(cdp, session) {
  return evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const g = c.getContext('2d', { willReadFrequently: true });
    const { data } = g.getImageData(0, 0, Math.min(900, c.width), Math.min(600, c.height));
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i] + data[i + 1] * 3 + data[i + 2] * 7;
      hash = Math.imul(hash, 16777619);
    }
    return String(hash >>> 0);
  })()`);
}

/**
 * The grouped style controls: popovers, the two colour buttons, the hex field
 * and the fill. Every assertion is against real pixels or the real attribute on
 * the glyph, because the whole point of the pattern is that the button
 * shows the state, and a button that lies about it is the failure to catch.
 */
async function exerciseStyleToolbar(cdp, session, check, p) {
  // How many popovers a person can actually see.
  //
  // This asks the layout, not the `hidden` property. An earlier version of this
  // check read the property, which was set correctly the whole time, while a CSS
  // specificity collision meant `display: none` never applied and every popover
  // was permanently on screen. The property was right and the pixels were wrong,
  // so from here on the pixels are what gets asserted.
  const visiblePopovers = () => evaluate(cdp, session, `(() => {
    const shown = [...document.querySelectorAll('#toolbar .pop')]
      .filter((p) => getComputedStyle(p).display !== 'none' && p.getClientRects().length > 0)
      .map((p) => p.id);
    return JSON.stringify(shown);
  })()`).then(JSON.parse);

  const atRest = await visiblePopovers();
  check(atRest.length === 0,
    `popovers were open before anything was clicked: ${atRest.join(', ')}`,
    'no popover is open until a chevron is clicked');

  await clickButton(cdp, session, '#border-combo');
  const afterBorder = await visiblePopovers();
  check(afterBorder.length === 1 && afterBorder[0] === 'pop-border',
    `the border chevron left these open: ${afterBorder.join(', ') || 'none'}`,
    'the border chevron opened its popover, and only its popover');

  // The reported bug: opening a second set left the first one on screen.
  await clickButton(cdp, session, '#style-combo');
  const afterStyle = await visiblePopovers();
  check(afterStyle.length === 1 && afterStyle[0] === 'pop-style',
    `opening stroke style left these open: ${afterStyle.join(', ')}`,
    'opening a second set closes the first');

  await clickButton(cdp, session, '#text-combo');
  await clickButton(cdp, session, '#fill-combo');
  const afterFill = await visiblePopovers();
  check(afterFill.length === 1 && afterFill[0] === 'pop-fill',
    `after four chevrons these were open: ${afterFill.join(', ')}`,
    'after clicking four chevrons in turn, exactly one is open');

  // Clicking the open chevron again closes it, and so does Escape.
  await clickButton(cdp, session, '#fill-combo');
  check((await visiblePopovers()).length === 0,
    'clicking the open chevron again did not close it',
    'clicking an open chevron closes it');

  // The upload hand-off. It must be reachable, list hosts, and say plainly that
  // the extension is not the thing doing the uploading.
  await clickButton(cdp, session, '#upload');
  const bounds = JSON.parse(await evaluate(cdp, session, `(() => {
    const r = document.getElementById('pop-upload').getBoundingClientRect();
    return JSON.stringify({
      left: Math.round(r.left), right: Math.round(r.right),
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map((e) => e.tagName + '.' + (e.id || e.className) + '@'
          + Math.round(e.getBoundingClientRect().right))
        .slice(0, 6),
    });
  })()`));
  check(bounds.left >= 0 && bounds.right <= bounds.width && !bounds.scroll,
    `the upload popover is outside the window: ${JSON.stringify(bounds)}`,
    'the upload popover stays inside the window');
  const hosts = JSON.parse(await evaluate(cdp, session, `JSON.stringify({
    open: getComputedStyle(document.getElementById('pop-upload')).display !== 'none',
    names: [...document.querySelectorAll('[data-host]')].map((b) => b.dataset.hostName),
    external: [...document.querySelectorAll('[data-host]')].every((b) => b.dataset.host.startsWith('https://')),
    disclaims: /does not upload/.test(document.querySelector('.pop.hosts .caption').textContent),
  })`));
  check(hosts.open && hosts.names.length >= 3 && hosts.external && hosts.disclaims,
    `the upload popover is wrong: ${JSON.stringify(hosts)}`,
    `upload offers ${hosts.names.join(', ')} and says the extension does not upload`);
  await clickButton(cdp, session, '#upload');

  await clickButton(cdp, session, '#border-combo');

  // ONE PANEL, FIVE TIMES
  //
  // Every palette is the same object: the same number of cells in the same grid,
  // and a no-colour square as the first of them wherever PAINTS says a paint can
  // be switched off. Read off the built panels and compared against PAINTS, so a
  // panel that quietly grows a row of its own is caught by the description it was
  // supposed to have been built from rather than by a number written here.
  const palettes = JSON.parse(await evaluate(cdp, session, `(() => {
    const out = {};
    for (const pop of document.querySelectorAll('[data-paint-pop]')) {
      out[pop.dataset.paintPop] = {
        cells: pop.querySelectorAll('.sw').length,
        none: pop.querySelectorAll('[data-paint-none]').length,
        rows: [...pop.children].map((n) => n.tagName.toLowerCase() + '.' + n.className).join(' '),
      };
    }
    return JSON.stringify(out);
  })()`));
  const shape = palettes.border?.rows;
  for (const [kind, paint] of Object.entries(PAINTS)) {
    const got = palettes[kind];
    check(Boolean(got) && got.cells === 70 && got.rows === shape,
      `the ${kind} palette is ${got ? `${got.cells} cells laid out as "${got.rows}"` : 'missing'},`
        + ` and the border palette is 70 cells laid out as "${shape}"`,
      `the ${kind} palette is the same panel as the others (${got?.cells} cells)`);
    check(got?.none === (paint.none ? 1 : 0),
      `the ${kind} palette has ${got?.none} no-colour swatches and PAINTS says ${paint.none ? 1 : 0}`,
      `the ${kind} palette ${paint.none ? 'offers' : 'does not offer'} no colour, as PAINTS says`);
  }

  // A typed hex reaches the glyph. This is the custom colour path, and it is
  // what takes the product past the six colours it used to have.
  await evaluate(cdp, session, `(() => {
    const hex = document.getElementById('border-hex');
    hex.value = '#22c55e';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const stroke = await evaluate(cdp, session,
    `document.getElementById('border-glyph').getAttribute('stroke')`);
  check(stroke === '#22c55e', `a typed hex left the border glyph at ${stroke}`,
    'a typed hex colour reached the border glyph');

  // Nonsense in the same box is refused rather than guessed at.
  await evaluate(cdp, session, `(() => {
    const hex = document.getElementById('border-hex');
    hex.value = 'chartreuse';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const kept = await evaluate(cdp, session,
    `document.getElementById('border-glyph').getAttribute('stroke')`);
  check(kept === '#22c55e', `an unusable hex changed the colour to ${kept}`,
    'an unusable hex was refused and the colour kept');

  // FILL, AND NO BORDER
  //
  // Both are drawn where the window actually is. The fractions this used to use
  // put the press a thousand pixels below the bottom of the screen, where Chrome
  // clamps it: the box was never drawn, and the check passed on a shape an
  // earlier step had left selected.
  const spot = await visibleSpot(cdp, session);
  const GREEN = [0x22, 0xc5, 0x5e];
  // A blue wash over a near-white page cannot raise the blue channel, which is
  // already at the ceiling. What it does is pull red and green down, so the
  // measurement that means "bluer" is the gap between the channels, not blue.
  const blueness = (rgb) => rgb[2] - (rgb[0] + rgb[1]) / 2;
  const middleAt = `(() => {
    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    const s = c.width / box.width;
    const d = c.getContext('2d').getImageData(
      Math.round((${spot.middle.x} - box.x) * s), Math.round((${spot.middle.y} - box.y) * s), 1, 1).data;
    return JSON.stringify([d[0], d[1], d[2]]);
  })()`;

  await clickButton(cdp, session, '[data-tool="rect"]');
  await dragOn(cdp, session, spot.from, spot.to);
  await sleep(160);
  const unfilled = JSON.parse(await evaluate(cdp, session, middleAt));
  await clickButton(cdp, session, '#undo');

  await clickButton(cdp, session, '#fill-combo');
  await clickButton(cdp, session, '[data-paint="fill"][data-colour="#3b82f6"]');
  const fillGlyph = await evaluate(cdp, session,
    `document.getElementById('fill-glyph').getAttribute('fill')`);
  check(fillGlyph === '#3b82f6', `the fill glyph shows ${fillGlyph}`,
    'the fill glyph took the colour that was picked');

  // What is already this colour inside the region, before anything is drawn.
  // Counted rather than assumed to be nothing: the checks above this one draw on
  // the same canvas, and a baseline is what keeps this honest when they change.
  const green0 = await countColour(cdp, session, spot.scan, GREEN);
  const dark0 = await countDark(cdp, session, spot.scan);

  await clickButton(cdp, session, '[data-tool="rect"]');
  await dragOn(cdp, session, spot.from, spot.to);
  await sleep(160);
  const filled = JSON.parse(await evaluate(cdp, session, middleAt));

  check(blueness(filled) > blueness(unfilled) + 20,
    `the fill did not tint the inside of the box (empty ${unfilled}, filled ${filled})`,
    `the fill tinted the inside of the box (${unfilled} became ${filled})`);

  // NO BORDER
  //
  // The border palette carries the same no-colour swatch the fill has, and it
  // has to reach the pixels rather than only the button. Canvas keeps whatever
  // colour it was last given when it is handed one it cannot parse, so a shape
  // with no border colour and no guard is drawn in the previous shape's colour:
  // a drawing that looks merely wrong rather than absent. The box is blue inside
  // from the step above, so this says what did not change as well.
  const outlined = await countColour(cdp, session, spot.scan, GREEN) - green0;
  await clickButton(cdp, session, '#border-combo');
  await clickButton(cdp, session, '[data-paint-none="border"]');
  await sleep(220);
  const bare = await countColour(cdp, session, spot.scan, GREEN) - green0;
  const darkened = await countDark(cdp, session, spot.scan) - dark0;
  // The fill is read at the middle rather than counted, because a fill is
  // translucent by default: none of its pixels are the colour that was picked.
  const stillFilled = blueness(JSON.parse(await evaluate(cdp, session, middleAt)));
  check(outlined > 200 && bare * 8 < outlined,
    `no border left ${bare} of the ${outlined} pixels the border had drawn`,
    `no border takes the outline off the shape (${outlined} pixels to ${bare})`);
  // And it is gone, rather than merely no longer green.
  check(darkened * 20 < outlined,
    `the outline came back in another colour: ${darkened} dark pixels appeared where`
      + ` the ${outlined} pixel border had been`,
    `nothing is drawn in its place (${darkened} dark pixels against a ${outlined} pixel border)`);
  check(Math.abs(stillFilled - blueness(filled)) < 6,
    `taking the border off also moved the fill: ${blueness(filled)} became ${stillFilled}`,
    'the fill is untouched by it');
  const slashed = await evaluate(cdp, session,
    `document.getElementById('border-slash').hasAttribute('hidden') === false`);
  check(slashed, 'the border button does not show that it is holding nothing',
    'the border button wears the same slash the fill button does');

  // Undo exactly what these two added, however many steps that took: drawing the
  // box is one and restyling it is another, and a fixed count here would eat a
  // step belonging to the checks before it the day that changes.
  await evaluate(cdp, session, 'document.body.click()');
  let back = 0;
  const middleNow = async () => blueness(JSON.parse(await evaluate(cdp, session, middleAt)));
  while (back < 6 && await middleNow() > blueness(unfilled) + 20) {
    await clickButton(cdp, session, '#undo');
    await sleep(110);
    back += 1;
  }
  check(back > 0 && back < 6, `undoing the borderless box took ${back} steps`,
    `the borderless box undoes in ${back} steps`);

  // Put the defaults back so the steps after this one see what they expect.
  await evaluate(cdp, session, `document.querySelector('[data-paint-none="fill"]').click()`);
  await evaluate(cdp, session, `(() => {
    const hex = document.getElementById('border-hex');
    hex.value = '#ef4444';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

/**
 * Exercise the editor the way a person would: draw, undo, redo, crop. Asserts
 * against real canvas pixels rather than against the model, so a drawing bug
 * cannot pass by keeping the model tidy.
 */
async function exerciseEditor(cdp, session, log) {
  const problems = [];
  const before = await canvasState(cdp, session);
  const originalSize = { width: before.width, height: before.height };

  const box = before.box;
  const p = (fx, fy) => ({
    x: Math.round(box.x + box.width * fx),
    y: Math.round(box.y + Math.min(box.height, 520) * fy),
  });
  const scanRect = { x: 0, y: 0, w: before.width, h: 600 };
  const RED = [239, 68, 68];
  const BLUE = [59, 130, 246];

  const check = (ok, bad, good) => (ok ? log(good) : problems.push(bad));

  // 1. Draw an arrow with the default tool.
  await dragOn(cdp, session, p(0.2, 0.25), p(0.7, 0.7));
  const afterArrow = await countColour(cdp, session, scanRect, RED);
  check(afterArrow > 200, `arrow drew only ${afterArrow} red pixels`,
    `arrow drawn (${afterArrow} red pixels)`);

  // 2. Finishing a shape hands it back: the tool returns to selection with the
  // new shape already selected, so the next click acts on it instead of drawing
  // a second one, which is the convention in drawing tools generally.
  const handedBack = JSON.parse(
    await evaluate(cdp, session, `JSON.stringify({
      tool: document.querySelector('[data-tool="select"]').getAttribute('aria-pressed'),
      stillDrawing: document.querySelector('[data-tool="arrow"]').getAttribute('aria-pressed'),
      canDelete: document.getElementById('delete').disabled === false,
    })`),
  );
  check(handedBack.tool === 'true' && handedBack.stillDrawing === 'false',
    `after drawing, the active tool was not select (${JSON.stringify(handedBack)})`,
    'drawing handed back to the selection tool');
  check(handedBack.canDelete,
    'the shape just drawn was not left selected',
    'the new shape was left selected and ready to edit');

  // 3. Move it, the thing a shape list cannot do.
  await clickButton(cdp, session, '[data-tool="select"]');
  await dragOn(cdp, session, p(0.45, 0.475), p(0.45, 0.475), 1); // click on the arrow
  const selected = await evaluate(cdp, session,
    `document.getElementById('delete').disabled === false`);
  check(selected, 'clicking a shape did not select it', 'clicking selected the arrow');

  await dragOn(cdp, session, p(0.45, 0.475), p(0.35, 0.3));
  const afterMove = await countColour(cdp, session, scanRect, RED);
  check(afterMove > 200, 'the arrow vanished when moved', 'the selected arrow moved');

  // 3. Restyle the selection: changing colour must repaint the existing shape.
  //
  // Qualified by palette. `[data-colour]` alone was ambiguous the moment the text
  // inspector grew a colour row of its own: `querySelector` takes the first match
  // in the document, the text row comes first, and this quietly started recolouring
  // text that was not there instead of the selected arrow.
  await clickButton(cdp, session, '[data-paint="border"][data-colour="#3b82f6"]');
  const blue = await countColour(cdp, session, scanRect, BLUE);
  const redLeft = await countColour(cdp, session, scanRect, RED);
  check(blue > 200 && redLeft < 200,
    `restyling left ${redLeft} red and ${blue} blue pixels`,
    'restyling recoloured the selected shape');

  // 4. Undo the restyle and the move.
  await clickButton(cdp, session, '#undo');
  await clickButton(cdp, session, '#undo');
  await sleep(200);
  const backToRed = await countColour(cdp, session, scanRect, RED);
  check(backToRed > 200, 'undo lost the arrow', 'undo reversed the restyle and the move');

  // 5. Delete it, and confirm the image underneath is untouched.
  await clickButton(cdp, session, '#delete');
  await sleep(150);
  const afterDelete = await countColour(cdp, session, scanRect, RED);
  check(afterDelete === 0, `delete left ${afterDelete} red pixels behind`,
    'delete restored the original pixels exactly');

  // 6. A box, then redaction over it, redaction must change pixels for real.
  await clickButton(cdp, session, '[data-paint="border"][data-colour="#ef4444"]');
  await clickButton(cdp, session, '[data-tool="rect"]');
  await dragOn(cdp, session, p(0.1, 0.1), p(0.45, 0.4));
  const boxed = await countColour(cdp, session, scanRect, RED);
  check(boxed > 200, 'box drew nothing', `box drawn (${boxed} red pixels)`);

  await clickButton(cdp, session, '[data-tool="pixelate"]');
  // Sample where the fixture actually has detail, the ROW text. A flat colour
  // survives pixelation unchanged, so sampling one proves nothing.
  const sample = `(() => {
    const d = document.getElementById('canvas').getContext('2d')
      .getImageData(110, 105, 200, 70).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7;
    return sum;
  })()`;
  const beforeRedact = await evaluate(cdp, session, sample);
  await dragOn(cdp, session, p(0.05, 0.05), p(0.4, 0.35));
  const afterRedact = await evaluate(cdp, session, sample);
  check(beforeRedact !== afterRedact, 'redaction changed nothing',
    'redaction resampled the pixels underneath');

  // A REDACTION IS NEVER TRANSLUCENT
  //
  // Stroke opacity reaches every other shape, and this is the one it must not
  // reach. A redaction that took it would be a redaction you could read through,
  // and the control that did it sits three popovers away from the tool, so
  // nobody would connect the two.
  //
  // The same region, redacted again with the stroke opacity dragged to nothing.
  // It has to change the pixels underneath exactly as it did at full opacity: a
  // build that let the opacity through would draw nothing at all here, and the
  // sample would come back as the untouched page.
  await clickButton(cdp, session, '#undo');
  await sleep(140);
  const restored = await evaluate(cdp, session, sample);
  check(restored === beforeRedact,
    'undo did not put the redacted pixels back, so the check below proves nothing',
    'undo puts the redacted pixels back');

  await clickButton(cdp, session, '[data-pop="pop-border"]');
  await setRange(cdp, session, 'border-opacity', 0);
  await evaluate(cdp, session, 'document.body.click()');
  await clickButton(cdp, session, '[data-tool="pixelate"]');
  await dragOn(cdp, session, p(0.05, 0.05), p(0.4, 0.35));
  await sleep(140);
  const redactedClear = await evaluate(cdp, session, sample);
  check(redactedClear !== beforeRedact,
    'a redaction drawn at zero stroke opacity left the page unchanged, so opacity reached it',
    'a redaction is opaque even with the stroke opacity dragged to nothing');

  await clickButton(cdp, session, '[data-pop="pop-border"]');
  await setRange(cdp, session, 'border-opacity', 100);
  await evaluate(cdp, session, 'document.body.click()');

  // 7. Inline text entry.
  await exerciseTextEntry(cdp, session, check, p, problems);

  // 8. The grouped style controls.
  await exerciseStyleToolbar(cdp, session, check, p);

  // 8a1. Nothing that is meant to be out of the way is quietly taking up room.
  // A `display` set on a class beats the browser's own `[hidden]` rule, so an
  // element can report hidden and still be laid out. When that happened to the
  // landing surface it sat in main's flex row and moved the capture sideways,
  // which moved every pointer coordinate below and failed thirty checks at once,
  // none of which mentioned layout.
  const stowed = await evaluate(cdp, session, `JSON.stringify(
    [...document.querySelectorAll('[hidden]')]
      .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0)
      .map((el) => el.id || el.className))`).then(JSON.parse);
  check(stowed.length === 0,
    `elements are hidden and still laid out, so they are pushing the page around: ${stowed.join(', ')}`,
    'everything marked hidden really takes up no space');

  // 8a2. Zoom, and the overview pane that says where you are in a long capture.
  await exerciseZoom(cdp, session, check);

  // 8b. The theme button, round robin through three states.
  await exerciseTheme(cdp, session, check);

  // 8c. Every chevron opens a menu that can actually be reached.
  await exerciseChevrons(cdp, session, check);

  // 8d. Arrow and line are one shape stored twice. They must not drift apart.
  await exerciseArrowAndLine(cdp, session, check, p);

  // 8e. What the pointer says before the click.
  await exerciseTextFrame(cdp, session, check, p);

  // 8f. A caption that wraps inside a width set by its two side handles.
  await exerciseTextWrap(cdp, session, check, p);

  await exerciseShapes(cdp, session, check, p);

  await exercisePaintOrder(cdp, session, check, p);

  await exerciseMultiSelect(cdp, session, check, p);

  await exerciseLoupeRedaction(cdp, session, check, p);

  await exercisePointerFeedback(cdp, session, check, p);
  await exerciseExportChrome(cdp, session, check, p);

  // 9. What the browser actually drew: contrast, overflow, broken images.
  //
  // Twice, once per theme. Until the theme button existed the dark palette could
  // only be reached through prefers-color-scheme, which this harness never sets,
  // so half the colours in the stylesheet had never been looked at by anything.
  await auditPage(cdp, session, 'result tab', problems, log);
  await setTheme(cdp, session, 'dark');
  await auditPage(cdp, session, 'result tab, dark theme', problems, log);
  if (process.env.FPC_SHOT_DIR) {
    await evaluate(cdp, session, 'window.scrollTo(0, 0)');
    await sleep(150);
    await shoot(cdp, session, join(process.env.FPC_SHOT_DIR, 'editor-dark.png'));
  }
  await setTheme(cdp, session, 'system');

  // 10. Crop. It proposes a region, waits to be told, and only then cuts.
  await clickButton(cdp, session, '[data-tool="crop"]');

  // 10a. Cancelling leaves the image alone and costs no undo step.
  await dragOn(cdp, session, p(0.2, 0.2), p(0.6, 0.5));
  const proposed = await cropBarState(cdp, session);
  check(proposed.shown, 'no confirm bar appeared after drawing a crop',
    `the crop bar appeared, offering ${proposed.size}`);
  const untouched = await canvasState(cdp, session);
  check(untouched.width === originalSize.width && untouched.height === originalSize.height,
    `drawing a crop cut the image straight away: ${untouched.width}x${untouched.height}`,
    'drawing a crop changes nothing until it is confirmed');
  check(proposed.inView, 'the crop bar was outside the window',
    'the crop bar sits inside the window');
  if (process.env.FPC_SHOT_DIR) await shoot(cdp, session, join(process.env.FPC_SHOT_DIR, 'crop-pending.png'));

  await clickButton(cdp, session, '#crop-cancel');
  await sleep(150);
  const afterCancel = await cropBarState(cdp, session);
  const stillWhole = await canvasState(cdp, session);
  check(!afterCancel.shown, 'the crop bar stayed after cancelling', 'cancelling puts the bar away');
  check(stillWhole.width === originalSize.width, 'cancelling changed the image',
    'cancelling leaves the capture exactly as it was');
  // Nothing was committed, so the top of the undo stack is still the last real
  // edit. Undo once: if a crop had been recorded, this is where it would appear.
  await clickButton(cdp, session, '#undo');
  await sleep(150);
  const afterUndo = await canvasState(cdp, session);
  check(afterUndo.width === originalSize.width && afterUndo.height === originalSize.height,
    `undo after a cancelled crop uncropped the image, so one had been committed: ${afterUndo.width}x${afterUndo.height}`,
    'a cancelled crop was never committed, so there is no crop on the undo stack');
  await clickButton(cdp, session, '#redo');
  await sleep(150);

  // 10b. And confirming does cut.
  await dragOn(cdp, session, p(0.15, 0.15), p(0.8, 0.8));
  const ready = await cropBarState(cdp, session);
  await clickButton(cdp, session, '#crop-apply');
  await sleep(200);
  const cropped = await canvasState(cdp, session);
  check(cropped.width < originalSize.width && cropped.height < originalSize.height,
    `crop did not shrink the canvas: ${cropped.width}x${cropped.height}`,
    `cropped to ${cropped.width}x${cropped.height} (from ${originalSize.width}x${originalSize.height})`);
  // The bar reported the size before the cut, so it has to match what arrived.
  check(ready.size === `${cropped.width} × ${cropped.height}`,
    `the bar promised ${ready.size} and the crop gave ${cropped.width} × ${cropped.height}`,
    `the size on the bar matched the crop it produced (${ready.size})`);
  const barGone = await cropBarState(cdp, session);
  check(!barGone.shown, 'the crop bar stayed after the crop was applied',
    'the bar goes away once the crop is applied');

  await clickButton(cdp, session, '#undo');
  await sleep(150);
  const uncropped = await canvasState(cdp, session);
  check(uncropped.width === originalSize.width && uncropped.height === originalSize.height,
    `undoing the crop gave ${uncropped.width}x${uncropped.height}`,
    'undoing the crop restored the full image');

  // Leave a crop in place so the download proves edits reach the saved file.
  await clickButton(cdp, session, '#redo');
  await sleep(150);
  return { problems, cropped: await canvasState(cdp, session) };
}

/** Force a theme and wait for every page to have taken it. */
async function setTheme(cdp, session, theme) {
  await evaluate(cdp, session, `chrome.storage.local.set({ theme: ${JSON.stringify(theme)} })`);
  await sleep(250);
}

/**
 * The theme button: three states, in order, back to the start, with the label
 * saying both where it is and what one more press will do.
 *
 * "system" is the state that is easy to get wrong, because it is not a colour: it
 * has to stamp no attribute at all so the stylesheet falls through to
 * prefers-color-scheme. A "system" that stamps light is a bug nobody sees until
 * their machine switches to dark and the extension does not.
 *
 * The glyph is read as computed `display`, never as `element.hidden`. That is not
 * fussiness: `hidden` is a property of HTMLElement and SVGElement does not have
 * one, so `svg.hidden = true` sets a plain JavaScript property and draws nothing
 * different. This check used to read the same property the code wrote, agreed
 * with it, and passed for as long as the button was visibly stuck on one icon.
 * Ask the browser what it painted. D23.
 */
/**
 * Zoom, and the pane that says where in a long capture you are.
 *
 * The thing worth checking is not that a slider moves. It is that the picture on
 * screen changed size, that the marker in the pane agrees with where the window
 * actually is, and that clicking the pane moves the window. Each of those can be
 * wrong on its own while the other two look right.
 */
async function exerciseZoom(cdp, session, check) {
  console.log('\nzoom, and knowing where you are:');

  const shown = () => evaluate(cdp, session,
    'Math.round(document.getElementById("canvas").getBoundingClientRect().width)');
  const paneShown = () => evaluate(cdp, session,
    'document.getElementById("overview").hidden === false');

  await evaluate(cdp, session, 'window.scrollTo(0, 0)');
  await sleep(120);

  const fitted = await shown();
  const room = await evaluate(cdp, session, 'document.documentElement.clientWidth');
  check(fitted > 0 && fitted <= room,
    `the capture opens ${fitted}px wide in a ${room}px window, so it does not fit`,
    `the capture opens fitted to the window (${fitted}px in ${room}px)`);

  // The fixture is far taller than the window, so the pane has something to say.
  check(await paneShown(),
    'the overview pane stayed hidden on a capture ten screens tall',
    'the overview pane appears on a capture taller than the window');

  await clickButton(cdp, session, '[data-pop="pop-zoom"]');
  await sleep(120);

  // The percentage is typed as well as dragged, and there is only one of it:
  // this is what the separate 100% button used to do.
  await evaluate(cdp, session, `(() => {
    const f = document.getElementById('zoom-exact');
    f.value = '100';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(180);
  const full = await shown();
  const natural = await evaluate(cdp, session, 'document.getElementById("canvas").width');
  check(Math.abs(full - natural) <= 2,
    `typing 100 drew the capture ${full}px wide when the image is ${natural}px`,
    `typing 100 shows one pixel of the capture to one of the screen (${full}px of ${natural}px)`);

  await setRange(cdp, session, 'zoom-level', 40);
  await sleep(160);
  const smaller = await shown();
  check(smaller < full - 10,
    `dragging the zoom slider left did not shrink the picture (${full}px to ${smaller}px)`,
    `dragging the zoom slider shrinks the picture (${full}px to ${smaller}px)`);
  const says = await evaluate(cdp, session, 'document.getElementById("zoom-exact").value');
  check(says === '40',
    `the zoom field says ${says} after the slider was dragged to 40`,
    'the slider and the field are one control: dragging one moves the other');

  // And the field refuses a number that is not a zoom, rather than trying it.
  await evaluate(cdp, session, `(() => {
    const f = document.getElementById('zoom-exact');
    f.value = '9999';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(160);
  const clamped = await evaluate(cdp, session, 'document.getElementById("zoom-exact").value');
  check(clamped === '400',
    `typing 9999 left the field saying ${clamped} rather than the largest zoom there is`,
    'typing more than the largest zoom puts the field back to what the picture is at');

  await clickButton(cdp, session, '[data-fit="width"]');
  await sleep(160);
  const back = await shown();
  check(back <= room && Math.abs(back - fitted) <= 4,
    `Fit width did not put the capture back inside the window (${back}px in ${room}px)`,
    `Fit width puts the capture back inside the window (${back}px)`);
  await evaluate(cdp, session, 'document.body.click()');

  // THE MARKER
  //
  // Its top is where the window is, as a fraction of the whole picture. Scroll
  // the page and it has to move by the same fraction, or it is decoration.
  const markerTop = () => evaluate(cdp, session,
    'parseFloat(document.getElementById("overview-port").style.top) || 0');
  const atTop = await markerTop();
  await evaluate(cdp, session, 'window.scrollTo(0, Math.round(document.body.scrollHeight * 0.5))');
  await sleep(200);
  const atMiddle = await markerTop();
  check(atMiddle > atTop + 10,
    `scrolling half way down moved the marker from ${atTop}% to ${atMiddle}%`,
    `the marker follows the window down the page (${Math.round(atTop)}% to ${Math.round(atMiddle)}%)`);

  // And the other way: clicking the pane moves the window.
  await evaluate(cdp, session, 'window.scrollTo(0, 0)');
  await sleep(140);
  const jumped = await evaluate(cdp, session, `(() => {
    const sheet = document.getElementById('overview-sheet');
    const box = sheet.getBoundingClientRect();
    const before = window.scrollY;
    sheet.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: box.left + box.width / 2,
      clientY: box.top + box.height * 0.8, pointerId: 1,
    }));
    return { before, after: window.scrollY };
  })()`);
  check(jumped.after > jumped.before + 200,
    `clicking near the foot of the pane moved the page from ${jumped.before} to ${jumped.after}`,
    `clicking the pane jumps the page to that part of the capture (${jumped.before} to ${jumped.after})`);

  await evaluate(cdp, session, 'window.scrollTo(0, 0)');
  await sleep(120);
}

/**
 * F3, the rating nudge.
 *
 * The rules are unit tested in test/nudge.test.js. What cannot be tested there
 * is that the line actually appears, that it does not fork on sentiment, and
 * that "Don't ask again" is written down rather than merely obeyed for now.
 */
async function exerciseNudge(cdp, session, check) {
  console.log('\nasking for a rating, once:');

  const showing = await evaluate(cdp, session, 'document.getElementById("nudge").hidden === false');
  check(showing,
    'the fifth capture did not ask for a rating',
    'the fifth clean capture asks, once');
  if (!showing) return;

  const counted = await evaluate(cdp, session,
    `new Promise((r) => chrome.storage.local.get(['captureCount', 'nudgesShown'], r))`);
  check(counted.captureCount === 5 && counted.nudgesShown === 1,
    `the capture was counted as ${JSON.stringify(counted)}`,
    `the ask is written down, so it cannot happen twice (${JSON.stringify(counted)})`);

  // NO REVIEW GATING
  //
  // The pattern this refuses is a sentiment fork: "Enjoying it?" with Yes going
  // to the store and No going to a feedback form, which keeps unhappy users out
  // of the public record. There is one ask, and the feedback link sits beside it
  // rather than behind it, so both are reachable without answering anything.
  const shape = await evaluate(cdp, session, `(() => {
    const box = document.getElementById('nudge');
    return {
      words: box.textContent.replace(/\s+/g, ' ').trim(),
      buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
    };
  })()`);
  check(shape.buttons.length === 3,
    `the nudge offers ${shape.buttons.length} choices: ${shape.buttons.join(' / ')}`,
    `one ask, a way to complain instead, and a way out (${shape.buttons.join(' / ')})`);
  check(!/enjoying|do you like|are you happy/i.test(shape.words),
    `the nudge asks how you feel first, which is the sentiment fork: "${shape.words}"`,
    'it asks for the rating rather than asking how you feel first');

  // The address is the store, and it is built from this extension's real id.
  const target = await evaluate(cdp, session, `(() => {
    const opened = [];
    const real = chrome.tabs.create;
    chrome.tabs.create = (o) => { opened.push(o.url); };
    document.getElementById('nudge-rate').click();
    chrome.tabs.create = real;
    return { opened, hidden: document.getElementById('nudge').hidden };
  })()`);
  const wanted = `https://chromewebstore.google.com/detail/${await evaluate(cdp, session, 'chrome.runtime.id')}/reviews`;
  check(target.opened[0] === wanted,
    `Rate it opened ${target.opened[0]} rather than ${wanted}`,
    'Rate it opens this extension\'s own reviews page');
  check(target.hidden,
    'the nudge stayed on screen after it was answered',
    'and the line goes once it has been answered');

  // A dismissal is permanent, which means written down, not merely obeyed.
  await evaluate(cdp, session, `(() => {
    document.getElementById('nudge').hidden = false;
    document.getElementById('nudge-never').click();
  })()`);
  await sleep(200);
  const never = await evaluate(cdp, session,
    `new Promise((r) => chrome.storage.local.get(['nudgeDone'], r))`);
  check(never.nudgeDone === true,
    'Don\'t ask again was not written down, so it would ask again next time',
    'Don\'t ask again is written down, so it is permanent');
}

/**
 * F43. A caption wraps inside a width set by its two side handles.
 *
 * The check is not that a number changed. It is that the words rearranged
 * themselves: the block got narrower and taller while the type stayed the size
 * it was, which is the difference between wrapping and scaling and is the whole
 * point of the feature.
 *
 * The handle is found by looking for the handles the editor drew rather than by
 * arithmetic repeated from the source. A handle this test can compute but nobody
 * can see is exactly the bug worth catching.
 */
async function exerciseTextWrap(cdp, session, check, p) {
  console.log('\na caption that wraps inside a width you set:');

  const settle = async () => {
    await evaluate(cdp, session,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await moveTo(cdp, session, { x: 6, y: 6 });
    await sleep(140);
  };

  // A colour nothing else on the canvas is using, so the glyphs can be counted
  // on their own. Set here rather than inherited from whatever ran before.
  await clickButton(cdp, session, '[data-pop="pop-text"]');
  await clickButton(cdp, session, '#pop-text-colour [data-paint="text"][data-colour="#22c55e"]');
  await evaluate(cdp, session, 'document.body.click()');
  await sleep(120);

  // Ink, in the caption's own colour, somewhere clear of everything else.
  const spot = p(0.14, 0.24);
  const inkBox = () => evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    const sx = c.width / box.width;
    const sy = c.height / box.height;
    const ox = Math.max(0, Math.round((${spot.x} - box.left) * sx) - 60);
    const oy = Math.max(0, Math.round((${spot.y} - box.top) * sy) - 60);
    const w = Math.min(c.width - ox, 1100);
    const h = Math.min(c.height - oy, 800);
    const d = c.getContext('2d').getImageData(ox, oy, w, h).data;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        if (Math.abs(d[i] - 34) < 60 && Math.abs(d[i + 1] - 197) < 60 && Math.abs(d[i + 2] - 94) < 60) {
          n += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return n > 0 ? { w: maxX - minX + 1, h: maxY - minY + 1, n, x: ox + minX, y: oy + minY } : { n: 0, w: 0, h: 0 };
  })()`);

  // Where the editor drew the east handle, in client coordinates.
  //
  // Scanned only around the caption. A first version looked at the whole canvas
  // and took the rightmost handle pixel together with the vertical middle of
  // every handle pixel on it, which are two different shapes' worth of chrome
  // the moment anything else has ever been selected: it aimed thirty three
  // pixels above the caption and pressed on nothing.
  const eastHandle = (ink) => evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    const pad = 44;
    const ox = Math.max(0, ${ink.x} - pad);
    const oy = Math.max(0, ${ink.y} - pad);
    const w = Math.min(c.width - ox, ${ink.w} + pad * 2);
    const h = Math.min(c.height - oy, ${ink.h} + pad * 2);
    const d = c.getContext('2d').getImageData(ox, oy, w, h).data;
    const near = (i) => Math.abs(d[i] - 99) < 26 && Math.abs(d[i + 1] - 102) < 26
      && Math.abs(d[i + 2] - 241) < 26;
    let maxX = -1, n = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!near((y * w + x) * 4)) continue;
        n += 1;
        if (x > maxX) maxX = x;
      }
    }
    if (n === 0) return null;
    // The vertical middle of the handle pixels in the rightmost few columns,
    // which is the east handle and the two corners above and below it.
    let minY = 1e9, maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = Math.max(0, maxX - 3); x <= maxX; x += 1) {
        if (!near((y * w + x) * 4)) continue;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return {
      x: box.left + ((ox + maxX) / c.width) * box.width,
      y: box.top + ((oy + (minY + maxY) / 2) / c.height) * box.height,
      pixels: n,
    };
  })()`);

  await clickButton(cdp, session, '[data-tool="text"]');
  await dragOn(cdp, session, spot, spot, 1);
  await sleep(160);
  await evaluate(cdp, session, `(() => {
    const i = document.querySelector('.text-entry');
    if (!i) return 'none';
    i.value = 'wrap these words onto more lines please';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(200);
  await settle();

  const one = await inkBox();
  check(one.n > 60,
    `the caption drew only ${one.n} pixels, so nothing below can be measured`,
    `the caption drew one long line (${one.w} by ${one.h})`);
  if (one.n <= 60) return;

  // Pick it up, so the handles are on screen to be found. The click goes into
  // the middle of the ink rather than at the corner it was typed from: the top
  // left of a text block is above and left of the first glyph, so a click there
  // can miss the shape entirely.
  await clickButton(cdp, session, '[data-tool="select"]');
  await dragOn(cdp, session,
    { x: spot.x + one.w * 0.3, y: spot.y + one.h * 0.5 },
    { x: spot.x + one.w * 0.3, y: spot.y + one.h * 0.5 }, 1);
  await sleep(180);

  const picked = await evaluate(cdp, session, 'document.getElementById("delete").disabled === false');
  check(picked,
    'the caption could not be selected, so there is no handle to drag',
    'the caption is selected');
  if (!picked) return;

  const handle = await eastHandle(one);
  check(handle && handle.pixels > 20,
    'no handles were drawn for the selected caption',
    `the caption carries handles (east side at ${Math.round(handle?.x ?? -1)}, ${Math.round(handle?.y ?? -1)})`);
  if (!handle) return;

  // Drag the east side left, to about half the width it had.
  await dragOn(cdp, session, { x: handle.x, y: handle.y },
    { x: handle.x - (one.w * 0.45), y: handle.y }, 10);
  await sleep(220);
  await settle();

  const two = await inkBox();
  check(two.w < one.w * 0.8,
    `dragging the side handle did not narrow the caption (${one.w} to ${two.w})`,
    `dragging the side handle narrows the caption (${one.w} to ${two.w})`);
  check(two.h > one.h * 1.4,
    `the caption did not grow taller, so the words did not wrap (${one.h} to ${two.h})`,
    `and it grows taller, because the words wrapped (${one.h} to ${two.h})`);

  // The decisive one. Scaling would have shrunk the type and taken the ink with
  // it; wrapping rearranges the same glyphs, so the ink is about what it was.
  check(two.n > one.n * 0.75,
    `the type shrank rather than wrapping: ${one.n} pixels of ink became ${two.n}`,
    `the type stayed the size it was, so this is wrapping and not scaling (${one.n} to ${two.n})`);

  // Put the page back for whatever runs next.
  let ink = (await inkBox()).n;
  for (let i = 0; i < 10 && ink > 30; i += 1) {
    await clickButton(cdp, session, '#undo');
    await sleep(120);
    ink = (await inkBox()).n;
  }
  check(ink <= 30,
    `the wrapped caption survived every undo this check had (${ink} pixels left)`,
    'the check leaves the canvas the way it found it');
}

async function exerciseTheme(cdp, session, check) {
  const read = async () =>
    JSON.parse(await evaluate(cdp, session, `JSON.stringify({
      stamped: document.documentElement.getAttribute('data-theme'),
      label: document.getElementById('theme').getAttribute('aria-label'),
      title: document.getElementById('theme').title,
      glyph: [...document.querySelectorAll('#theme svg')]
        .filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.id),
    })`));

  const seen = [await read()];
  for (let i = 0; i < 3; i += 1) {
    await evaluate(cdp, session, `document.getElementById('theme').click()`, { userGesture: true });
    await sleep(220);
    seen.push(await read());
  }

  check(seen[0].stamped === null, `the theme started stamped as ${seen[0].stamped}`,
    'the theme starts on system, which stamps nothing and follows the machine');
  check(seen[1].stamped === 'light' && seen[2].stamped === 'dark' && seen[3].stamped === null,
    `the theme cycled to ${seen.slice(1).map((s) => s.stamped).join(', ')}, expected light, dark, system`,
    'one press each: light, dark, and back to system');
  check(seen.every((s) => s.glyph.length === 1),
    `a step showed ${seen.map((s) => s.glyph.length).join(',')} glyphs, expected one each`,
    'exactly one glyph is showing at a time');
  check(seen.every((s) => s.label && s.label === s.title),
    'the theme button label and tooltip disagree',
    'the label and the tooltip are the same sentence, so nobody is told a different thing');
  check(/system/i.test(seen[0].label) && /light/i.test(seen[0].label),
    `the label does not say where it is and where it goes: ${seen[0].label}`,
    `the label says both halves (${seen[0].label})`);
}

/**
 * The cursor, and the outline under the pointer.
 *
 * A canvas has no hover states of its own, so every shape on it looked exactly as
 * clickable as the empty pixels beside it: the cursor changed only when the tool
 * changed. These are the three answers a click can have, and the cursor has to
 * give the right one before the click rather than after it.
 */
/**
 * What the export contains, and what it must not.
 *
 * `flatten()` hides the chrome by nulling the selection, which covers the dashed
 * box and the handles. It never cleared `hoverId`, so the hover outline was
 * still drawn, and an export with the pointer resting on a shape baked a 1.5px
 * indigo rectangle into the saved PNG and PDF. Nothing caught it because every
 * export in this harness, and most by hand, is reached by moving the pointer to
 * a button, which fires `pointerleave` on the way and clears the hover.
 *
 * The click and the read happen in one evaluated statement, and that is the
 * whole trick. `encode()` calls `flatten()` in its synchronous prefix, before
 * its first await, so the canvas holds the pixels being encoded when the next
 * line runs. Reading it in a second round trip does not work: the clipboard
 * write fails immediately in a headless profile, `finally` calls
 * `restoreSelection()`, and the canvas is back to normal before the message
 * arrives. That version of this check passed against the bug.
 *
 * One check stands in for every chrome bug of this shape, including the ones not
 * written yet: multi-selection member outlines and the marquee draw in the same
 * place and would both fail it.
 */
async function exportSignature(cdp, session) {
  return evaluate(cdp, session, `(() => {
    document.getElementById('copy').click();
    const c = document.getElementById('canvas');
    const g = c.getContext('2d', { willReadFrequently: true });
    const { data } = g.getImageData(0, 0, Math.min(900, c.width), Math.min(600, c.height));
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i] + data[i + 1] * 3 + data[i + 2] * 7;
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  })()`);
}

async function exerciseExportChrome(cdp, session, check, p) {
  // Self contained: it draws the shape it hovers. Leaning on shapes an earlier
  // check happened to leave behind is how this check first passed against the
  // bug it exists to catch.
  await clickButton(cdp, session, '[data-tool="rect"]');
  await dragOn(cdp, session, p(0.25, 0.30), p(0.45, 0.45));
  await sleep(150);

  // Drawing selects the new shape, and hover is suppressed on the selection, so
  // it has to be dropped before the pointer goes back over it.
  await clickButton(cdp, session, '[data-tool="select"]');
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await moveTo(cdp, session, p(0.9, 0.95));
  await sleep(150);

  // Prove the pointer is actually over the shape. Without this the check passes
  // when the hover never happened, which is a green run that tested nothing.
  await moveTo(cdp, session, p(0.35, 0.375));
  await sleep(150);
  const cursor = await evaluate(cdp, session, `document.getElementById('canvas').style.cursor`);
  check(cursor === 'move',
    `the pointer was not over a shape (cursor "${cursor}"), so the export check proved nothing`,
    'the pointer is resting on an unselected shape, which draws a hover outline');

  // Export without moving the pointer, the way a keyboard user reaches it.
  const hovered = await exportSignature(cdp, session);
  await sleep(400);
  await moveTo(cdp, session, p(0.9, 0.95));
  await sleep(250);
  const clean = await exportSignature(cdp, session);
  await sleep(400);

  check(hovered === clean,
    'exporting with the pointer resting on a shape baked the hover outline into the file',
    'the export contains no chrome, wherever the pointer happens to be');

  // Leave the canvas as it was found, so later checks are not reading this one's
  // shape.
  await evaluate(cdp, session, `document.getElementById('undo').click()`, { userGesture: true });
  await sleep(200);
}

/**
 * A caption can carry a frame and a plate, and choosing a frame colour must not
 * recolour the words.
 *
 * That last part is the bug this workstream closes. `colour` used to mean the
 * glyphs on a text shape and the stroke on every other shape, while the Border
 * palette wrote `colour` on whatever was selected. So selecting a caption and
 * picking a border colour silently changed the text colour. Now `ink` is the
 * glyphs and `colour` is the frame, on every shape the same way.
 */
async function exerciseTextFrame(cdp, session, check, p) {
  const scan = { x: 0, y: 0, w: 900, h: 600 };
  const GREEN = [34, 197, 94];
  const BLUE = [59, 130, 246];

  const settle = async () => {
    await evaluate(cdp, session,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await moveTo(cdp, session, { x: 6, y: 6 });
    await sleep(130);
  };

  // A caption in a colour nothing else on the canvas is using, so the glyph
  // pixels can be counted on their own.
  await clickButton(cdp, session, '[data-pop="pop-text"]');
  await clickButton(cdp, session, '#pop-text-colour [data-paint="text"][data-colour="#22c55e"]')
    .catch(() => {});
  await clickButton(cdp, session, '[data-pop="pop-text-colour"]');
  await clickButton(cdp, session, '[data-paint="text"][data-colour="#22c55e"]');
  await evaluate(cdp, session, 'document.body.click()');

  await clickButton(cdp, session, '[data-tool="text"]');
  await dragOn(cdp, session, p(0.30, 0.78), p(0.30, 0.78), 1);
  await sleep(140);
  await evaluate(cdp, session, `(() => {
    const i = document.querySelector('.text-entry');
    if (!i) return 'none';
    i.value = 'Framed caption';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(180);
  await settle();

  const glyphsPlain = await countColour(cdp, session, scan, GREEN);
  check(glyphsPlain > 30,
    `the caption drew only ${glyphsPlain} pixels in its own colour, so nothing below can be measured`,
    `the caption drew ${glyphsPlain} pixels in its own ink colour`);
  if (glyphsPlain <= 30) return;

  // Select it and give it a frame colour from the Border palette.
  await clickButton(cdp, session, '[data-tool="select"]');
  await dragOn(cdp, session, p(0.30, 0.78), p(0.30, 0.78), 1);
  await sleep(120);
  const selected = await evaluate(cdp, session,
    'document.getElementById("delete").disabled === false');
  check(selected, 'could not select the caption to frame it', 'the caption is selectable');
  if (!selected) return;

  const blueBefore = await countColour(cdp, session, scan, BLUE);
  await clickButton(cdp, session, '[data-pop="pop-border"]');
  await clickButton(cdp, session, '[data-paint="border"][data-colour="#3b82f6"]');
  await evaluate(cdp, session, 'document.body.click()');
  await settle();

  const glyphsFramed = await countColour(cdp, session, scan, GREEN);
  const blueAfter = await countColour(cdp, session, scan, BLUE);

  check(blueAfter > blueBefore + 40,
    `choosing a border colour drew no frame (${blueBefore} to ${blueAfter} blue pixels)`,
    `choosing a border colour drew a frame around the caption (${blueAfter - blueBefore} pixels)`);

  // The words are untouched. A small change is allowed for antialiasing where
  // the frame passes near a glyph, but the glyphs cannot have been recoloured.
  check(glyphsFramed > glyphsPlain * 0.85,
    `framing the caption changed its own colour: ${glyphsPlain} pixels of ink became ${glyphsFramed}`,
    `framing the caption left the words the colour they were (${glyphsPlain} to ${glyphsFramed})`);

  // THE FRAME BLOCK
  //
  // The frame and the plate are the text shape's stroke and fill, so the block
  // in the text inspector and the Border and Fill wells write the same two
  // properties. That is the whole design, and it is only true if the block
  // shows what the Border well just did and can undo it.
  // settle() presses Escape, which drops the selection, and the inspector
  // shows the pending style the moment nothing is selected. Every switch below
  // is therefore clicked with the caption picked up again first, which is also
  // what a person does.
  const holdCaption = async () => {
    await clickButton(cdp, session, '[data-tool="select"]');
    await dragOn(cdp, session, p(0.30, 0.78), p(0.30, 0.78), 1);
    await sleep(120);
    await clickButton(cdp, session, '[data-pop="pop-text"]');
    await sleep(90);
  };

  await holdCaption();
  const knows = await evaluate(cdp, session,
    `document.getElementById('frame-hex').value.toLowerCase() === '#3b82f6'`);
  check(knows,
    'the Frame well did not notice the frame the Border well had just drawn',
    'the Frame well shows the frame the Border well drew');

  // Taking the frame off is the no-colour swatch in the Frame popover, not a
  // switch beside it. That is the change: "off" is a colour you can pick, the
  // same way it already was for a fill.
  await clickButton(cdp, session, '[data-pop="pop-frame-colour"]');
  await clickButton(cdp, session, '[data-paint-none="frame"]');
  await settle();
  const blueOff = await countColour(cdp, session, scan, BLUE);
  check(blueOff < blueAfter - 40,
    `no-colour in the Frame popover did not take the frame off (${blueAfter} to ${blueOff} blue pixels)`,
    `no-colour in the Frame popover takes the frame off (${blueAfter} to ${blueOff} blue pixels)`);

  await holdCaption();
  await clickButton(cdp, session, '[data-pop="pop-frame-colour"]');
  await clickButton(cdp, session, '[data-paint="frame"][data-colour="#3b82f6"]');
  await settle();
  const blueBack = await countColour(cdp, session, scan, BLUE);
  check(blueBack > blueOff + 40,
    `picking a colour would not put the frame back (${blueOff} to ${blueBack} blue pixels)`,
    `picking a colour puts the frame back (${blueOff} to ${blueBack} blue pixels)`);

  // THE FRAME'S OWN OPACITY
  //
  // New, and the reason the popovers were rebuilt from one description. A frame
  // at nought per cent is invisible without losing the colour it had, which is
  // what the well still showing blue proves.
  await holdCaption();
  await clickButton(cdp, session, '[data-pop="pop-frame-colour"]');
  await setRange(cdp, session, 'frame-opacity', 0);
  await settle();
  const blueClear = await countColour(cdp, session, scan, BLUE);
  const stillBlue = await evaluate(cdp, session,
    `document.getElementById('frame-hex').value.toLowerCase() === '#3b82f6'`);
  check(blueClear < blueBack - 40,
    `the frame opacity slider did not fade the frame (${blueBack} to ${blueClear} blue pixels)`,
    `the frame opacity slider fades the frame out (${blueBack} to ${blueClear} blue pixels)`);
  check(stillBlue,
    'fading the frame threw away the colour it had',
    'and the well keeps the colour, so one drag brings it back');

  await holdCaption();
  await clickButton(cdp, session, '[data-pop="pop-frame-colour"]');
  await setRange(cdp, session, 'frame-opacity', 100);
  await settle();

  // THE PLATE
  //
  // It was a switch. It is an opacity now, off at nought, and it must still go
  // behind the words rather than over them.
  await holdCaption();
  await setRange(cdp, session, 'plate-opacity', 100);
  await settle();
  const glyphsPlated = await countColour(cdp, session, scan, GREEN);
  const platedAt = await evaluate(cdp, session,
    'document.getElementById("plate-opacity-out").textContent');
  check(platedAt === '100%',
    `the plate opacity readout says ${platedAt} after being dragged to the top`,
    'the plate opacity readout says what the slider was dragged to');
  check(glyphsPlated > glyphsPlain * 0.85,
    `the plate covered the words it sits behind: ${glyphsPlain} pixels of ink became ${glyphsPlated}`,
    `the plate goes behind the words rather than over them (${glyphsPlated} pixels of ink)`);

  await holdCaption();
  await setRange(cdp, session, 'plate-opacity', 0);
  await settle();

  // Undo until the caption itself is gone, not a fixed number of times. This
  // block adds an undo step every time a switch is thrown, so a count typed
  // here goes stale the moment a check is added, and one undo too many takes a
  // shape belonging to an earlier check with it. The loupe check is what
  // noticed: with one shape missing from the page the redaction had less to
  // change, and a check three hundred lines away started reporting a leak.
  let ink = await countColour(cdp, session, scan, GREEN);
  for (let i = 0; i < 10 && ink > 30; i += 1) {
    await clickButton(cdp, session, '#undo');
    await settle();
    ink = await countColour(cdp, session, scan, GREEN);
  }
  check(ink <= 30,
    `the caption survived every undo this check had (${ink} pixels of ink left behind)`,
    'the frame block leaves the canvas the way it found it');
}

/**
 * Several shapes at once: marquee, shift click, group move, group delete, and
 * the keyboard.
 *
 * Everything here works in a corner of the capture nothing else has drawn in,
 * and asserts that corner is empty before it starts, because a check that picks
 * up someone else's leftover shape reports whatever that shape happens to do.
 */
async function exerciseMultiSelect(cdp, session, check, p) {
  const NW = [0.56, 0.74];
  const SE = [0.94, 0.96];
  const mid = (a, b, f) => a + (b - a) * f;
  const at = (fx, fy) => p(mid(NW[0], SE[0], fx), mid(NW[1], SE[1], fy));

  // Not canvasSignature: that one hashes only the top left 900 by 600 of the
  // canvas, and this check works in a far corner where nothing else has drawn.
  // Hashing a region that does not contain the shapes reports "nothing moved"
  // whatever happens.
  const signature = () => evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const g = c.getContext('2d', { willReadFrequently: true });
    const { data } = g.getImageData(0, 0, c.width, Math.min(c.height, 900));
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i] + data[i + 1] * 3 + data[i + 2] * 7;
      hash = Math.imul(hash, 16777619);
    }
    return String(hash >>> 0);
  })()`);

  // Two different jobs, and mixing them up cost a round of this check.
  // `park` only moves the pointer off the canvas, so the hover outline is not
  // in the picture; it must NOT deselect, because a sweep is followed by a
  // command that acts on the selection. `settle` also drops the selection, and
  // every signature is taken after one, so two measurements can never differ
  // merely because one of them had a dashed outline in it.
  /**
   * A hash of one rectangle of the canvas, given two screen points.
   *
   * The whole-area signature answers "did anything change", which a move of a
   * single shape also satisfies. To prove that dragging ONE member moved the
   * OTHER one, the other one needs measuring on its own.
   */
  const regionSignature = (a, b) => evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    const toCanvas = (px, py) => ({
      x: Math.round(((px - box.left) / box.width) * c.width),
      y: Math.round(((py - box.top) / box.height) * c.height),
    });
    const p1 = toCanvas(${a.x}, ${a.y});
    const p2 = toCanvas(${b.x}, ${b.y});
    const x = Math.max(0, Math.min(p1.x, p2.x));
    const y = Math.max(0, Math.min(p1.y, p2.y));
    const w = Math.min(c.width - x, Math.abs(p2.x - p1.x));
    const h = Math.min(c.height - y, Math.abs(p2.y - p1.y));
    if (w < 2 || h < 2) return 'empty';
    const g = c.getContext('2d', { willReadFrequently: true });
    const { data } = g.getImageData(x, y, w, h);
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i] + data[i + 1] * 3 + data[i + 2] * 7;
      hash = Math.imul(hash, 16777619);
    }
    return String(hash >>> 0);
  })()`);

  const park = async () => {
    await moveTo(cdp, session, { x: 6, y: 6 });
    await sleep(110);
  };
  const escape = async () => {
    await evaluate(cdp, session,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(110);
  };
  const settle = async () => {
    await escape();
    await park();
  };
  const anySelected = async () => evaluate(cdp, session,
    'document.getElementById("delete").disabled === false');
  const pick = async (kind) => {
    await clickButton(cdp, session, '[data-pop="pop-shapes"]');
    await clickButton(cdp, session, `#pop-shapes [data-shape="${kind}"]`);
    await evaluate(cdp, session, 'document.body.click()');
    await sleep(80);
  };
  const useSelect = async () => {
    await clickButton(cdp, session, '[data-tool="select"]');
    await escape();
  };

  // The two shapes live between fy 0.10 and 0.55, so a sweep along fy 0.30 to
  // 0.35 starting at fx 0.02 begins on empty canvas and only CLIPS both of
  // them. Starting inside a shape would be a move drag, not a marquee, which is
  // exactly the mistake the first version of this check made: it reported that
  // a marquee selected both while actually dragging one across the other.
  const sweep = async () => {
    await dragOn(cdp, session, at(0.02, 0.30), at(0.98, 0.35));
    await park();
  };

  await useSelect();
  await settle();
  const emptyArea = await signature();
  await dragOn(cdp, session, at(0.5, 0.5), at(0.5, 0.5), 1);
  const clear = !(await anySelected());
  check(clear,
    'the corner this check draws in already had a shape in it',
    'the multi-select test area is empty before it starts');
  if (!clear) return;

  await pick('rect');
  await dragOn(cdp, session, at(0.05, 0.10), at(0.40, 0.55));
  await pick('ellipse');
  await dragOn(cdp, session, at(0.55, 0.10), at(0.95, 0.55));
  await useSelect();
  await settle();
  const withBoth = await signature();
  check(withBoth !== emptyArea, 'the two shapes did not draw',
    'two shapes drawn in the test area');

  // A sweep that only clips both must catch both. Proved by deleting: if the
  // area returns to exactly what it was before either shape existed, both were
  // in the selection. Checking that "something" is selected would pass with one.
  await sweep();
  check(await anySelected(), 'a marquee across both shapes selected nothing',
    'a marquee that only clips both shapes selects them');
  await clickButton(cdp, session, '#delete');
  await settle();
  const afterDelete = await signature();
  check(afterDelete === emptyArea,
    `deleting the marquee selection did not remove both shapes (empty ${emptyArea}, after delete ${afterDelete})`,
    'a marquee selects every shape it touches, and Delete removes all of them');

  await clickButton(cdp, session, '#undo');
  await settle();
  const restored = await signature();
  check(restored === withBoth,
    `undoing a group delete did not bring both shapes back in one step (wanted ${withBoth}, got ${restored})`,
    'a group delete is one undo step, however many shapes it removed');
  if (restored !== withBoth) return;

  // Drag the set by one of its members. The other has to come with it, and
  // that is measured on the OTHER one alone: a whole-canvas hash changes just
  // as happily when only the shape under the pointer moves, so it cannot tell
  // a group move from an ordinary one.
  const ellipseArea = [at(0.48, 0.02), at(1.0, 0.62)];
  const ellipseBefore = await regionSignature(...ellipseArea);
  await sweep();
  await dragOn(cdp, session, at(0.20, 0.32), at(0.20, 0.18));
  await settle();
  const afterMove = await signature();
  const ellipseAfter = await regionSignature(...ellipseArea);
  check(afterMove !== withBoth, 'dragging a member of the selection moved nothing',
    'dragging one member of a selection moved something');
  check(ellipseAfter !== ellipseBefore,
    'dragging the rectangle left the ellipse where it was, so the drag moved one shape and not the selection',
    'dragging the rectangle moved the ellipse too, so the whole selection travelled');
  await clickButton(cdp, session, '#undo');
  await settle();
  const afterMoveUndo = await signature();
  check(afterMoveUndo === withBoth,
    `undoing the group move did not put both shapes back in one step (wanted ${withBoth}, got ${afterMoveUndo})`,
    'a group move is one undo step');

  // Arrow keys move the selection, and holding one is a single undo step.
  await sweep();
  for (let i = 0; i < 6; i += 1) {
    await evaluate(cdp, session,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  }
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))`);
  await settle();
  const afterNudge = await signature();
  check(afterNudge !== withBoth, 'the arrow keys moved nothing',
    'the arrow keys nudge the selection');
  await clickButton(cdp, session, '#undo');
  await settle();
  const afterNudgeUndo = await signature();
  check(afterNudgeUndo === withBoth,
    `a burst of six arrow keys took more than one undo to put back (wanted ${withBoth}, got ${afterNudgeUndo})`,
    'a burst of arrow keys is one undo step, not one per key press');

  // Shift click adds to the set without starting a drag.
  await escape();
  await dragOn(cdp, session, at(0.20, 0.32), at(0.20, 0.32), 1);
  await dragOn(cdp, session, at(0.75, 0.32), at(0.75, 0.32), 1, ['shift']);
  await park();
  await clickButton(cdp, session, '#delete');
  await settle();
  const afterShiftDelete = await signature();
  check(afterShiftDelete === emptyArea,
    `shift clicking the second shape did not add it to the selection (empty ${emptyArea}, got ${afterShiftDelete})`,
    'shift clicking adds a shape to the selection rather than replacing it');
  await clickButton(cdp, session, '#undo');
  await settle();

  // Alt dragging duplicates: the original stays and the copy travels. Proved by
  // deleting the selection afterwards, which removes only the copy, leaving a
  // canvas that is neither empty nor what it was before the drag.
  await escape();
  await dragOn(cdp, session, at(0.20, 0.32), at(0.20, 0.32), 1);
  await dragOn(cdp, session, at(0.20, 0.32), at(0.22, 0.90), 8, ['alt']);
  await settle();
  const afterAlt = await signature();
  check(afterAlt !== withBoth, 'alt dragging changed nothing at all',
    'alt dragging a shape changed the canvas');
  await dragOn(cdp, session, at(0.22, 0.90), at(0.22, 0.90), 1);
  await park();
  await clickButton(cdp, session, '#delete');
  await settle();
  const afterCopyRemoved = await signature();
  check(afterCopyRemoved === withBoth,
    `alt drag did not leave the original behind: removing the copy gave ${afterCopyRemoved}, wanted ${withBoth}`,
    'alt dragging leaves the original where it was and drags a copy');

  // What the toolbar shows for a mixed selection.
  //
  // There is no single answer, so the rule is: show the value every member
  // agrees on, and fall back to the pending style where they disagree. Never
  // blank and never indeterminate, because the swatch is also the control that
  // sets the value.
  //
  // Stroke width is used to test it because it can be set on the shapes and
  // then changed on the pending style alone, which is what makes "agreed" and
  // "pending" tell apart. A colour cannot: setting one sets both.
  const setWidth = async (px) => {
    await clickButton(cdp, session, '[data-pop="pop-style"]');
    await clickButton(cdp, session, `[data-width="${px}"]`);
    await evaluate(cdp, session, 'document.body.click()');
    await sleep(90);
  };
  const shownWidth = () => evaluate(cdp, session, `(() => {
    const on = document.querySelector('[data-width][aria-pressed="true"]');
    return on ? on.dataset.width : 'none';
  })()`);

  await sweep();
  await setWidth(7);              // both shapes become 7, and so does the pending style
  await escape();
  await setWidth(2);              // pending is now 2, the shapes are still 7
  await sweep();
  const agreedWidth = await shownWidth();
  check(agreedWidth === '7',
    `two shapes that both have a 7px stroke showed ${agreedWidth}px in the toolbar`,
    'a selection whose members agree shows the value they agree on');

  // Now make them disagree, and set the pending style to a third value.
  await escape();
  await dragOn(cdp, session, at(0.20, 0.32), at(0.20, 0.32), 1);
  await setWidth(11);             // one shape is 11, the other is still 7
  await escape();
  await setWidth(2);              // pending is 2 again
  await sweep();
  const mixedWidth = await shownWidth();
  check(mixedWidth === '2',
    `a selection of a 7px and an 11px shape showed ${mixedWidth}px instead of falling back to the pending 2px`,
    'a selection whose members disagree falls back to the pending style');

  // Cmd+A selects everything on the canvas, not only what is in this corner,
  // so it is checked by counting rather than by comparing the whole picture.
  await escape();
  await evaluate(cdp, session, `document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))`);
  await sleep(140);
  check(await anySelected(), 'Cmd+A selected nothing', 'Cmd+A selects every shape on the canvas');
  await escape();

  // Leave the corner as it was found.
  await escape();
  await sweep();
  await clickButton(cdp, session, '#delete');
  await park();
}

/**
 * The twelve shapes, drawn for real and then clicked for real.
 *
 * Two questions per shape, and only the second one needs a geometry table: does
 * it put ink on the canvas, and does clicking its middle select it. The third
 * question is the one that justifies the whole table, and only the shapes with
 * an empty bounding box corner can answer it.
 */
/**
 * The paint order, and the menu that is the only way to reach it.
 *
 * Two opaque boxes overlapping, and the question every check below asks is the
 * one a reader asks: which one is on top. Counting each colour over the whole
 * canvas answers it without knowing where the boxes ended up, and a box moving
 * behind another has to give pixels back to the one it was covering.
 *
 * The menu is opened with a real right click rather than a dispatched event,
 * because the interesting failures are Chrome not reaching the handler and the
 * browser's own menu opening over the top of ours.
 */
/** "345 KB" and "1.2 MB" back into bytes, so two of them can be compared. */
function bytesOf(text) {
  const m = /^([\d.]+)\s*(KB|MB|B)$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'MB' ? 1024 * 1024 : m[2] === 'KB' ? 1024 : 1);
}

/**
 * The file sizes in the download menu, and the quality control they exist for.
 *
 * A quality slider with no readout is guesswork: nobody moves one because they
 * want "quality 78", they move it because the file is too big to send. So the
 * check is not that a number appears, it is that the number answers: dragging
 * quality down has to make the two lossy formats smaller and leave the two
 * lossless ones untouched, and untouched means not even re-measured.
 */
async function exerciseFileSizes(cdp, session, check) {
  const read = () =>
    evaluate(cdp, session, `JSON.stringify(Object.fromEntries(
      [...document.querySelectorAll('#formats [data-size]')].map((c) => [c.dataset.size, c.textContent])
    ))`).then(JSON.parse);

  const settled = (label) =>
    until(label, async () => {
      const shown = await read();
      return Object.values(shown).every((v) => v !== '…') ? shown : null;
    }, { timeoutMs: 90000, everyMs: 250 });

  // Opened, not toggled. Clicking #download flips the menu, so a block that ran
  // earlier and left it up closes it here instead, and everything below then
  // measures a menu that is not on screen: the sizes read as the ones the other
  // block's click produced, the slider check fails, and the wait for a lower
  // quality never ends because a hidden menu does not re-measure. Named rather
  // than quietly repaired, because the leak is the defect.
  const alreadyOpen = await evaluate(cdp, session,
    'document.getElementById("formats").hidden === false');
  check(!alreadyOpen,
    'the download menu was already open before the file size checks ran: something earlier left it up',
    'the download menu starts closed, so opening it is this block\'s own doing');
  if (!alreadyOpen) await clickButton(cdp, session, '#download');
  const full = await settled('every format to report a file size');
  const bytes = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, bytesOf(v)]));
  const missing = Object.entries(bytes).filter(([, v]) => !v).map(([k]) => k);
  check(missing.length === 0,
    `no readable file size for ${missing.join(', ')} (${JSON.stringify(full)})`,
    `every format reports what it would cost (${Object.entries(full).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  if (missing.length) return;

  // The menu has to survive being used. A slider inside a menu that closes on
  // the first click is a slider nobody can drag.
  await evaluate(cdp, session, `(() => {
    const q = document.getElementById('quality');
    q.value = '45';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(120);
  const stillOpen = await evaluate(cdp, session,
    'document.getElementById("formats").hidden === false');
  check(stillOpen, 'moving the quality slider closed the download menu',
    'the download menu stays open while the quality is being set');

  // The lossless rows must not even go blank: they are cached against a quality
  // of nothing, so a re-measure would be work done to produce the same number.
  const midDrag = await read();
  check(midDrag.png !== '…' && midDrag.pdf !== '…',
    `changing the quality re-measured a lossless format (png ${midDrag.png}, pdf ${midDrag.pdf})`,
    'changing the quality does not re-measure PNG or PDF');

  const lower = await settled('the lossy formats to re-measure at a lower quality');
  const after = Object.fromEntries(Object.entries(lower).map(([k, v]) => [k, bytesOf(v)]));

  check(after.jpeg < bytes.jpeg && after.webp < bytes.webp,
    `dropping the quality did not shrink the lossy formats (jpeg ${full.jpeg} to ${lower.jpeg}, webp ${full.webp} to ${lower.webp})`,
    `dropping the quality shrinks JPEG and WebP (${full.jpeg} to ${lower.jpeg}, ${full.webp} to ${lower.webp})`);
  check(lower.png === full.png && lower.pdf === full.pdf,
    `the quality changed a lossless format (png ${full.png} to ${lower.png}, pdf ${full.pdf} to ${lower.pdf})`,
    'and leaves PNG and PDF exactly where they were');

  // Put it back, because the saves that follow are checked against real files.
  await evaluate(cdp, session, `(() => {
    const q = document.getElementById('quality');
    q.value = '92';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluate(cdp, session, 'document.body.click()');
  await sleep(150);
}

/**
 * The confirmation, where the reader is actually looking.
 *
 * Both halves matter and the second is the one that rots: a button that lights
 * up and never goes out is a button that says "saved" about a file saved ten
 * minutes ago.
 */
async function exerciseConfirmation(cdp, session, check) {
  const lit = () => evaluate(cdp, session, `JSON.stringify({
    button: document.getElementById('download').classList.contains('done'),
    status: document.getElementById('status').classList.contains('done'),
    label: document.getElementById('download').getAttribute('aria-label'),
  })`).then(JSON.parse);

  // The saves above left their own confirmation up. Wait for it to go before
  // pressing anything, or this reads the previous answer and reports that the
  // button lit up for a save it never made.
  // Checked rather than merely waited on. A confirmation that never goes out is
  // exactly the defect this pass exists to catch, and a bare `until` here would
  // report it by aborting the whole run with a timeout instead of naming it.
  const cleared = await until('the previous confirmation to clear', async () => {
    const now = await lit();
    return now.button || now.status ? null : now;
  }, { timeoutMs: 15000, everyMs: 200 }).catch(() => null);
  check(Boolean(cleared),
    'a confirmation from an earlier save never went out: the toolbar is still announcing it',
    'a confirmation from an earlier save goes out on its own');
  if (!cleared) return;

  await evaluate(cdp, session, `document.getElementById('download').click()`);
  await evaluate(cdp, session,
    `document.querySelector('#formats [data-format="png"]').click()`, { userGesture: true });

  const on = await until('the download button to confirm the save', async () => {
    const now = await lit();
    return now.button ? now : null;
  }, { timeoutMs: 15000, everyMs: 120 }).catch(() => null);

  check(Boolean(on), 'saving lit nothing up: the reader is told only in the status line',
    'the button that was pressed answers, not only the status line');
  if (!on) return;

  check(on.status, 'the status line was not marked as an answer',
    'and the status line carries the same mark, so the sentence reads as the record');
  check(/saved as png/i.test(on.label),
    `the button's accessible name did not say what happened: ${on.label}`,
    `a screen reader is told too, not only the colour (${on.label})`);

  const off = await until('the confirmation to fade', async () => {
    const now = await lit();
    return !now.button && !now.status ? now : null;
  }, { timeoutMs: 15000, everyMs: 200 }).catch(() => null);

  check(Boolean(off), 'the confirmation never went out, so it now describes a save nobody remembers',
    'and it goes out again on its own');
  if (off) {
    check(/download/i.test(off.label),
      `the button kept the confirmation as its name: ${off.label}`,
      'the button takes its own name back');
  }
}

async function exercisePaintOrder(cdp, session, check, p) {
  const GREEN = [34, 197, 94];
  const BLUE = [59, 130, 246];
  const NW = [0.56, 0.74];
  const SE = [0.92, 0.95];
  const mid = (a, b, f) => a + (b - a) * f;
  const at = (fx, fy) => p(mid(NW[0], SE[0], fx), mid(NW[1], SE[1], fy));

  const state = await canvasState(cdp, session);
  const scan = { x: 0, y: 0, w: state.width, h: state.height };
  const counts = async () => ({
    green: await countColour(cdp, session, scan, GREEN),
    blue: await countColour(cdp, session, scan, BLUE),
  });
  const deselect = async () => {
    // Escape, not body.click(): a click on the body closes the popovers and
    // leaves the editor's selection exactly where it was, so the next colour
    // chosen restyles the shape just drawn instead of setting the pending
    // style. That is what turned the green box blue the first time this ran.
    await evaluate(cdp, session,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await evaluate(cdp, session, 'document.body.click()');
    await sleep(70);
  };
  const menuOpen = () => evaluate(cdp, session,
    'document.getElementById("ctx").hidden === false');
  const paint = async (colour) => {
    for (const kind of ['border', 'fill']) {
      await clickButton(cdp, session, `[data-pop="pop-${kind}"]`);
      await clickButton(cdp, session, `[data-paint="${kind}"][data-colour="${colour}"]`);
      await deselect();
    }
  };

  // The area is clear. Without this the counts below are somebody else's shapes.
  await clickButton(cdp, session, '[data-tool="select"]');
  await deselect();
  await dragOn(cdp, session, at(0.5, 0.5), at(0.5, 0.5), 1);
  await sleep(60);
  const clear = await evaluate(cdp, session,
    'document.getElementById("delete").disabled === true');
  check(clear,
    'the corner the paint order check draws in already had a shape in it',
    'the paint order test area is empty before the boxes are drawn');
  if (!clear) return;
  await deselect();

  // Empty canvas keeps Chrome's own menu. Ours must not appear there. Asked now,
  // while the area is known to be empty, rather than after two boxes fill it.
  await rightClickOn(cdp, session, at(0.5, 0.5));
  check(!(await menuOpen()),
    'the canvas menu opened over empty canvas, taking away Chrome\'s own menu for nothing',
    'right clicking empty canvas leaves Chrome\'s own menu alone');

  // Opaque, because two boxes at a third alpha blend into a third colour and
  // "which one is on top" stops having a pixel answer.
  await clickButton(cdp, session, '[data-pop="pop-fill"]');
  await evaluate(cdp, session, `(() => {
    const slider = document.getElementById('fill-opacity');
    slider.value = '100';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await deselect();

  const box = async (colour, from, to) => {
    await paint(colour);
    await clickButton(cdp, session, '[data-pop="pop-shapes"]');
    await clickButton(cdp, session, '#pop-shapes [data-shape="rect"]');
    await deselect();
    await dragOn(cdp, session, from, to);
    await deselect();
  };

  await box('#22c55e', at(0.04, 0.08), at(0.58, 0.92));
  await box('#3b82f6', at(0.42, 0.08), at(0.96, 0.92));

  const drawn = await counts();
  check(drawn.green > 200 && drawn.blue > 200,
    `the two boxes did not both draw (${drawn.green} green, ${drawn.blue} blue)`,
    `two overlapping boxes drawn (${drawn.green} green, ${drawn.blue} blue)`);
  if (!(drawn.green > 200 && drawn.blue > 200)) return;

  await rightClickOn(cdp, session, at(0.5, 0.5));
  const opened = await menuOpen();
  check(opened, 'right clicking a shape opened no menu', 'right clicking a shape opens the menu');
  if (!opened) return;

  // The blue box is on top, so it cannot go further forward and the menu has to
  // say so rather than offering a step that writes an undo entry doing nothing.
  const frontDisabled = await evaluate(cdp, session,
    'document.querySelector(\'#ctx [data-order="front"]\').disabled === true');
  check(frontDisabled,
    'the menu offered to bring the topmost shape further forward',
    'the menu greys out what the topmost shape cannot do');

  // One step back, not all the way. The two boxes are the last two shapes on a
  // canvas that several checks above have drawn on, so "send to back" puts the
  // blue box below everything and one step forward from there does not bring it
  // anywhere near the green box: the pixels would not move and the check would
  // report a bug that is not there. It is a step, so a step is what it asks for.
  await clickButton(cdp, session, '#ctx [data-order="backward"]');
  await sleep(140);
  const sent = await counts();
  check(sent.green > drawn.green && sent.blue < drawn.blue,
    `sending the blue box back a step changed nothing (${sent.green} green, ${sent.blue} blue)`,
    `sending a shape back a step puts back the shape it was covering (${drawn.green} to ${sent.green} green)`);

  check(await evaluate(cdp, session, 'document.getElementById("ctx").hidden === true'),
    'the menu stayed open after an item was chosen', 'choosing an item closes the menu');

  // The menu acted on the selection and has to leave it there: the keys below
  // are the same operation reached another way, and they are worth nothing if
  // choosing from the menu quietly puts the shape down.
  const stillHeld = await evaluate(cdp, session,
    'document.getElementById("delete").disabled === false');
  check(stillHeld,
    'choosing from the menu dropped the selection, so the keyboard has nothing to act on',
    'choosing from the menu leaves the shape selected');

  // One step forward on the keyboard, which with two shapes is all the way.
  // A real key event, not a dispatched one: a bracket needs a keyboard layout
  // to arrive as `]`, and this check exists to prove a person can press it.
  await pressKey(cdp, session, { key: ']', code: 'BracketRight', vk: 221 });
  await sleep(140);
  const stepped = await counts();
  check(stepped.blue > sent.blue && stepped.green < sent.green,
    `the ] key did not bring the selection forward (${stepped.green} green, ${stepped.blue} blue)`,
    'the ] key brings the selection one step forward');

  // And the accelerated pair, which goes all the way. From the very back the
  // green box is over it again, which is the same picture a step back gives and
  // is why the step above is the one that proves a step is a step.
  await pressKey(cdp, session,
    { key: '[', code: 'BracketLeft', vk: 219, modifiers: MODIFIERS.meta });
  await sleep(140);
  const dropped = await counts();
  check(dropped.green > stepped.green,
    `the accelerator with [ did not send the selection to the back (${dropped.green} green)`,
    `Cmd or Ctrl with [ sends the selection all the way back (${stepped.green} to ${dropped.green} green)`);

  // Undo has to put the order back, not only the shapes: the reorder is one
  // step, so three of them clear the two boxes and both order changes.
  let gone = await counts();
  for (let i = 0; i < 10 && (gone.green > 200 || gone.blue > 200); i += 1) {
    await clickButton(cdp, session, '#undo');
    await sleep(90);
    gone = await counts();
  }
  check(gone.green < 200 && gone.blue < 200,
    `undo left the paint order boxes on the canvas (${gone.green} green, ${gone.blue} blue)`,
    'undo removes the boxes and the reorders with them');

  // Put the fill back the way the rest of the run expects to find it.
  await clickButton(cdp, session, '[data-pop="pop-fill"]');
  await evaluate(cdp, session, `(() => {
    const slider = document.getElementById('fill-opacity');
    slider.value = '35';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-paint-none="fill"]').click();
    const hex = document.getElementById('border-hex');
    hex.value = '#ef4444';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await deselect();
}

async function exerciseShapes(cdp, session, check, p) {
  // Imported, not typed out again. This was a hand written list of twelve and
  // it was wrong within a release: two shapes were added to the popover and
  // this file went on testing the old twelve without a word. Every shape the
  // model offers is drawn here or the model has a shape nobody ever drew.
  const SHAPES = SHAPE_TOOLS;

  // A corner of the capture nothing else in this run has drawn in. Every check
  // below asserts the area is empty BEFORE it draws, because an earlier version
  // of this test clicked where a previous check had left an arrow and reported
  // that a rhombus was selectable in its empty corner. A check that passes
  // because of someone else's shape is worse than no check.
  const NW = [0.56, 0.74];
  const SE = [0.92, 0.95];
  const mid = (a, b, f) => a + (b - a) * f;
  const at = (fx, fy) => p(mid(NW[0], SE[0], fx), mid(NW[1], SE[1], fy));

  const selectedNow = () => evaluate(cdp, session,
    'document.getElementById("delete").disabled === false');
  const clickAt = async (point) => {
    await dragOn(cdp, session, point, point, 1);
    await sleep(60);
  };
  const deselect = async () => {
    await evaluate(cdp, session, 'document.body.click()');
    await sleep(60);
  };
  const pick = async (kind) => {
    await clickButton(cdp, session, '[data-pop="pop-shapes"]');
    await clickButton(cdp, session, `#pop-shapes [data-shape="${kind}"]`);
    await deselect();
  };
  const useSelect = async () => {
    await clickButton(cdp, session, '[data-tool="select"]');
    await deselect();
  };

  // The area is clear. If this fails nothing below it means anything.
  await useSelect();
  await clickAt(at(0.5, 0.5));
  const clear = !(await selectedNow());
  check(clear,
    'the corner this check draws in already had a shape in it, so its results would be meaningless',
    'the test area is empty before the shapes are drawn');
  if (!clear) return;
  await deselect();

  const missed = [];
  for (const kind of SHAPES) {
    const before = await canvasSignature(cdp, session);
    await pick(kind);
    await dragOn(cdp, session, at(0.08, 0.12), at(0.92, 0.88));
    const after = await canvasSignature(cdp, session);
    // Signature rather than a colour count: a highlighter lays down a wash at
    // a third alpha and a loupe magnifies rather than painting, so neither puts
    // down the stroke colour and counting red says they drew nothing.
    if (after === before) missed.push(`${kind} put nothing on the canvas`);

    await useSelect();
    await clickAt(at(0.5, 0.5));
    if (!(await selectedNow())) missed.push(`${kind} not selectable at its centre`);
    await deselect();
    await clickButton(cdp, session, '#undo');
    await sleep(90);
  }
  check(missed.length === 0,
    `shape problems: ${missed.join('; ')}`,
    `all ${SHAPES.length} shapes drew, and every one was selectable by a click in its middle`);

  // The empty corner. A rhombus covers half its bounding box and a triangle
  // half of it too, so the top left of the box is inside the box and outside
  // the shape. A bounding box hit test calls that a hit, and that single case
  // is what the geometry table exists to get right.
  for (const kind of ['rhombus', 'triangle']) {
    await pick(kind);
    await dragOn(cdp, session, at(0.08, 0.12), at(0.92, 0.88));
    await useSelect();

    await clickAt(at(0.11, 0.15));
    const grabbedCorner = await selectedNow();
    await deselect();
    await clickAt(at(0.5, 0.62));
    const grabbedCentre = await selectedNow();
    await deselect();

    check(!grabbedCorner && grabbedCentre,
      `${kind}: empty corner selected=${grabbedCorner} (want false), centre selected=${grabbedCentre} (want true)`,
      `a ${kind} is selectable in its middle and not in the empty corner of its box`);
    await clickButton(cdp, session, '#undo');
    await sleep(90);
  }

  const offered = Number(await evaluate(cdp, session,
    'document.querySelectorAll("#pop-shapes [data-shape]").length'));
  check(offered === SHAPES.length,
    `the shapes popover offered ${offered} shapes, expected ${SHAPES.length}`,
    `the shapes popover offers all ${SHAPES.length} shapes`);

  // Pruning, from the options page's side of the wire. Hiding every shape in a
  // group has to take the group's heading with it, or a label sits above an
  // empty row.
  await evaluate(cdp, session, `chrome.storage.local.set({
    hiddenShapes: ['rhombus', 'hexagon', 'parallelogram', 'triangle', 'cylinder'],
  })`);
  await sleep(260);
  const pruned = JSON.parse(await evaluate(cdp, session, `JSON.stringify({
    visible: [...document.querySelectorAll('#pop-shapes [data-shape]')].filter((b) => !b.hidden).length,
    flowchartShown: !document.querySelector('#pop-shapes .grp-block[data-group="flowchart"]').hidden,
    boxesShown: !document.querySelector('#pop-shapes .grp-block[data-group="boxes"]').hidden,
  })`));
  const kept = SHAPES.length - 5;
  check(pruned.visible === kept && !pruned.flowchartShown && pruned.boxesShown,
    `hiding the flowchart shapes left ${pruned.visible} visible of ${kept}, flowchart heading shown ${pruned.flowchartShown}`,
    'hiding every shape in a group removes the group and its heading, and leaves the others alone');

  await evaluate(cdp, session, 'chrome.storage.local.set({ hiddenShapes: [] })');
  await sleep(260);
  const restored = Number(await evaluate(cdp, session,
    '[...document.querySelectorAll("#pop-shapes [data-shape]")].filter((b) => !b.hidden).length'));
  check(restored === SHAPES.length,
    `turning the shapes back on left ${restored} of ${SHAPES.length} visible`,
    'turning them back on restores every shape');
}

/**
 * The loupe must not un-redact a redaction.
 *
 * The hostile test for the one feature that could have turned the redaction
 * tool into a lie. A loupe magnifies what is under it, so if it sampled the
 * original capture, dragging one over a pixelated region would reproduce the
 * hidden pixels inside the ring, at twice the size, in the exported file.
 *
 * It does not measure "detail", which two earlier versions of this check tried
 * and which does not work: this fixture is a plain page, and pixelating a flat
 * area ADDS block edges rather than removing them, so both a leak and a success
 * can raise the number. It asks the decidable question instead.
 *
 * Three snapshots of the canvas: before the redaction, after it, and after the
 * loupe. The loupe's own circle is found by diffing the last two, so nothing is
 * assumed about where the drag landed. Then, for every point inside the ring,
 * the pixel that is actually there is compared against what a 2x magnification
 * would have produced from each of the two possible sources. Whichever source
 * it matches is the one it read. Correct behaviour matches the redacted
 * snapshot; a leak matches the original.
 */
async function exerciseLoupeRedaction(cdp, session, check, p) {
  // The pointer has to be off the canvas for every snapshot. A drag leaves it
  // resting on the shape it just drew, and `drawHover` puts a hairline
  // rectangle around whatever is under it. That outline is a bigger change to
  // the canvas than the loupe's contents, and an earlier version of this check
  // was measuring it: it passed with the loupe's drawing disabled entirely.
  // Every snapshot has to show the canvas with NOTHING on it but the image and
  // the shapes: no selection outline, no handles, no hover. Finishing a shape
  // leaves it selected, and a drag leaves the pointer resting on it, so both
  // kinds of chrome are present by default. Two earlier versions of this check
  // were fooled by exactly this: the chrome around the redaction spans the
  // whole redaction, so the diff that was supposed to find the loupe found the
  // dashed outline instead, and the check passed against a loupe that leaked.
  const settle = async () => {
    await evaluate(cdp, session,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await moveTo(cdp, session, { x: 6, y: 6 });
    await sleep(140);
  };

  const snap = async (tag) => {
    await settle();
    return evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const g = c.getContext('2d', { willReadFrequently: true });
    window.__loupeProbe = window.__loupeProbe || {};
    window.__loupeProbe['${tag}'] = g.getImageData(0, 0, c.width, Math.min(c.height, 700));
    return 'ok';
  })()`);
  };

  await snap('original');

  await clickButton(cdp, session, '[data-tool="pixelate"]');
  await dragOn(cdp, session, p(0.10, 0.18), p(0.70, 0.72));
  await sleep(150);
  await snap('redacted');

  // WHERE to put the loupe matters, and getting it wrong makes this check
  // vacuous. An earlier version dropped it in the middle of the redaction and
  // passed against a loupe that read the original capture, because the patch it
  // happened to land on was blank page: pixelating white gives white, so the
  // two candidate sources were the same image there and nothing could tell them
  // apart. So the page is asked where the redaction actually changed pixels,
  // and the loupe goes there.
  const spot = JSON.parse(await evaluate(cdp, session, `(() => {
    const P = window.__loupeProbe;
    const a = P.original;
    const b = P.redacted;
    const W = a.width;
    const H = a.height;
    const diff = (x, y) => {
      const i = (y * W + x) * 4;
      return Math.abs(a.data[i] - b.data[i])
        + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2]);
    };
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (diff(x, y) <= 30) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return JSON.stringify({ ok: false });

    // The biggest circle that fits inside the redaction, placed where the
    // redaction changed the most of what the loupe will actually READ.
    //
    // That last part matters and cost two rounds of this check to get right. A
    // loupe magnifies by two, so it reads a disc of half its radius. Scoring the
    // full radius picks a spot whose EDGES have content and whose middle, the
    // part the loupe samples, is blank page that pixelated to itself. The two
    // candidate sources are then the same image and the comparison decides
    // nothing while appearing to pass.
    const radius = Math.max(12, Math.min(70, (x1 - x0) / 4, (y1 - y0) / 4));
    const source = radius / 2;
    let best = -1;
    let bx = (x0 + x1) / 2;
    let by = (y0 + y1) / 2;
    for (let cy = y0 + radius; cy <= y1 - radius; cy += 5) {
      for (let cx = x0 + radius; cx <= x1 - radius; cx += 5) {
        let changed = 0;
        for (let dy = -source; dy <= source; dy += 2) {
          for (let dx = -source; dx <= source; dx += 2) {
            if (dx * dx + dy * dy > source * source) continue;
            if (diff(Math.round(cx + dx), Math.round(cy + dy)) > 30) changed += 1;
          }
        }
        if (changed > best) { best = changed; bx = cx; by = cy; }
      }
    }

    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    const sx = (x) => box.left + (x / c.width) * box.width;
    const sy = (y) => box.top + (y / c.height) * box.height;
    return JSON.stringify({
      ok: true,
      score: best,
      radius: Math.round(radius),
      // Where the loupe will sit, in canvas pixels. The measurement below uses
      // these rather than deriving a radius from a changed-pixel bounding box:
      // that box is much larger than the ring (it includes the loupe's handle),
      // so sampling it put most of the samples OUTSIDE the loupe, where the two
      // candidate sources differ for reasons that have nothing to do with the
      // loupe. That version passed against a loupe that leaked.
      canvas: { cx: Math.round(bx), cy: Math.round(by), r: Math.round(radius) },
      from: { x: Math.round(sx(bx - radius)), y: Math.round(sy(by - radius)) },
      to: { x: Math.round(sx(bx + radius)), y: Math.round(sy(by + radius)) },
    });
  })()`));

  check(spot.ok && spot.score > 20,
    `no spot in the redaction has enough changed pixels under a loupe to tell a leak from a success (best ${spot.score})`,
    `placing the loupe where the redaction changed most (radius ${spot.radius}px, ${spot.score} changed source pixels)`);
  if (!spot.ok) return;

  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '#pop-shapes [data-shape="loupe"]');
  await evaluate(cdp, session, 'document.body.click()');
  await dragOn(cdp, session, spot.from, spot.to);
  await sleep(150);
  await snap('withLoupe');

  const stillSelected = await evaluate(cdp, session,
    'document.getElementById("delete").disabled === false');
  check(!stillSelected,
    'a shape was still selected when the canvas was sampled, so its chrome is in the measurement',
    'nothing was selected when the canvas was sampled, so only the shapes are in it');

  const stats = JSON.parse(await evaluate(cdp, session, `(() => {
    const CX = ${spot.canvas.cx};
    const CY = ${spot.canvas.cy};
    const R = ${spot.canvas.r};
    const P = window.__loupeProbe;
    const before = P.original;
    const redacted = P.redacted;
    const after = P.withLoupe;
    const W = before.width;
    const H = before.height;
    const at = (img, x, y) => {
      const i = (y * W + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    const moved = (a, b, x, y, threshold) => {
      const p1 = at(a, x, y);
      const p2 = at(b, x, y);
      return Math.abs(p1[0] - p2[0]) > threshold
        || Math.abs(p1[1] - p2[1]) > threshold
        || Math.abs(p1[2] - p2[2]) > threshold;
    };

    const bbox = (a, b, threshold) => {
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          if (!moved(a, b, x, y, threshold)) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      return { x0, y0, x1, y1, found: x1 >= 0 };
    };

    const redaction = bbox(before, redacted, 10);
    const ring = bbox(redacted, after, 10);
    if (!redaction.found || !ring.found) {
      return JSON.stringify({ found: false, redaction, ring });
    }

    const cx = CX;
    const cy = CY;
    const r = R;

    // How far the pixels actually drawn sit from each hypothesis, sampled over
    // the inner 70% of the disc so the ring stroke itself is never included.
    let errRedacted = 0;
    let errOriginal = 0;
    let sampled = 0;
    // Strictly inside the ring. Every sample must be a pixel the loupe itself
    // painted, or the comparison is answering a different question.
    const reach = r * 0.75;
    for (let dy = -reach; dy <= reach; dy += 2) {
      for (let dx = -reach; dx <= reach; dx += 2) {
        if (dx * dx + dy * dy > reach * reach) continue;
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue;
        // The loupe magnifies by 2 about its centre, so the pixel shown at
        // (px, py) was read from halfway back towards the centre.
        const sx = Math.round(cx + dx / 2);
        const sy = Math.round(cy + dy / 2);
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const shown = at(after, px, py);
        const fromRedacted = at(redacted, sx, sy);
        const fromOriginal = at(before, sx, sy);
        // Only score where the two candidate sources actually disagree. Most of
        // this capture is blank page, and blank page pixelates to blank page:
        // at those points both hypotheses predict the same colour and scoring
        // them buries the signal under a pile of ties.
        const disagree = Math.abs(fromRedacted[0] - fromOriginal[0])
          + Math.abs(fromRedacted[1] - fromOriginal[1])
          + Math.abs(fromRedacted[2] - fromOriginal[2]);
        if (disagree < 25) continue;
        for (let ch = 0; ch < 3; ch += 1) {
          errRedacted += Math.abs(shown[ch] - fromRedacted[ch]);
          errOriginal += Math.abs(shown[ch] - fromOriginal[ch]);
        }
        sampled += 1;
      }
    }
    // How different the two hypotheses are IN THE AREA THE LOUPE READS. This
    // has to be measured over the source disc, not over the whole redaction: a
    // redaction can change plenty at its edges while the patch under the loupe
    // is blank in both versions, and then matching one of them proves nothing.
    let separation = 0;
    let cells = 0;
    const sourceReach = r / 2;
    for (let dy = -sourceReach; dy <= sourceReach; dy += 1) {
      for (let dx = -sourceReach; dx <= sourceReach; dx += 1) {
        if (dx * dx + dy * dy > sourceReach * sourceReach) continue;
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const a1 = at(before, x, y);
        const b1 = at(redacted, x, y);
        separation += Math.abs(a1[0] - b1[0]) + Math.abs(a1[1] - b1[1]) + Math.abs(a1[2] - b1[2]);
        cells += 1;
      }
    }
    cells = Math.max(1, cells);
    return JSON.stringify({
      found: true,
      radius: Math.round(r),
      askedFor: { cx: CX, cy: CY, r: R },
      ringBox: ring,
      redactionBox: redaction,
      sampled,
      errRedacted: sampled ? Number((errRedacted / sampled).toFixed(2)) : -1,
      errOriginal: sampled ? Number((errOriginal / sampled).toFixed(2)) : -1,
      separation: Number((separation / cells).toFixed(2)),
    });
  })()`));

  check(stats.found && stats.radius > 8,
    `could not locate the redaction and the loupe to compare them (${JSON.stringify(stats)})`,
    `located the loupe, radius ${stats.radius}px, ${stats.sampled} points sampled inside it`);
  if (!stats.found) return;

  // Enough points where the redaction genuinely changed what is underneath. If
  // there are too few, the two hypotheses are the same picture and matching one
  // of them proves nothing, so the check says so instead of passing.
  check(stats.sampled >= 40,
    `only ${stats.sampled} points under the loupe distinguish the redacted capture from the original, which is too few to conclude anything`,
    `${stats.sampled} points under the loupe can tell the two sources apart`);

  check(stats.errRedacted < stats.errOriginal,
    `the loupe matched the ORIGINAL capture better than the redacted one (${stats.errOriginal} vs ${stats.errRedacted}): it is magnifying pixels the redaction was supposed to destroy`,
    `the loupe magnified the redacted base, not the original (error ${stats.errRedacted} against it, ${stats.errOriginal} against the original)`);

  await evaluate(cdp, session, 'delete window.__loupeProbe');
  await clickButton(cdp, session, '#undo');
  await clickButton(cdp, session, '#undo');
  await sleep(150);
}

async function exercisePointerFeedback(cdp, session, check, p) {
  const cursor = () => evaluate(cdp, session, `document.getElementById('canvas').style.cursor`);

  await clickButton(cdp, session, '[data-tool="rect"]');
  const corner = p(0.2, 0.68);
  await dragOn(cdp, session, corner, p(0.5, 0.8));
  await sleep(150);

  // Drawing hands back to the selection tool with the new shape selected, which
  // is the state every one of these questions is asked in.
  await moveTo(cdp, session, p(0.35, 0.74));
  check(await cursor() === 'move',
    `over the middle of a shape the cursor was "${await cursor()}", not move`,
    'over a shape the cursor says it can be picked up and moved');

  await moveTo(cdp, session, corner);
  const onHandle = await cursor();
  check(onHandle === 'nwse-resize',
    `over the north west handle the cursor was "${onHandle}", not nwse-resize`,
    `over a corner handle the cursor points along the axis it travels (${onHandle})`);

  await moveTo(cdp, session, p(0.8, 0.9));
  check(await cursor() === 'default',
    `over empty canvas the cursor was "${await cursor()}", not default`,
    'over empty canvas the cursor claims nothing');

  // The hover outline: a second shape, not selected, has to show it is there.
  await clickButton(cdp, session, '[data-tool="rect"]');
  await dragOn(cdp, session, p(0.6, 0.68), p(0.75, 0.8));
  await sleep(150);
  await moveTo(cdp, session, p(0.8, 0.9));
  const nothingUnder = await canvasSignature(cdp, session);
  await moveTo(cdp, session, p(0.35, 0.74));
  const somethingUnder = await canvasSignature(cdp, session);
  check(somethingUnder !== nothingUnder,
    'hovering an unselected shape drew no outline, so nothing says what a click would pick up',
    'hovering an unselected shape outlines it');

  // Escape abandons a drag rather than leaving it half done.
  //
  // The shape is selected first and the pointer parked away from everything, so
  // the two signatures are taken in the same state: pressing on a shape selects
  // it, and comparing a hovered unselected shape against a selected one would
  // differ because of the chrome rather than because anything moved.
  await clickButton(cdp, session, '[data-tool="select"]');
  await dragOn(cdp, session, p(0.35, 0.74), p(0.35, 0.74), 1);
  await moveTo(cdp, session, p(0.8, 0.9));
  await sleep(120);
  const before = await canvasSignature(cdp, session);
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', ...p(0.35, 0.74), button: 'left', buttons: 1, clickCount: 1 }, session);
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseMoved', ...p(0.4, 0.85), button: 'left', buttons: 1 }, session);
  await sleep(100);
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', ...p(0.4, 0.85), button: 'left', buttons: 0, clickCount: 1 }, session);
  await moveTo(cdp, session, p(0.8, 0.9));
  await sleep(150);
  check(await canvasSignature(cdp, session) === before,
    'Escape during a drag left the shape where the pointer had dragged it',
    'Escape during a drag puts the shape back where it started');

  await clickButton(cdp, session, '#undo');
  await clickButton(cdp, session, '#undo');
  await sleep(120);
}

/**
 * Arrow and line, which are the same shape recorded in two places.
 *
 * The tool says arrow or line, and the stroke style says which ends carry a head.
 * Nothing kept them in step, so this exact sequence drew the wrong thing: draw an
 * arrow, take its head off from the stroke panel, pick Arrow again from the Shapes
 * menu, draw, and get a line. Picking Arrow is the clearest statement the
 * interface offers and it was being ignored.
 *
 * Asserted from both ends: the button state, which is where the disagreement
 * lived, and the pixels, because an arrow has a head and a line does not.
 */
async function exerciseArrowAndLine(cdp, session, check, p) {
  const pressedEnds = () => evaluate(cdp, session, `(() => {
    const on = [...document.querySelectorAll('[data-ends]')]
      .find((b) => b.getAttribute('aria-pressed') === 'true');
    return on ? on.dataset.ends : 'none';
  })()`);
  const toolNow = () => evaluate(cdp, session, `(() => {
    const on = [...document.querySelectorAll('#pop-shapes [data-tool]')]
      .find((b) => b.getAttribute('aria-pressed') === 'true');
    return on ? on.dataset.tool : '';
  })()`);
  const scan = { x: 0, y: 0, w: 900, h: 600 };
  const RED = [239, 68, 68];

  // Take the heads off, from the stroke panel. The tool has to follow.
  await clickButton(cdp, session, '#pop-shapes [data-tool="arrow"]');
  await clickButton(cdp, session, '[data-pop="pop-style"]');
  await clickButton(cdp, session, '[data-ends="none"]');
  await evaluate(cdp, session, `document.body.click()`);
  await sleep(120);
  check(await toolNow() === 'line',
    `taking the arrowheads off left the tool as ${await toolNow()}`,
    'taking the arrowheads off makes the tool Line, so the glyph agrees with it');

  const beforeLine = await countColour(cdp, session, scan, RED);
  await dragOn(cdp, session, p(0.15, 0.62), p(0.55, 0.62));
  const lineInk = (await countColour(cdp, session, scan, RED)) - beforeLine;
  check(lineInk > 50, 'the line drew nothing', `the line drew ${lineInk} pixels`);
  await clickButton(cdp, session, '#undo');
  await sleep(120);

  // Now pick Arrow again, the way the reader would, and it must mean arrow.
  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '#pop-shapes [data-tool="arrow"]');
  await evaluate(cdp, session, `document.body.click()`);
  await sleep(120);
  const ends = await pressedEnds();
  check(ends !== 'none',
    `after choosing Arrow the stroke panel still says "${ends}", so it would draw a line`,
    `choosing Arrow put a head back on (${ends})`);

  const beforeArrow = await countColour(cdp, session, scan, RED);
  await dragOn(cdp, session, p(0.15, 0.62), p(0.55, 0.62));
  const arrowInk = (await countColour(cdp, session, scan, RED)) - beforeArrow;
  check(arrowInk > lineInk,
    `the arrow drew ${arrowInk} pixels and the line drew ${lineInk}, so it has no head`,
    `the arrow drew ${arrowInk - lineInk} pixels more than the line, which is its head`);
  await clickButton(cdp, session, '#undo');
  await sleep(120);
}

/**
 * Every chevron in the toolbar, opened, and the menu it opens hit tested.
 *
 * `hidden` coming off the popover is not enough and never was. The Shapes and
 * Text groups draw their border on the group, and making two square buttons sit
 * inside one rounded border with `overflow: hidden` also clipped the popover
 * those groups contain: laid out at the right size, in the right place, and
 * painted nowhere. Both menus were unreachable and every existing check passed,
 * because the tests that use those menus click into them by id rather than
 * opening them the way a person does.
 *
 * So this asks the page the only question that matters: click the chevron, then
 * ask what is actually painted at the centre of the menu it claims to have
 * opened. If the answer is not the menu, the menu is not there.
 */
async function exerciseChevrons(cdp, session, check) {
  const chevrons = JSON.parse(await evaluate(cdp, session,
    `JSON.stringify([...document.querySelectorAll('#toolbar [data-pop]')].map((b) => b.dataset.pop))`));

  check(chevrons.length > 0, 'no chevrons found in the toolbar',
    `${chevrons.length} chevrons to open`);

  // How many panels actually reached the overview pane. Reported rather than
  // asserted: the number depends on the window and on where the buttons sit, and
  // a layout where nothing overlaps is not a failure. It is here so a run that
  // tested the stacking on nothing at all says so out loud.
  let overlaps = 0;

  for (const popId of chevrons) {
    // A popover can now live inside another one: the text colour palette hangs
    // off a well in the text inspector. Its trigger is unreachable, and its own
    // menu unpainted, until the inspector holding it is open, so every enclosing
    // popover is opened first, outermost in.
    const ancestors = JSON.parse(await evaluate(cdp, session, `(() => {
      const trigger = document.querySelector('[data-pop="${popId}"]');
      const open = [];
      for (let node = trigger.parentElement; node; node = node.parentElement) {
        if (node.classList?.contains('pop')) open.unshift(node.id);
      }
      return JSON.stringify(open);
    })()`));
    for (const outer of ancestors) await clickButton(cdp, session, `[data-pop="${outer}"]`);

    await clickButton(cdp, session, `[data-pop="${popId}"]`);
    await sleep(90);
    const state = JSON.parse(await evaluate(cdp, session, `(() => {
      const pop = document.getElementById(${JSON.stringify(popId)});
      const r = pop.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      // WHAT IS PAINTED OVER WHAT
      //
      // The centre of the panel is not enough. The overview pane is fixed to the
      // top right of the window and the toolbar is a stacking context of its
      // own, so the pane was painting over the corner of any panel that reached
      // it while the middle of that panel stayed perfectly clickable. Hit test
      // where the two actually overlap, and only where they do.
      const pane = document.getElementById('overview');
      const q = pane.hidden ? null : pane.getBoundingClientRect();
      const lap = q && {
        x1: Math.max(r.left, q.left), y1: Math.max(r.top, q.top),
        x2: Math.min(r.right, q.right), y2: Math.min(r.bottom, q.bottom),
      };
      const clash = lap && lap.x2 > lap.x1 + 2 && lap.y2 > lap.y1 + 2
        ? document.elementFromPoint((lap.x1 + lap.x2) / 2, (lap.y1 + lap.y2) / 2)
        : undefined;
      return JSON.stringify({
        open: !pop.hidden,
        painted: getComputedStyle(pop).display !== 'none' && r.width > 0 && r.height > 0,
        reachable: !!(at && (pop === at || pop.contains(at))),
        blockedBy: at ? (at.id || at.className || at.tagName) : null,
        overlapsPane: clash !== undefined,
        abovePane: clash === undefined || !!(clash && (pop === clash || pop.contains(clash))),
        paneBlockedBy: clash ? (clash.id || clash.className || clash.tagName) : null,
        inWindow: r.x >= 0 && r.y >= 0
          && r.right <= document.documentElement.clientWidth
          && r.bottom <= document.documentElement.clientHeight,
      });
    })()`));

    check(state.open && state.painted, `#${popId} did not open`, `#${popId} opens`);
    check(state.reachable,
      `#${popId} opened but nothing of it is painted at its own centre, ${state.blockedBy} is there instead`,
      `#${popId} is clickable where it says it is`);
    if (state.overlapsPane) overlaps += 1;
    check(state.abovePane,
      `#${popId} reaches the overview pane and ${state.paneBlockedBy} is painted over it there`,
      `#${popId} is painted above the overview pane where the two meet`);
    check(state.inWindow, `#${popId} opened partly outside the window`,
      `#${popId} stays inside the window`);

    // TOGGLING ONE PANEL SHUT LEAVES ITS CONTAINER OPEN
    //
    // The three colour wells in the text inspector are popovers inside a
    // popover. Clicking a well a second time is how a reader puts the palette
    // away, and it used to close the inspector holding it as well, so the panel
    // vanished on the ordinary path rather than an unusual one.
    if (ancestors.length > 0) {
      await clickButton(cdp, session, `[data-pop="${popId}"]`);
      await sleep(80);
      const dismissed = JSON.parse(await evaluate(cdp, session, `(() => {
        const shown = (id) => {
          const node = document.getElementById(id);
          return !node.hidden && node.getClientRects().length > 0;
        };
        return JSON.stringify({
          self: shown(${JSON.stringify(popId)}),
          holders: ${JSON.stringify(ancestors)}.filter(shown),
        });
      })()`));
      check(!dismissed.self && dismissed.holders.length === ancestors.length,
        `dismissing #${popId} left it ${dismissed.self ? 'open' : 'closed'} and `
          + `${dismissed.holders.length} of its ${ancestors.length} containers open`,
        `#${popId} can be put away without taking ${ancestors.join(', ')} with it`);
    }
    await evaluate(cdp, session, `document.body.click()`);
    await sleep(60);
    const stillOpen = JSON.parse(await evaluate(cdp, session, `(() => JSON.stringify(
      [...document.querySelectorAll('#toolbar .pop')]
        .filter((p) => getComputedStyle(p).display !== 'none' && p.getClientRects().length > 0)
        .map((p) => p.id)))()`));
    check(stillOpen.length === 0,
      `clicking away left ${stillOpen.join(', ')} open after #${popId}`,
      `clicking away closes #${popId}`);
  }

  console.log(`  (${overlaps} of ${chevrons.length} panels reached the overview pane)`);
}

/**
 * What the crop confirm bar is showing, and whether it is somewhere a person
 * could click it. A bar positioned off screen is the same as no bar.
 */
async function cropBarState(cdp, session) {
  await sleep(120);
  return JSON.parse(await evaluate(cdp, session, `(() => {
    const bar = document.getElementById('crop-bar');
    const box = bar.getBoundingClientRect();
    const style = getComputedStyle(bar);
    const shown = !bar.hidden && style.display !== 'none' && box.width > 0;
    return JSON.stringify({
      shown,
      size: document.getElementById('crop-size').textContent,
      inView: shown
        && box.left >= 0 && box.top >= 0
        && box.right <= document.documentElement.clientWidth
        && box.bottom <= document.documentElement.clientHeight,
    });
  })()`));
}

// DRIVER

async function launchChrome({ profileDir, headless }) {
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Chrome 152 no longer honours --load-extension; the extension is installed
    // over CDP with Extensions.loadUnpacked, which this flag authorises.
    '--enable-unsafe-extension-debugging',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stderr.on('data', (d) => logs.push(String(d)));
  child.stdout.on('data', (d) => logs.push(String(d)));

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

  return { child, version, logs };
}

/**
 * Files Chrome has finished writing. A download in flight is a `.crdownload`
 * temp file, and treating one as finished means reading a truncated PNG.
 */
// Built from the format table rather than typed out. It was `png|jpg|pdf`, and
// the first WebP download landed on disk, was filtered out of this list, and
// reported as a download that never arrived.
const SAVED_FILE = new RegExp(`\\.(${DOWNLOAD_FORMATS.map(extensionOf).join('|')})$`);

function completedDownloads(dir) {
  const names = readdirSync(dir);
  if (names.some((f) => f.endsWith('.crdownload'))) return null;
  return names.filter((f) => SAVED_FILE.test(f));
}

async function findServiceWorker(cdp, extensionId) {
  // Chrome runs component extensions of its own, so match our worker exactly.
  const url = `chrome-extension://${extensionId}/src/background.js`;
  return until('the OpenFullPage service worker', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url === url);
  });
}

// MAIN

async function main() {
  if (!CHROME) throw new Error('no Chrome found, set FPC_CHROME to its path');
  const headless = !process.argv.includes('--headed');
  if (process.argv.includes('--popup') && headless) {
    throw new Error('--popup needs --headed: headless Chrome will not open a toolbar popup');
  }
  const downloadDir = mkdtempSync(join(tmpdir(), 'fpc-downloads-'));
  const server = await serveFixture(PORT);
  const crossOrigin = await serveFixture(CROSS_ORIGIN_PORT, 'cross.html');
  const demo = await serveFixture(DEMO_PORT, 'report.html', join(REPO, 'store', 'demo'));
  const deepFrames = process.argv.includes('--deep');
  const extensionDir = stageExtension(deepFrames);
  const profileDir = stageProfile(downloadDir);

  console.log(`extension: ${extensionDir}${deepFrames ? '  (advanced access granted)' : ''}`);
  console.log(`downloads: ${downloadDir}`);

  const { child, version } = await launchChrome({ profileDir, headless });
  console.log(`chrome:    ${version.Browser} (${headless ? 'headless' : 'headed'})`);

  let cdp;
  const sessionNames = new Map();
  // Every uncaught page exception seen during the run. Not empty means failed.
  const uncaught = [];

  try {
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    // Surface anything the extension throws, instead of waiting for a timeout
    // and guessing. This is the difference between "it hung" and a stack trace.
    //
    // And FAIL on it. This used to print the exception and let the run exit 0,
    // which is how the bug above survived: the suite reported every check
    // passing over thirty three uncaught TypeErrors, run after run. A check
    // that cannot fail is a comment.
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }, frame) => {
      const where = sessionNames.get(frame.sessionId) ?? frame.sessionId?.slice(0, 6) ?? 'browser';
      const detail = exceptionDetails.exception?.description ?? exceptionDetails.text;
      console.log(`  !! uncaught (${where}): ${detail}`);
      uncaught.push(`${where}: ${detail}`);
      process.exitCode = 1;
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type !== 'error' && type !== 'warning') return;
      console.log(`  !! console.${type}: ${args.map((a) => a.description ?? a.value).join(' ')}`);
    });

    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
    const worker = await findServiceWorker(cdp, extensionId);
    const { sessionId: swSession } = await cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    });
    sessionNames.set(swSession, 'service worker');
    await cdp.send('Runtime.enable', {}, swSession);
    console.log(`extension id: ${extensionId}`);

    // Point the harness at a specific page without editing it: the pages worth
    // regression-testing against are long, lazy and newsworthy, which is also to
    // say short-lived, so they do not belong hard-coded in the list below.
    const override = process.env.FPC_URLS;
    const targets = override
      ? override.split(',').map((u) => u.trim()).filter(Boolean)
      // --market photographs the store demo page unless told otherwise, so
      // regenerating the screenshots is one command with no environment to
      // remember. store/LISTING.md quotes that command, and a listing whose
      // own instructions need an undocumented variable drifts immediately.
      : process.argv.includes('--market')
      ? [`http://127.0.0.1:${DEMO_PORT}/`]
      : process.argv.includes('--stop')
      ? [`http://127.0.0.1:${PORT}/tall.html`]
      : process.argv.includes('--iframes')
      ? [`http://127.0.0.1:${PORT}/iframes.html`]
      : process.argv.includes('--sites')
      ? [
          `http://127.0.0.1:${PORT}/`,
          // The sites named in the V1-SPEC §10 step 3 gate: a sticky-header app,
          // a heavy commercial page, and a docs site.
          'https://github.com/mrcoles/full-page-screen-capture-chrome-extension',
          'https://www.amazon.com/',
          'https://developer.mozilla.org/en-US/docs/Web/CSS/position',
        ]
      : [`http://127.0.0.1:${PORT}/`];

    // A driver page in its own window. The service worker cannot import its
    // own module, and nothing outside the extension may message it, so commands
    // are issued from a real extension page. result.html opened with no capture
    // id renders an idle state, which makes it a convenient driver. It must
    // live in a separate window: captureVisibleTab grabs whichever tab is
    // active in the target's window.
    const resultUrl = `chrome-extension://${extensionId}/src/ui/result.html`;
    const { targetId: driverId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    });
    const { sessionId: driver } = await cdp.send('Target.attachToTarget', {
      targetId: driverId,
      flatten: true,
    });
    sessionNames.set(driver, 'driver page');
    await cdp.send('Runtime.enable', {}, driver);
    await cdp.send('Page.enable', {}, driver);
    await cdp.send('Page.navigate', { url: resultUrl }, driver);
    await until(
      'the driver page',
      async () => (await evaluate(cdp, driver, 'typeof chrome?.tabs?.query')) === 'function',
      { timeoutMs: 15000 },
    );

    const results = [];
    let editedSize = null;

    for (const url of targets) {
      const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true });
      await sleep(3000); // let the page load and settle before measuring

      // The extension holds no host permissions, so tab.url is undefined here.
      // The page is instead the active tab of the most recently opened window
      // that is not the driver's own.
      const tabId = await evaluate(
        cdp,
        driver,
        `(async () => {
          const me = await chrome.tabs.getCurrent();
          const tabs = await chrome.tabs.query({ active: true });
          const other = tabs
            .filter(t => t.windowId !== me.windowId)
            .sort((a, b) => b.windowId - a.windowId)[0];
          return other && other.id;
        })()`,
      );
      if (!tabId) throw new Error(`could not find a tab for ${url}`);

      // Straight to a file, no editor. Written to storage rather than clicked in
      // the options page because the switch there exists to ask for the downloads
      // permission, which this harness already grants at install.
      if (process.argv.includes('--direct')) {
        await evaluate(cdp, driver, `chrome.storage.local.set({ directDownload: true })`);
      }

      // F3 asks after the fifth capture, and this harness takes one. Rather than
      // taking five, the count is set to four so that the one about to happen is
      // the fifth: the rule being checked is "the fifth", not "five in a row",
      // and driving five captures would check the loop and not the rule.
      if (process.argv.includes('--nudge')) {
        await evaluate(cdp, driver,
          `chrome.storage.local.set({ captureCount: 4, nudgesShown: 0, nudgeDone: false })`);
      }

      // The fourth mode is gated behind the extra-modes switch, and with it off
      // `start()` quietly captures the whole page instead. A run that forgot
      // this would pass while testing nothing.
      const removing = process.argv.includes('--remove');
      // The picker lives in the captured page, so this mode is the only one
      // that needs to drive that page directly rather than through the driver.
      let pageSession = null;
      if (removing) {
        await evaluate(cdp, driver, `chrome.storage.local.set({ extraModes: true })`);
        ({ sessionId: pageSession } = await cdp.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        }));
        sessionNames.set(pageSession, 'captured page');
        await cdp.send('Runtime.enable', {}, pageSession);
      }

      const started = await evaluate(
        cdp,
        driver,
        `chrome.runtime.sendMessage({ type: 'start', tabId: ${tabId}${removing ? ", mode: 'remove'" : ''} })`,
      );
      if (!started?.started) throw new Error(`capture did not start: ${JSON.stringify(started)}`);

      if (removing) {
        console.log('\n  taking something out of the shot before taking it:');
        const problems = [];
        const check = (ok, bad, good) => (ok ? console.log(`  ok   ${good}`) : problems.push(bad));

        const bar = await until('the removal picker to come up', async () => {
          const text = await evaluate(cdp, pageSession,
            `(() => { const d = [...document.documentElement.children].find((n) => n.textContent && n.textContent.includes('Click to hide')); return d ? d.textContent : ''; })()`);
          return text || null;
        }, { timeoutMs: 15000, everyMs: 200 });
        check(/Nothing hidden yet/.test(bar),
          `the picker came up saying "${bar}" rather than telling the reader what the keys do`,
          'the picker says what each key does, and that nothing is hidden yet');

        const box = await evaluate(cdp, pageSession,
          `(() => { const b = document.getElementById('cookiebar').getBoundingClientRect(); return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`)
          .then(JSON.parse);

        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, pageSession);
        await sleep(200);
        await cdp.send('Input.dispatchMouseEvent',
          { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 }, pageSession);
        await cdp.send('Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 }, pageSession);
        await sleep(300);

        const counted = await evaluate(cdp, pageSession,
          `(() => { const d = [...document.documentElement.children].find((n) => n.textContent && n.textContent.includes('Click to hide')); return d ? d.textContent : ''; })()`);
        check(/1 hidden/.test(counted),
          `after one click the picker said "${counted}", so it is not counting what it hid`,
          'the picker counts what it has hidden, so a silent success is not mistaken for a failure');

        const gone = await evaluate(cdp, pageSession,
          `getComputedStyle(document.getElementById('cookiebar')).display`);
        check(gone === 'none',
          `the hidden element is still displayed as "${gone}", so it will be in the picture`,
          'a hidden element is taken out of the flow, not left as a hole its own size');

        await cdp.send('Input.dispatchKeyEvent',
          { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, pageSession);
        await cdp.send('Input.dispatchKeyEvent',
          { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, pageSession);

        for (const problem of problems) console.log(`  FAIL ${problem}`);
        if (problems.length) process.exitCode = 1;
      }

      // Before anything waits on the capture: the popup opens at the very start
      // and is gone once the result tab takes focus, so there is no later moment
      // to look for it.
      if (process.argv.includes('--popup')) {
        console.log('\n  the toolbar popup:');
        const problems = await watchToolbarPopup(cdp, extensionId, (m) => console.log(`  ok   ${m}`));
        for (const problem of problems) console.log(`  FAIL ${problem}`);
        if (problems.length) process.exitCode = 1;
      }

      // The whole point of this mode is that nothing needs looking at, so there
      // is no result tab to attach to: wait for the file, then prove the tab
      // that wrote it tidied itself away.
      if (process.argv.includes('--direct')) {
        console.log('\n  saving straight to a file:');
        const before = (completedDownloads(downloadDir) ?? []).length;
        const problems = [];

        const landed = await until(
          'the capture to save itself',
          async () => {
            const done = completedDownloads(downloadDir) ?? [];
            return done.length > before ? done : null;
          },
          { timeoutMs: 120000, everyMs: 300 },
        ).catch(() => null);

        if (!landed) problems.push('no file was written without the editor being opened');
        else console.log(`  ok   it wrote ${landed.at(-1)} with no editor and no click`);

        const gone = await until(
          'the result tab to close itself',
          async () => {
            const { targetInfos } = await cdp.send('Target.getTargets');
            return targetInfos.some((t) => t.url.startsWith(`${resultUrl}#`)) ? null : true;
          },
          { timeoutMs: 30000, everyMs: 250 },
        ).catch(() => null);

        if (!gone) problems.push('the result tab stayed open after saving straight to a file');
        else console.log('  ok   the tab it saved from closed itself afterwards');

        for (const problem of problems) console.log(`  FAIL ${problem}`);
        if (problems.length) process.exitCode = 1;
        results.push({ url, state: { ready: problems.length === 0, dimensions: 'saved directly', status: 'saved without the editor' } });

        await evaluate(cdp, driver, `chrome.storage.local.set({ directDownload: false })`);
        await cdp.send('Target.closeTarget', { targetId });
        continue;
      }

      // The progress panel normally lives in the toolbar popup, which headless
      // Chrome will not open. The page and its port are identical either way, so
      // opening it as an ordinary tab tests everything except Chrome's own popup
      // chrome: that it connects mid capture, is told where things stand, counts
      // up, and finishes at Done.
      if (process.argv.includes('--stop')) {
        console.log('\n  finishing a capture early:');
        const problems = await exerciseStopButton(
          cdp,
          driver,
          resultUrl.replace('result.html', 'progress.html'),
          (m) => console.log(`  ok   ${m}`),
        );
        for (const problem of problems) console.log(`  FAIL ${problem}`);
        if (problems.length) process.exitCode = 1;
      }

      if (process.argv.includes('--progress')) {
        const problems = await watchProgress(
          cdp,
          driver,
          resultUrl.replace('result.html', 'progress.html'),
          (m) => console.log(`  ok   ${m}`),
        );
        for (const problem of problems) console.log(`  FAIL ${problem}`);
        if (problems.length) process.exitCode = 1;
      }

      // The capture opens its own result tab, identified by its capture id.
      const resultTarget = await until(`the result tab for ${url}`, async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find((t) => t.type === 'page' && t.url.startsWith(`${resultUrl}#`));
      });
      const { sessionId: result } = await cdp.send('Target.attachToTarget', {
        targetId: resultTarget.targetId,
        flatten: true,
      });
      sessionNames.set(result, 'result tab');
      await cdp.send('Runtime.enable', {}, result);

      const state = await until(
        `capture of ${url}`,
        async () => {
          const s = JSON.parse(
            await evaluate(
              cdp,
              result,
              `JSON.stringify({
                status: document.getElementById('status').textContent,
                failed: document.getElementById('status').classList.contains('error'),
                ready: !document.getElementById('download').disabled,
                dimensions: document.getElementById('dimensions').textContent,
                note: document.getElementById('note').textContent,
              })`,
            ),
          );
          if (s.ready || s.failed) return s;
          process.stdout.write(`\r  ${url}, ${s.status}   `);
          return null;
        },
        { timeoutMs: 240000, everyMs: 400 },
      );
      process.stdout.write('\n');

      // --stale: the worker in this run claims a protocol this tab does not
      // speak, which is what an update landing mid-capture looks like. The tab
      // must say so. Without the check it waits on a progress bar that will
      // never move, and that silence is the whole reason the version exists.
      //
      // Nothing after this point can run, because no capture will ever land.
      if (process.argv.includes('--stale')) {
        if (state.failed && /updated while this capture was running/.test(state.status)) {
          console.log('  ok   a tab left behind by an update says so, rather than waiting for ever');
        } else {
          console.log(`  FAIL a tab talking to a newer worker did not say so: ${state.status}`);
          process.exitCode = 1;
        }
        await cdp.send('Target.closeTarget', { targetId: resultTarget.targetId }).catch(() => {});
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
        return;
      }

      // A capture takes seconds, and anything playing through it is
      // photographed at a different frame in every screenful it spans. The
      // fixture is the only page here with something playing, and it counts
      // what was done to it: checking only that it plays at the end would pass
      // on a build that never paused it.
      if (url.includes(`:${PORT}/`) && !url.includes('iframes') && !url.includes('tall')) {
        const media = JSON.parse(await evaluate(cdp, driver, `(async () => {
          const [r] = await chrome.scripting.executeScript({
            // MAIN, not the isolated world an extension script normally gets:
            // __fpcPauses is a page variable and the two worlds share only the
            // DOM. Reading it from the isolated world reports 0 for ever, which
            // is a check that can never pass rather than one that can never fail.
            target: { tabId: ${tabId} },
            world: 'MAIN',
            func: () => JSON.stringify({
              pauses: window.__fpcPauses ?? 0,
              paused: document.getElementById('clip')?.paused,
              marked: document.querySelectorAll('[data-fpc-playing]').length,
            }),
          });
          return r.result;
        })()`));
        console.log('\n  media on the page:');
        if (media.pauses > 0) {
          console.log(`  ok   the capture paused what was playing (${media.pauses} time)`);
        } else {
          console.log('  FAIL a video was playing through the whole capture and was never paused');
          process.exitCode = 1;
        }
        if (media.paused === false) {
          console.log('  ok   and started it again when the page was handed back');
        } else {
          console.log(`  FAIL the page was handed back with its video still paused (paused=${media.paused})`);
          process.exitCode = 1;
        }
        if (media.marked === 0) {
          console.log('  ok   no capture marks were left on the page');
        } else {
          console.log(`  FAIL ${media.marked} element(s) still carry data-fpc-playing`);
          process.exitCode = 1;
        }
      }

      // --shots <dir> writes screenshots of the real interface. Used to look at
      // the toolbar with human eyes, and to produce the store listing images.
      const shotsArg = process.argv.indexOf('--shots');
      const shotsDir = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

      results.push({ url, state });
      console.log(`  ${state.ready ? 'OK ' : 'ERR'} ${url}, ${state.dimensions}, ${state.status}`);
      if (state.note) console.log(`  note ${state.note}`);

      // A stopped capture has to arrive, and has to admit it is short. Silence
      // here would leave the user with an image that ends mid-page and no idea
      // whether that was the page or the extension.
      if (process.argv.includes('--stop')) {
        if (!state.ready) {
          console.log('  FAIL finishing early produced no usable capture');
          process.exitCode = 1;
        } else if (!/finished this capture early/i.test(state.note ?? '')) {
          console.log(`  FAIL the result tab did not say the capture was cut short: ${state.note}`);
          process.exitCode = 1;
        } else {
          console.log('  ok   the capture arrived and says it ends where you stopped it');
        }
      }

      if (state.ready && shotsDir && process.argv.includes('--market')) {
        console.log('\n  marketing screenshots:');
        await marketingShots(cdp, result, shotsDir);
      }

      if (state.ready && process.argv.includes('--nudge')) {
        await exerciseNudge(cdp, result, (ok, bad, good) => {
          if (ok) console.log(`  ok   ${good}`);
          else { console.log(`  FAIL ${bad}`); process.exitCode = 1; }
        });
      }

      if (state.ready && process.argv.includes('--edit')) {
        console.log('\n  exercising the editor:');
        const { problems, cropped } = await exerciseEditor(cdp, result, (m) =>
          console.log(`  ok   ${m}`),
        );
        for (const problem of problems) console.log(`  FAIL ${problem}`);
        if (problems.length) process.exitCode = 1;
        editedSize = cropped;

        if (shotsDir) {
          console.log('\n  screenshots:');
          await evaluate(cdp, result, 'window.scrollTo(0, 0)');
          await sleep(200);
          await shoot(cdp, result, join(shotsDir, '01-editor.png'));

          for (const [name, trigger] of [
            ['02-shapes', '[data-pop="pop-shapes"]'],
            ['03-stroke-style', '[data-pop="pop-style"]'],
            ['04-border-colour', '[data-pop="pop-border"]'],
            ['05-fill-colour', '[data-pop="pop-fill"]'],
            ['06-text-style', '[data-pop="pop-text"]'],
            ['07-upload', '#upload'],
            ['07b-step-size', '[data-pop="pop-counter"]'],
          ]) {
            await openPopover(cdp, result, trigger);
            await sleep(150);
            await shoot(cdp, result, join(shotsDir, `${name}.png`));
            await openPopover(cdp, result, trigger);
          }
        }

        // The settings gear. Nothing else in the result tab opens another page,
        // so this is the one place a wrong call would go unnoticed.
        const optionsUrl = resultUrl.replace('result.html', 'options.html');
        await evaluate(cdp, result, `document.getElementById('settings').click()`, {
          userGesture: true,
        });
        const opened = await until('the options page', async () => {
          const { targetInfos } = await cdp.send('Target.getTargets');
          return targetInfos.find((t) => t.type === 'page' && t.url.startsWith(optionsUrl));
        }, { timeoutMs: 10000 }).catch(() => null);

        if (!opened) {
          console.log('  FAIL the settings gear did not open the options page');
          process.exitCode = 1;
        } else {
          console.log('  ok   the settings gear opened the options page');

          // The options page carries the toolbar switches, the settings file
          // buttons and the feedback form, none of which the editor tests touch.
          const { sessionId: opts } = await cdp.send('Target.attachToTarget',
            { targetId: opened.targetId, flatten: true });
          sessionNames.set(opts, 'options page');
          await cdp.send('Runtime.enable', {}, opts);
          await sleep(600);

          const optionProblems = [];
          const wired = JSON.parse(await evaluate(cdp, opts, `JSON.stringify({
            toolbarBoxes: document.querySelectorAll('#toolbarButtons input').length,
            allChecked: [...document.querySelectorAll('#toolbarButtons input')].every((b) => b.checked),
            hasExport: !!document.getElementById('exportSettings'),
            hasImport: !!document.getElementById('settingsFile'),
            hasCompose: !!document.getElementById('composeEmail'),
            diagnostics: (document.getElementById('diagnosticsPreview').textContent || '').slice(0, 40),
            indexLinks: document.querySelectorAll('#tocList a').length,
            sections: document.querySelectorAll('main section[id]').length,
            hasTheme: !!document.getElementById('theme'),
            shapeBoxes: document.querySelectorAll('#shapeButtons input').length,
            shapesAllOn: [...document.querySelectorAll('#shapeButtons input')].every((b) => b.checked),
          })`));
          // Derived, never typed. A count written here goes stale the moment a
          // control is added, and it goes stale silently in the direction that
          // matters: the new control is the one with no switch.
          if (wired.toolbarBoxes !== TOOLBAR_BUTTONS.length) {
            optionProblems.push(
              `the toolbar list shows ${wired.toolbarBoxes} controls, expected ${TOOLBAR_BUTTONS.length}`);
          }
          if (!wired.allChecked) optionProblems.push('a toolbar control starts switched off');
          if (!wired.hasExport || !wired.hasImport || !wired.hasCompose) optionProblems.push('a settings or feedback control is missing');
          if (!wired.hasTheme) optionProblems.push('the theme control is missing from the options page');
          // The README promises every control can be switched off individually.
          // At five shapes behind one switch that was close enough to true; at
          // fourteen it would have been false for the densest surface here.
          // Counted against the model, not against a number typed here, because
          // a number typed here is a number that goes stale the next time a
          // shape is added.
          if (wired.shapeBoxes !== SHAPE_TOOLS.length) {
            optionProblems.push(
              `the shapes list shows ${wired.shapeBoxes} switches, expected ${SHAPE_TOOLS.length}`);
          } else if (!wired.shapesAllOn) {
            optionProblems.push('a shape starts switched off, and every one of them ships on');
          } else {
            console.log(`  ok   the options page lists all ${SHAPE_TOOLS.length} shapes, every one switched on`);
          }
          // The index is built from the sections, so a mismatch means a section
          // was added without one, which is the failure the building loop exists
          // to prevent.
          if (wired.indexLinks !== wired.sections) {
            optionProblems.push(`the index lists ${wired.indexLinks} of ${wired.sections} sections`);
          } else {
            console.log(`  ok   the index lists all ${wired.sections} sections`);
          }
          if (!/OpenFullPage \d/.test(wired.diagnostics)) optionProblems.push(`diagnostics did not fill in: ${wired.diagnostics}`);
          if (optionProblems.length === 0) {
            console.log(`  ok   the options page lists ${wired.toolbarBoxes} toolbar controls, all on, with the settings file and feedback controls wired`);
          }

          await auditPage(cdp, opts, 'options page', optionProblems, (m) => console.log(`  ok   ${m}`));
          await setTheme(cdp, opts, 'dark');
          await auditPage(cdp, opts, 'options page, dark theme', optionProblems, (m) => console.log(`  ok   ${m}`));
          if (shotsDir) await shoot(cdp, opts, join(shotsDir, '11-options-dark.png'));
          await setTheme(cdp, opts, 'system');
          for (const problem of optionProblems) console.log(`  FAIL ${problem}`);
          if (optionProblems.length) process.exitCode = 1;

          if (shotsDir) {
            await shoot(cdp, opts, join(shotsDir, '08-options-top.png'));
            await evaluate(cdp, opts, 'document.getElementById("toolbarButtons").scrollIntoView()');
            await sleep(250);
            await shoot(cdp, opts, join(shotsDir, '09-options-toolbar.png'));
            await evaluate(cdp, opts, 'window.scrollTo(0, document.body.scrollHeight)');
            await sleep(250);
            await shoot(cdp, opts, join(shotsDir, '10-options-support.png'));
          }

          await cdp.send('Target.closeTarget', { targetId: opened.targetId }).catch(() => {});
        }
      }

      if (state.ready) {
        const shotDir = process.env.FPC_SHOT_DIR;
        if (shotDir) {
          const { data } = await cdp.send(
            'Page.captureScreenshot',
            { format: 'png', captureBeyondViewport: false },
            result,
          );
          const name = join(shotDir, `result-${results.length}.png`);
          writeFileSync(name, Buffer.from(data, 'base64'));
          console.log(`  shot ${name}`);

          // And once with the download menu open, since that is the part a
          // screenshot of the resting toolbar cannot show.
          await evaluate(cdp, result, `document.getElementById('download').click()`);
          const open = await cdp.send(
            'Page.captureScreenshot',
            { format: 'png', captureBeyondViewport: false },
            result,
          );
          const menuName = join(shotDir, `menu-${results.length}.png`);
          writeFileSync(menuName, Buffer.from(open.data, 'base64'));
          console.log(`  shot ${menuName}`);

          // And shut again. #download is a toggle, so a menu left open here is
          // closed by the block below that means to open it, and every file
          // size check after that would be driving a menu nobody can see.
          await evaluate(cdp, result, `document.getElementById('download').click()`);
        }

        // The filename box is the one place a person can put arbitrary text into
        // a path handed to chrome.downloads, so type something hostile into it
        // and check what actually lands on disk.
        if (process.argv.includes('--edit')) {
          await evaluate(
            cdp,
            result,
            `document.getElementById('filename').value = ${JSON.stringify(TYPED_NAME)}`,
          );
        }

        // What each format would actually cost, and the control that exists to
        // change it. Before the saves, because it puts the quality back to 92
        // and the files written below are checked against real bytes.
        if (process.argv.includes('--edit')) {
          console.log('\n  the download menu:');
          const problems = [];
          const check = (ok, bad, good) => (ok ? console.log(`  ok   ${good}`) : problems.push(bad));
          await exerciseFileSizes(cdp, result, check);
          for (const problem of problems) console.log(`  FAIL ${problem}`);
          if (problems.length) process.exitCode = 1;
        }

        // Both formats, with a real gestured click each time, that is what
        // chrome.permissions.request requires, and asking only at this point is
        // the whole reason the result lives in a tab.
        for (const format of DOWNLOAD_FORMATS) {
          const before = (completedDownloads(downloadDir) ?? []).length;
          // Download is a menu now: open it, then pick the format. The click on
          // the menu item is the gesture chrome.permissions.request needs.
          await evaluate(cdp, result, `document.getElementById('download').click()`);
          await evaluate(
            cdp,
            result,
            `document.querySelector('#formats [data-format="${format}"]').click()`,
            { userGesture: true },
          );
          await until(
            `the ${format} download from ${url}`,
            async () => (completedDownloads(downloadDir) ?? []).length > before,
          );
        }

        if (process.argv.includes('--edit')) {
          console.log('\n  saying so:');
          const problems = [];
          const check = (ok, bad, good) => (ok ? console.log(`  ok   ${good}`) : problems.push(bad));
          await exerciseConfirmation(cdp, result, check);
          for (const problem of problems) console.log(`  FAIL ${problem}`);
          if (problems.length) process.exitCode = 1;
        }

        // Exporting locks the canvas so a multi-page encode cannot photograph a
        // repaint. If the lock is ever left on, every later render silently does
        // nothing, which looks like a frozen editor rather than an error. Undo
        // has to visibly change the canvas.
        if (process.argv.includes('--edit')) {
          const before = await canvasState(cdp, result);
          await evaluate(cdp, result, `document.getElementById('undo').click()`, { userGesture: true });
          await sleep(250);
          const after = await canvasState(cdp, result);
          if (after.width === before.width && after.height === before.height) {
            console.log(`  FAIL the canvas stopped repainting after an export (${after.width}x${after.height})`);
            process.exitCode = 1;
          } else {
            console.log('  ok   the canvas still repaints after an export, so the lock was released');
          }
          await evaluate(cdp, result, `document.getElementById('redo').click()`, { userGesture: true });
          await sleep(250);
        }
      }

      // The half that matters most. A capture that leaves somebody's real page
      // with pieces missing is worse than one that fails: the failure is at
      // least visible. Checked after the capture rather than instead of it,
      // because `restore()` runs from a `finally` and this is the only place
      // that can see whether it did.
      if (process.argv.includes('--remove')) {
        console.log('\n  putting the page back:');
        const left = await evaluate(cdp, pageSession, `JSON.stringify({
          marked: document.querySelectorAll('[data-fpc-hidden]').length,
          display: getComputedStyle(document.getElementById('cookiebar')).display,
          picker: [...document.documentElement.children].filter((n) => n.textContent && n.textContent.includes('Click to hide')).length,
        })`).then(JSON.parse);

        const problems = [];
        const check = (ok, bad, good) => (ok ? console.log(`  ok   ${good}`) : problems.push(bad));
        check(left.marked === 0,
          `${left.marked} elements are still marked hidden, so the page was left with pieces missing`,
          'nothing is left marked hidden once the capture is done');
        check(left.display !== 'none',
          `the element taken out of the shot is still display:${left.display} on the real page`,
          'the element taken out of the shot is back on the page');
        check(left.picker === 0,
          'the picker chrome is still on the page after the capture finished',
          'the picker takes its own chrome away with it');
        for (const problem of problems) console.log(`  FAIL ${problem}`);
        if (problems.length) process.exitCode = 1;
      }

      await cdp.send('Target.closeTarget', { targetId: resultTarget.targetId });
      await cdp.send('Target.closeTarget', { targetId });
    }

    // Opening an image rather than capturing one. Run against the driver page,
    // which is a bare result tab and therefore exactly the state this feature
    // is about, and run last because it leaves a picture in it.
    if (process.argv.includes('--edit')) {
      console.log('\n  opening an image, rather than capturing one:');
      const problems = [];
      const check = (ok, bad, good) => (ok ? console.log(`  ok   ${good}`) : problems.push(bad));
      await exerciseImport(cdp, driver, check);
      // The pen and the eraser, drawn on the image that pass just opened. Its
      // own canvas, deliberately: these draw and erase freely, and the capture's
      // result tab is shared with a dozen checks that compare it against
      // themselves.
      await exerciseFreehand(cdp, driver, check);
      // The export size, on the same opened image: a known 600 by 400 means the
      // arithmetic can be checked rather than merely watched to change.
      await exerciseExportSize(cdp, driver, check);
      // The numbered step's size control, on the same opened image.
      await exerciseCounterSize(cdp, driver, check);
      for (const problem of problems) console.log(`  FAIL ${problem}`);
      if (problems.length) process.exitCode = 1;
    }

    const files = await until('every download to finish', async () => {
      const done = completedDownloads(downloadDir);
      return done && done.length > 0 ? done : null;
    });
    console.log(`\nsaved to ${downloadDir}:`);
    for (const f of files) console.log(`  ${f}`);

    // The fixture is the only page whose exact contents we know, so it is the
    // only one that can be checked pixel by pixel.
    //
    // Downloads are named after the page URL, not its title, so these match on
    // the served path. Both formats are downloaded and the .jpg sorts first, so
    // the .png is asked for explicitly, or the PNG decoder gets handed a JPEG.
    const fixturePng = files.find((f) => f.endsWith(`-${PORT}.png`));
    if (process.argv.includes('--edit')) {
      const png = files.find((f) => f.endsWith('.png'));
      const img = decodePng(readFileSync(join(downloadDir, png)));
      console.log('\nverifying the edited download:');
      if (editedSize && (img.width !== editedSize.width || img.height !== editedSize.height)) {
        console.log(`  FAIL saved ${img.width}x${img.height}, editor showed ${editedSize.width}x${editedSize.height}`);
        process.exitCode = 1;
      } else {
        console.log(`  ok   saved file matches the edited canvas (${img.width}x${img.height})`);
      }

      // One file per format, because the loop above saves every one of them.
      // This was `!== 3` and went red the moment WebP was added, which is the
      // right kind of failure: a number typed here is a number that goes stale.
      const named = files.filter((f) => EXPECTED_NAME.test(f));
      if (named.length !== DOWNLOAD_FORMATS.length) {
        console.log(`  FAIL typed filename did not survive sanitising: got ${files.join(', ')}`);
        process.exitCode = 1;
      } else {
        console.log(`  ok   the typed name was sanitised into ${named.join(' and ')}`);
      }
      const pdfName = files.find((f) => f.endsWith('.pdf'));
      if (!pdfName) {
        console.log('  FAIL no PDF was saved');
        process.exitCode = 1;
      } else {
        const pdf = readFileSync(join(downloadDir, pdfName));
        const body = pdf.toString('latin1');
        const pages = editedSize ? planPdfPages(editedSize.width, editedSize.height).length : 0;
        const declared = Number(body.match(/\/Count (\d+)/)?.[1] ?? 0);
        const images = (body.match(/\/Subtype \/Image/g) ?? []).length;
        if (!body.startsWith('%PDF-') || !body.endsWith('%%EOF\n')) {
          console.log(`  FAIL the PDF is not a PDF: ${body.slice(0, 20)}`);
          process.exitCode = 1;
        } else if (declared !== pages || images !== pages) {
          console.log(`  FAIL the PDF declares ${declared} pages with ${images} images, expected ${pages}`);
          process.exitCode = 1;
        } else {
          console.log(`  ok   ${pdfName} is a real ${pages}-page PDF (${pdf.length} bytes)`);
        }
      }

      for (const f of files) {
        for (const bad of ['/', String.fromCharCode(92), ':', '..']) {
          if (f.includes(bad)) {
            console.log(`  FAIL saved name contains ${bad}: ${f}`);
            process.exitCode = 1;
          }
        }
      }
    } else if (process.argv.includes('--iframes')) {
      const png = files.find((f) => f.endsWith('-iframes-html.png'));
      console.log('\nverifying the iframe capture:');
      const { problems, notes } = verifyIframes(join(downloadDir, png), { deepFrames });
      for (const note of notes) console.log(`  ok   ${note}`);
      for (const problem of problems) console.log(`  FAIL ${problem}`);
      if (problems.length) process.exitCode = 1;
    } else if (process.argv.includes('--direct')) {
      console.log('\nverifying the file it saved on its own:');
      const png = files.find((f) => f.endsWith('.png'));
      const img = png && decodePng(readFileSync(join(downloadDir, png)));
      if (!img || img.height < 100) {
        console.log(`  FAIL saving without the editor produced no usable image: ${png}`);
        process.exitCode = 1;
      } else {
        console.log(`  ok   ${png} is a real ${img.width}x${img.height} capture`);
      }
    } else if (process.argv.includes('--stop')) {
      // Nothing pixel-exact to check: the point of this run is where the walk
      // ended, which the result tab already reported above. What matters here is
      // that a stopped capture still produces a real file.
      console.log('\nverifying the stopped capture:');
      const png = files.find((f) => f.endsWith('.png'));
      const img = png && decodePng(readFileSync(join(downloadDir, png)));
      // tall.html is 15000 pixels. A stopped capture must be a fraction of that:
      // the bug this guards against is handing back a full-height canvas with
      // everything below the stop left blank, which looks like a broken capture.
      if (!img || img.height < 100) {
        console.log(`  FAIL a stopped capture did not save a usable image: ${png}`);
        process.exitCode = 1;
      } else if (img.height > 7000) {
        console.log(`  FAIL the image is ${img.height} tall, so it is padded out to the whole page`);
        process.exitCode = 1;
      } else {
        console.log(`  ok   it saved ${img.width}x${img.height}, trimmed to the part that was reached`);
      }
    } else if (process.argv.includes('--market')) {
      // The demo page, not the fixture, so there are no bands to count. What a
      // screenshot run needs is a real capture of the whole report behind the
      // photographs: without this branch it fell through to the fixture check
      // and exited 1 on every successful run.
      console.log('\nverifying the demo capture:');
      const png = files.find((f) => f.endsWith(`-${DEMO_PORT}.png`));
      const img = png && decodePng(readFileSync(join(downloadDir, png)));
      if (!img || img.height < 4000) {
        console.log(`  FAIL the demo capture is missing or short: ${png} ${img ? img.height : ''}`);
        process.exitCode = 1;
      } else {
        console.log(`  ok   ${png} is the whole report, ${img.width}x${img.height}`);
      }
    } else if (!fixturePng) {
      console.log('\nno fixture capture to verify');
      process.exitCode = 1;
    } else {
      const path = join(downloadDir, fixturePng);

      // --frozen only proves anything if Chrome was actually made to repeat a
      // frame. Without this the flag could stop working and the run would go on
      // reporting every band present, which is the shape of a check that has
      // quietly stopped checking.
      if (process.argv.includes('--frozen')) {
        console.log('\na screenful Chrome had already handed over:');
        const frozen = await evaluate(cdp, swSession, 'globalThis.__fpcFrozen');
        if (frozen?.served === 1) {
          console.log(`  ok   the capture step served the previous frame once (${frozen.calls} photographs taken)`);
        } else {
          console.log(`  FAIL nothing was frozen, so the run proves nothing: ${JSON.stringify(frozen)}`);
          process.exitCode = 1;
        }
      }

      console.log('\nverifying the fixture capture:');
      const { problems, notes } = verifyFixture(path, { removed: process.argv.includes('--remove') });
      for (const note of notes) console.log(`  ok   ${note}`);
      for (const problem of problems) console.log(`  FAIL ${problem}`);
      if (problems.length) process.exitCode = 1;

      const thumbDir = process.env.FPC_THUMB_DIR;
      if (thumbDir) {
        for (const f of files.filter((n) => n.endsWith('.png'))) {
          console.log('  thumb', thumbnail(join(downloadDir, f), join(thumbDir, `thumb-${f}`)).out);
        }
      }
    }

    const failed = results.filter((r) => !r.state.ready);
    if (failed.length) process.exitCode = 1;
  } finally {
    cdp?.close();
    child.kill('SIGKILL');
    server.close();
    crossOrigin.close();
    demo.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
