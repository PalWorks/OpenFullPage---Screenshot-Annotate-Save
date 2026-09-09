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
const DEBUG_PORT = 9333;
const VIEWPORT = { width: 1280, height: 800 };

// Typed into the filename box by --edit. Every path separator, the traversal, and
// the reserved colon must be gone by the time it reaches disk.
const TYPED_NAME = '../../My Report: v2';
const EXPECTED_NAME = /^My Report- v2\.(png|jpg|pdf)$/;

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

function serveFixture(port, indexName = 'index.html') {
  const server = createServer((req, res) => {
    const name = req.url === '/' ? `/${indexName}` : req.url.split('?')[0];
    try {
      const body = readFileSync(join(HERE, 'fixture', name.replace(/\.\./g, '')));
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
 * Purpose made screenshots of the real product, for the site and the store.
 *
 * Deliberately not the same pass as exerciseEditor: that one ends cropped and
 * covered in test marks. These are what a person would actually see, drawn on
 * purpose, at the 1280x800 the Chrome Web Store asks for.
 */
async function marketingShots(cdp, session, dir, p) {
  // The Chrome Web Store takes 1280x800 or 640x400 and nothing else. The window
  // is 1280x800 but browser chrome eats 87 of those pixels, so the page viewport
  // is overridden to the exact size the store wants.
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, session);
  await sleep(300);
  await evaluate(cdp, session, 'window.scrollTo(0, 0)');
  await sleep(250);
  await shoot(cdp, session, join(dir, 'shot-capture.png'));

  // An arrow, a filled box and a numbered step, placed rather than dragged at random.
  await clickButton(cdp, session, '[data-pop="pop-border"]');
  await clickButton(cdp, session, '[data-paint="border"][data-colour="#ef4444"]');
  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '#pop-shapes [data-tool="rect"]');
  await clickButton(cdp, session, '[data-pop="pop-fill"]');
  await clickButton(cdp, session, '[data-paint="fill"][data-colour="#eab308"]');
  // Around the headline rather than across it.
  await dragOn(cdp, session, p(0.055, 0.27), p(0.53, 0.58));

  await clickButton(cdp, session, '[data-pop="pop-shapes"]');
  await clickButton(cdp, session, '#pop-shapes [data-tool="arrow"]');
  await dragOn(cdp, session, p(0.82, 0.72), p(0.57, 0.50));

  await clickButton(cdp, session, '[data-tool="counter"]');
  await dragOn(cdp, session, p(0.86, 0.76), p(0.86, 0.76), 1);

  await clickButton(cdp, session, '[data-tool="select"]');
  // Nothing selected, so the marching ants and handles are not in the picture.
  await evaluate(cdp, session,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await evaluate(cdp, session, 'window.scrollTo(0, 0)');
  await sleep(250);
  await shoot(cdp, session, join(dir, 'shot-annotate.png'));

  // The redaction tool, which is the one nobody expects to be destructive.
  await clickButton(cdp, session, '[data-tool="pixelate"]');
  await dragOn(cdp, session, p(0.10, 0.42), p(0.46, 0.52));
  await clickButton(cdp, session, '[data-tool="select"]');
  await sleep(200);
  await shoot(cdp, session, join(dir, 'shot-redact.png'));

  // Saving: the filename box and the format menu, both open.
  await evaluate(cdp, session, `document.getElementById('download').click()`);
  await sleep(200);
  await shoot(cdp, session, join(dir, 'shot-save.png'));
  await evaluate(cdp, session, `document.getElementById('download').click()`);

  // The upload hand-off, which is the claim made visible.
  await clickButton(cdp, session, '#upload');
  await sleep(200);
  await shoot(cdp, session, join(dir, 'shot-upload.png'));
  await clickButton(cdp, session, '#upload');

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
 * the glyph, because the whole point of the Preview pattern is that the button
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
  const swatches = await evaluate(cdp, session,
    `document.querySelectorAll('[data-paint="border"]').length`);
  check(swatches === 70,
    `the border palette built ${swatches} swatches, expected 70`,
    `the border palette built all ${swatches} swatches`);

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

  // Fill. A box with no fill leaves its middle alone; a box with one does not.
  await clickButton(cdp, session, '[data-tool="rect"]');
  const middle = p(0.55, 0.55);
  await dragOn(cdp, session, p(0.4, 0.4), p(0.7, 0.7));
  const unfilled = await evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    const s = c.width / box.width;
    const d = c.getContext('2d').getImageData(
      Math.round((${middle.x} - box.x) * s), Math.round((${middle.y} - box.y) * s), 1, 1).data;
    return JSON.stringify([d[0], d[1], d[2]]);
  })()`).then(JSON.parse);
  await clickButton(cdp, session, '#undo');

  await clickButton(cdp, session, '#fill-combo');
  await clickButton(cdp, session, '[data-paint="fill"][data-colour="#3b82f6"]');
  const fillGlyph = await evaluate(cdp, session,
    `document.getElementById('fill-glyph').getAttribute('fill')`);
  check(fillGlyph === '#3b82f6', `the fill glyph shows ${fillGlyph}`,
    'the fill glyph took the colour that was picked');

  await clickButton(cdp, session, '[data-tool="rect"]');
  await dragOn(cdp, session, p(0.4, 0.4), p(0.7, 0.7));
  const filled = await evaluate(cdp, session, `(() => {
    const c = document.getElementById('canvas');
    const box = c.getBoundingClientRect();
    const s = c.width / box.width;
    const d = c.getContext('2d').getImageData(
      Math.round((${middle.x} - box.x) * s), Math.round((${middle.y} - box.y) * s), 1, 1).data;
    return JSON.stringify([d[0], d[1], d[2]]);
  })()`).then(JSON.parse);

  // A blue wash over a near-white page cannot raise the blue channel, which is
  // already at the ceiling. What it does is pull red and green down, so the
  // measurement that means "bluer" is the gap between the channels, not blue.
  const blueness = (rgb) => rgb[2] - (rgb[0] + rgb[1]) / 2;
  check(blueness(filled) > blueness(unfilled) + 20,
    `the fill did not tint the inside of the box (empty ${unfilled}, filled ${filled})`,
    `the fill tinted the inside of the box (${unfilled} became ${filled})`);
  await clickButton(cdp, session, '#undo');

  // Put the defaults back so the steps after this one see what they expect.
  await evaluate(cdp, session, `document.querySelector('[data-fill="none"]').click()`);
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

  // 7. Inline text entry.
  await exerciseTextEntry(cdp, session, check, p, problems);

  // 8. The grouped style controls.
  await exerciseStyleToolbar(cdp, session, check, p);

  // 8b. The theme button, round robin through three states.
  await exerciseTheme(cdp, session, check);

  // 8c. Every chevron opens a menu that can actually be reached.
  await exerciseChevrons(cdp, session, check);

  // 8d. Arrow and line are one shape stored twice. They must not drift apart.
  await exerciseArrowAndLine(cdp, session, check, p);

  // 8e. What the pointer says before the click.
  await exerciseTextFrame(cdp, session, check, p);

  await exerciseShapes(cdp, session, check, p);

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

  await clickButton(cdp, session, '#undo');
  await clickButton(cdp, session, '#undo');
  await settle();
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
async function exerciseShapes(cdp, session, check, p) {
  const SHAPES = [
    'arrow', 'line', 'rect', 'ellipse', 'callout', 'loupe', 'highlight',
    'rhombus', 'hexagon', 'parallelogram', 'triangle', 'cylinder',
  ];

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
  check(offered === 12,
    `the shapes popover offered ${offered} shapes, expected 12`,
    'the shapes popover offers all twelve shapes');
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
      return JSON.stringify({
        open: !pop.hidden,
        painted: getComputedStyle(pop).display !== 'none' && r.width > 0 && r.height > 0,
        reachable: !!(at && (pop === at || pop.contains(at))),
        blockedBy: at ? (at.id || at.className || at.tagName) : null,
        inWindow: r.x >= 0 && r.y >= 0
          && r.right <= document.documentElement.clientWidth
          && r.bottom <= document.documentElement.clientHeight,
      });
    })()`));

    check(state.open && state.painted, `#${popId} did not open`, `#${popId} opens`);
    check(state.reachable,
      `#${popId} opened but nothing of it is painted at its own centre, ${state.blockedBy} is there instead`,
      `#${popId} is clickable where it says it is`);
    check(state.inWindow, `#${popId} opened partly outside the window`,
      `#${popId} stays inside the window`);
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
function completedDownloads(dir) {
  const names = readdirSync(dir);
  if (names.some((f) => f.endsWith('.crdownload'))) return null;
  return names.filter((f) => /\.(png|jpg|pdf)$/.test(f));
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
  const downloadDir = mkdtempSync(join(tmpdir(), 'fpc-downloads-'));
  const server = await serveFixture(PORT);
  const crossOrigin = await serveFixture(CROSS_ORIGIN_PORT, 'cross.html');
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

      const started = await evaluate(
        cdp,
        driver,
        `chrome.runtime.sendMessage({ type: 'start', tabId: ${tabId} })`,
      );
      if (!started?.started) throw new Error(`capture did not start: ${JSON.stringify(started)}`);

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
        const box = await canvasState(cdp, result);
        const at = (fx, fy) => ({
          x: Math.round(box.box.x + box.box.width * fx),
          y: Math.round(box.box.y + Math.min(box.box.height, 620) * fy),
        });
        await marketingShots(cdp, result, shotsDir, at);
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
          })`));
          if (wired.toolbarBoxes !== 17) optionProblems.push(`the toolbar list shows ${wired.toolbarBoxes} controls, expected 17`);
          if (!wired.allChecked) optionProblems.push('a toolbar control starts switched off');
          if (!wired.hasExport || !wired.hasImport || !wired.hasCompose) optionProblems.push('a settings or feedback control is missing');
          if (!wired.hasTheme) optionProblems.push('the theme control is missing from the options page');
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

        // Both formats, with a real gestured click each time, that is what
        // chrome.permissions.request requires, and asking only at this point is
        // the whole reason the result lives in a tab.
        for (const format of ['png', 'jpeg', 'pdf']) {
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

      await cdp.send('Target.closeTarget', { targetId: resultTarget.targetId });
      await cdp.send('Target.closeTarget', { targetId });
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

      const named = files.filter((f) => EXPECTED_NAME.test(f));
      if (named.length !== 3) {
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
    } else if (!fixturePng) {
      console.log('\nno fixture capture to verify');
      process.exitCode = 1;
    } else {
      const path = join(downloadDir, fixturePng);
      console.log('\nverifying the fixture capture:');
      const { problems, notes } = verifyFixture(path);
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
