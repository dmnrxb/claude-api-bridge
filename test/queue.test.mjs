import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BusyError, Gate } from '../src/queue.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Gate', () => {
  it('runs up to the limit at once and queues the rest', async () => {
    const gate = new Gate({ limit: 2, timeoutMs: 1000 });
    let running = 0;
    let peak = 0;

    const job = async () => gate.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await wait(20);
      running -= 1;
    });

    await Promise.all([job(), job(), job(), job()]);
    assert.equal(peak, 2);
    assert.equal(gate.active, 0);
    assert.equal(gate.queued, 0);
  });

  it('gives up rather than let a caller wait forever', async () => {
    const gate = new Gate({ limit: 1, timeoutMs: 30 });
    const held = gate.run(() => wait(200));
    await assert.rejects(gate.run(async () => 'never'), BusyError);
    await held;
  });

  it('frees the slot even when the job throws', async () => {
    const gate = new Gate({ limit: 1, timeoutMs: 100 });
    await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(gate.active, 0);
    assert.equal(await gate.run(async () => 'fine'), 'fine');
  });
});
