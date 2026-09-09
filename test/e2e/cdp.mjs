// Minimal Chrome DevTools Protocol client, enough to launch Chrome with the
// extension loaded and drive a real capture. Test tooling only; never shipped.

const OPEN = 1;

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      if (frame.method) {
        for (const handler of this.listeners.get(frame.method) ?? []) handler(frame.params, frame);
        return;
      }
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(`${frame.error.message} (${frame.error.code})`));
      else waiter.resolve(frame.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Subscribe to a CDP event, e.g. Runtime.exceptionThrown. */
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  close() {
    if (this.ws.readyState === OPEN) this.ws.close();
  }
}

/**
 * Evaluate an expression in a target, unwrapping promises and throwing on page
 * errors. `userGesture` makes Chrome treat the call as a real click, which is
 * what chrome.permissions.request needs.
 */
export async function evaluate(cdp, sessionId, expression, { userGesture = false } = {}) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(label, predicate, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}
