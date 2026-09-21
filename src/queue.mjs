import { config } from './config.mjs';

export class BusyError extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
    this.retryAfter = 10;
  }
}

// A gate in front of the Claude Code processes. Each run holds a slot, the
// rest wait. Waiting forever is worse than a clear 503.
export class Gate {
  constructor({ limit = config.maxConcurrent, timeoutMs = config.queueTimeoutMs } = {}) {
    this.limit = limit;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.waiting = [];
  }

  get queued() {
    return this.waiting.length;
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      entry.timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(new BusyError(`the bridge is busy, ${this.limit} requests are already running`));
      }, this.timeoutMs);
      this.waiting.push(entry);
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
