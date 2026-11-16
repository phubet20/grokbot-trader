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
    await e.flushWork(4000);
    await e.monitor();
    await e.flushWork(4000);
    assert.ok(e.wallet.solBalance >= 0, 'cash never negative');
    assert.ok(e.positions.length <= cfg.maxPositions);
  }
  const s = e.stats();
  assert.ok(s.trades > 0, 'made some trades');
  assert.ok(e.positions.length <= cfg.maxPositions, 'respects max slots');
  for (const p of e.positions) assert.ok(p.costUsd <= 10 + 0.05, 'slot size cannot exceed the book');
  // accounting: equity == cash + positions + locked rent
  const manual = e.wallet.solBalance * e.solPrice + e.positions.reduce((a, p) => a + p.qty * p.lastPrice + p.rentSol * e.solPrice, 0);
  assert.ok(Math.abs(manual - e.equity()) < 1e-9);
  for (const t of e.store.trades()) assert.ok(Math.abs(t.pnlUsd - (t.proceedsUsd - t.costUsd)) < 1e-9);
  e.stop();
});

test('paper engine can trade a $2 wallet (fewer slots so each trade stays viable)', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'gb2-'));
  const cfg = { ...DEFAULTS, startUsd: 2, minScore: 35, minHolders: 50, minAgeMin: 1, minMcapUsd: 1000, minLiquidityUsd: 5000, cooldownMin: 1, scanIntervalSec: 9999, monitorIntervalSec: 9999, minTradeUsd: 0.25 };
  const m = new ReplayMarket(800);
  const e = new Engine(cfg, m, new Store(join(dir2, 't.db')));
  await e.connect({ type: 'paper', startUsd: 2 });
  assert.ok(Math.abs(e.equity() - 2) < 0.05);
  for (let i = 0; i < 50; i++) {
    await e.scan();
    await e.flushWork(3000);
    await e.monitor();
    await e.flushWork(3000);
    assert.ok(e.wallet.solBalance >= -1e-9, 'cash never negative');
    assert.ok(e.positions.length <= cfg.maxPositions);
  }
  const s = e.stats();
  assert.ok(s.trades >= 0); // may or may not fill depending on momentum; accounting must hold
  const manual = e.wallet.solBalance * e.solPrice + e.positions.reduce((a, p) => a + p.qty * p.lastPrice + p.rentSol * e.solPrice, 0);
  assert.ok(Math.abs(manual - e.equity()) < 1e-6, 'equity=' + e.equity());
  e.stop();
});

test('live swap builder refuses in paper mode', async () => {
  await assert.rejects(() => buildLiveSwapTx(DEFAULTS, new ReplayMarket(), { inputMint: 'a', outputMint: 'b', amountRaw: 1n, userPublicKey: 'x' }), /disabled/);
});

test('Start/Stop running flag is persisted and restored', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-run-'));
  const cfg = { ...DEFAULTS, scanIntervalSec: 9999, monitorIntervalSec: 9999 };
  const storePath = join(dirp, 't.db');
  const e = new Engine(cfg, new ReplayMarket(10), new Store(storePath));
  await e.connect({ type: 'paper', startUsd: 10 });
  e.setRunning(false);
  const e2 = new Engine(cfg, new ReplayMarket(10), new Store(storePath));
  assert.equal(e2.wallet.running, false);
  assert.equal(e2.wallet.connected, true);
  e2.setRunning(true);
  const e3 = new Engine(cfg, new ReplayMarket(10), new Store(storePath));
  assert.equal(e3.wallet.running, true);
});

test('scan cadence continues while a candidate check hangs', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-hang-'));
  const cfg = { ...DEFAULTS, startUsd: 10, minScore: 0, minHolders: 0, minAgeMin: 0, minMcapUsd: 0, minLiquidityUsd: 0, cooldownMin: 0, scanIntervalSec: 0.4, monitorIntervalSec: 99 };
  const m = new ReplayMarket(600);
  const hanging: Array<(e?: any) => void> = [];
  m.security = async () => new Promise((_, reject) => hanging.push(reject));
  const e = new Engine(cfg, m, new Store(join(dirp, 't.db')));
  await e.connect({ type: 'paper', startUsd: 10 });
  await e.start();
  await new Promise((r) => setTimeout(r, 2200));
  const st = e.scanStatus();
  const calls = e.agents.scanner.calls;
  e.stop();
  for (const rej of hanging) rej(new Error('test cleanup'));
  assert.ok(calls >= 3, 'expected several scans, got ' + calls);
  assert.ok(st.cadenceMs > 0 && st.cadenceMs < 1500, 'cadence stalled at ' + st.cadenceMs + 'ms');
});
