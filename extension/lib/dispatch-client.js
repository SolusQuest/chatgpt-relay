// One notification request per browser/backend. SQLite owns the work; cursors
// are disposable hints and are always reset when membership or the worker changes.
export class DispatchClient {
  constructor({ watch, membership, onSnapshot, onState, sleep }) {
    Object.assign(this, { watch, membership, onSnapshot, onState });
    this.sleep = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.stopped = true;
    this.cursor = null;
    this.revision = 0;
  }
  start() {
    if (this.running) return this.running;
    this.stopped = false;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  wake() {
    this.cursor = null;
    this.revision++;
    this.controller?.abort();
  }
  stop() { this.stopped = true; this.wake(); }
  async run() {
    let failures = 0;
    while (!this.stopped) {
      const revision = this.revision;
      const controller = new AbortController();
      this.controller = controller;
      try {
        const sessions = await this.membership();
        if (controller.signal.aborted) continue;
        const snapshot = await this.watch({ sessions, cursor: this.cursor, waitMs: 20000 }, controller.signal);
        if (controller.signal.aborted || this.stopped) continue;
        // Apply the full snapshot before advancing its cursor. On worker restart
        // start with null and re-read every pending/active task from the server.
        await this.onSnapshot(snapshot);
        if (revision === this.revision) this.cursor = snapshot.cursor;
        failures = 0;
        this.onState?.({ state: "connected", lastConnectedAt: Date.now(), lastError: null });
      } catch (error) {
        if (controller.signal.aborted || this.stopped) continue;
        this.cursor = null;
        this.onState?.({ state: "disconnected", lastError: String(error.message ?? error) });
        await this.sleep(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) + Math.floor(Math.random() * 250));
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    }
  }
}

// Short HTTP work has its own bounded lane. Background snapshots can use at
// most two permits, leaving capacity for Send fences, Stop, capture and heartbeats.
export class RequestPool {
  constructor(limit = 4, backgroundLimit = 2) {
    this.limit = limit; this.backgroundLimit = backgroundLimit;
    this.active = 0; this.backgroundActive = 0; this.queue = [];
  }
  run(operation, { background = false, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("request_aborted"));
    return new Promise((resolve, reject) => {
      const item = { operation, background, signal, resolve, reject };
      item.abort = () => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal?.removeEventListener("abort", item.abort);
        reject(new Error("request_aborted"));
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit) {
      let index = this.queue.findIndex(item => !item.background);
      if (index < 0 && this.backgroundActive < this.backgroundLimit) index = this.queue.findIndex(item => item.background);
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0];
      item.signal?.removeEventListener("abort", item.abort);
      this.active++; if (item.background) this.backgroundActive++;
      Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
        this.active--; if (item.background) this.backgroundActive--; this.drain();
      });
    }
  }
}
