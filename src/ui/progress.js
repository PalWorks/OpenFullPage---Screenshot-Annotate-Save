// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The capture progress popup.
//
// This lives in the toolbar popup rather than as an overlay drawn into the page,
// and that is the whole point. Anything injected into the page is inside the
// screenshot, so an in-page indicator would have to be hidden for every single
// screenful and would strobe. The popup is browser chrome, so it can animate
// steadily for the entire capture and never appear in the result.

import { PROTOCOL_MISMATCH, sealed, speaksOurProtocol } from '../lib/protocol.js';

const el = (id) => document.getElementById(id);
const ui = {
  percent: el('percent'),
  what: el('what'),
  page: el('page'),
  bar: el('bar'),
  filled: el('filled'),
  hint: el('hint'),
  stop: el('stop'),
};

// Replaces the resting hint in progress.html once finishing early is possible.
const STOPPABLE_HINT = 'Leave the page alone, or finish now with the part already captured.';

// Closing the moment the capture ends would make the finish invisible on a short
// page. This is long enough to read "Done" and short enough not to be in the way.
const CLOSE_DELAY_MS = 550;

const port = chrome.runtime.connect({ name: 'progress' });

/*
 * FINISH NOW
 *
 * Some pages never stop growing. A feed appends as fast as it is photographed, an
 * advertising frame keeps the page busy long after the reader has everything they
 * wanted, and the walk has no way to tell "still loading" from "will never
 * finish". This is the reader's answer: stop where you are and give me what you
 * have.
 *
 * It asks rather than acts. The worker checks between screenfuls, so the image
 * always ends on a whole one, and the panel says what it asked for rather than
 * claiming it has already happened.
 */
let stopping = false;

ui.stop.addEventListener('click', () => {
  if (stopping) return;
  stopping = true;
  ui.stop.disabled = true;
  ui.stop.textContent = 'Finishing';
  ui.hint.textContent = 'Finishing after this screen.';
  try {
    port.postMessage(sealed({ type: 'stop' }));
  } catch {
    ui.hint.textContent = 'The capture had already stopped.';
  }
});

// Also the signal the end to end harness reads: it distinguishes a panel that is
// live from one that is merely showing its initial markup.
const setState = (state) => {
  document.body.dataset.state = state;
};

setState('waiting');

port.onMessage.addListener((message) => {
  // An update can replace the worker while this panel stays open. Reading a
  // message shaped for a build we are not is how a panel ends up animating at a
  // percentage that means nothing, so it says so instead.
  if (!speaksOurProtocol(message)) {
    setState('stopped');
    ui.stop.hidden = true;
    ui.what.textContent = 'Capture interrupted';
    ui.hint.textContent = PROTOCOL_MISMATCH;
    return;
  }

  setState(message.type);

  if (message.type === 'progress') {
    const percent = Math.round(message.fraction * 100);
    ui.percent.textContent = `${percent}%`;
    ui.bar.style.width = `${percent}%`;
    ui.filled.style.height = `${percent}%`;
    ui.what.textContent = message.what ?? 'Capturing';
    if (message.title) ui.page.textContent = message.title;
    // Only once a screenful is in hand, and never again after it is pressed.
    if (message.canStop && !stopping) {
      ui.stop.hidden = false;
      ui.hint.textContent = STOPPABLE_HINT;
    }
    return;
  }

  if (message.type === 'done') {
    ui.stop.hidden = true;
    ui.percent.textContent = '100%';
    ui.bar.style.width = '100%';
    ui.filled.style.height = '100%';
    ui.what.textContent = 'Done';
    ui.hint.textContent = 'Opening your capture.';
    setTimeout(() => window.close(), CLOSE_DELAY_MS);
    return;
  }

  if (message.type === 'failed') {
    ui.stop.hidden = true;
    document.body.classList.add('failed');
    ui.what.textContent = 'Capture failed';
    ui.hint.textContent = message.reason ?? 'Try again on an ordinary http(s) page.';
  }
});

// The worker went away without saying why. Say so rather than animating forever.
port.onDisconnect.addListener(() => {
  if (document.body.dataset.state === 'done') return;
  setState('stopped');
  ui.stop.hidden = true;
  if (document.body.classList.contains('failed')) return;
  ui.what.textContent = 'The capture stopped.';
  ui.hint.textContent = 'You can close this and try again.';
});
