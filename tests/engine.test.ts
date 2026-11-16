// End-to-end paper engine against the deterministic replay market.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'gb-'));
process.env.DATA_DIR = dir;
const { DEFAULTS } = await import('../server/config.ts');
const { ReplayMarket } = await import('../server/replay.ts');
const { Store } = await import('../server/store.ts');
const { Engine } = await import('../server/engine.ts');
const { buildLiveSwapTx } = await import('../server/executor.ts');

test('paper engine trades a $10 wallet and keeps accounting consistent', async () => {
  const cfg = { ...DEFAULTS, startUsd: 10, minScore: 40, minHolders: 100, minAgeMin: 1, minMcapUsd: 1000, cooldownMin: 1, scanIntervalSec: 9999, monitorIntervalSec: 9999 };
  const m = new ReplayMarket(600); // 10 sim-minutes per second
  const e = new Engine(cfg, m, new Store(join(dir, 't.db')));
  await e.connect({ type: 'paper', startUsd: 10 });
  assert.ok(Math.abs(e.equity() - 10) < 0.01);
  for (let i = 0; i < 40; i++) {
    await e.scan();
    await new Promise((r) => setTimeout(r, 120));
    await e.monitor();
    assert.ok(e.wallet.solBalance >= 0, 'cash never negative');
    assert.ok(e.positions.length <= cfg.maxPositions);
  }
  const s = e.stats();
  assert.ok(s.trades > 0, 'made some trades');
  for (const p of e.positions) assert.ok(p.costUsd <= 10 * 0.08 * 1.6 + 0.01, 'size ~8% of portfolio');
  // accounting: equity == cash + positions + locked rent
  const manual = e.wallet.solBalance * e.solPrice + e.positions.reduce((a, p) => a + p.qty * p.lastPrice + p.rentSol * e.solPrice, 0);
  assert.ok(Math.abs(manual - e.equity()) < 1e-9);
  for (const t of e.store.trades()) assert.ok(Math.abs(t.pnlUsd - (t.proceedsUsd - t.costUsd)) < 1e-9);
  e.stop();
});

test('live swap builder refuses in paper mode', async () => {
  await assert.rejects(() => buildLiveSwapTx(DEFAULTS, new ReplayMarket(), { inputMint: 'a', outputMint: 'b', amountRaw: 1n, userPublicKey: 'x' }), /disabled/);
});
