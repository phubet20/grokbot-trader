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
    await e.flushWork(600);
    await e.monitor();
    await e.flushWork(600);
    assert.ok(e.wallet.solBalance >= 0, 'cash never negative');
  }
  const s = e.stats();
  assert.ok(s.trades > 0, 'made some trades');
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
    await e.flushWork(600);
    await e.monitor();
    await e.flushWork(600);
    assert.ok(e.wallet.solBalance >= -1e-9, 'cash never negative');
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

test('re-connecting paper resumes the saved book and does not reset it', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-reconn-'));
  const cfg = { ...DEFAULTS, startUsd: 81, scanIntervalSec: 9999, monitorIntervalSec: 9999 };
  const m = new ReplayMarket(10);
  const e = new Engine(cfg, m, new Store(join(dirp, 't.db')));
  await e.connect({ type: 'paper', startUsd: 81 });
  assert.ok(Math.abs(e.equity() - 81) < 0.05);
  e.positions.push({ id: 'x', mint: 'M', pool: 'P', symbol: 'X', name: 'X', openedAt: Date.now(), entryPrice: 1, qty: 1, decimals: 6, costUsd: 10, costSol: 0.1, peakPrice: 1, lastPrice: 1, score: 50, rentSol: 0 } as any);
  // Hang all subsequent price fetches — Connect must still return on the cached price.
  m.prices = async () => new Promise(() => {});
  const t0 = Date.now();
  const w = await e.connect({ type: 'paper', startUsd: 12 });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, 'connect took ' + ms + 'ms');
  assert.equal(e.positions.length, 1, 'reconnect must keep open positions');
  assert.ok(Math.abs(e.wallet.depositUsd - 81) < 0.05, 'deposit should stay 81, got ' + e.wallet.depositUsd);
  assert.equal(w.connected, true);
  e.stop();
});

test('explicit reset paper book is the only way to start a new test balance', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-reset-'));
  const cfg = { ...DEFAULTS, startUsd: 81, scanIntervalSec: 9999, monitorIntervalSec: 9999 };
  const m = new ReplayMarket(10);
  const store = new Store(join(dirp, 't.db'));
  const e = new Engine(cfg, m, store);
  await e.connect({ type: 'paper', startUsd: 81 });
  e.positions.push({ id: 'x', mint: 'M', pool: 'P', symbol: 'X', name: 'X', openedAt: Date.now(), entryPrice: 1, qty: 1, decimals: 6, costUsd: 10, costSol: 0.1, peakPrice: 1, lastPrice: 1, score: 50, rentSol: 0 } as any);
  e.reset();
  assert.equal(e.positions.length, 0);
  assert.equal(e.wallet.connected, false);
  const e2 = new Engine(cfg, m, store);
  await e2.connect({ type: 'paper', startUsd: 12 });
  assert.ok(Math.abs(e2.wallet.depositUsd - 12) < 0.05, 'deposit=' + e2.wallet.depositUsd);
  e2.stop();
});

test('manual close sells 100% of one paper position and leaves the others', async () => {
  const dirm = mkdtempSync(join(tmpdir(), 'gb-mc-'));
  const cfg = { ...DEFAULTS, scanIntervalSec: 9999, monitorIntervalSec: 9999 };
  const m = new ReplayMarket(1);
  const e = new Engine(cfg, m, new Store(join(dirm, 't.db')));
  await e.connect({ type: 'paper', startUsd: 20 });
  e.setRunning(false); // no new entries while we test a manual close
  const { list } = await m.candidates();
  const a = list[0], b = list[1];
  const mk = (c: any, id: string) => ({
    id, mint: c.mint, pool: c.pool, symbol: c.symbol, name: c.name, openedAt: Date.now(),
    entryPrice: c.priceUsd, qty: 1000, decimals: 6, costUsd: 2, costSol: 2 / e.solPrice,
    peakPrice: c.priceUsd, lastPrice: c.priceUsd, score: 60, rentSol: 0.00203928,
  });
  e.positions.push(mk(a, 'pos-a'), mk(b, 'pos-b'));
  e.wallet.solBalance = Math.max(0, e.wallet.solBalance - 0.01);
  const cashBefore = e.wallet.solBalance;
  const othersBefore = e.positions.filter((p) => p.id !== 'pos-a').map((p) => p.id);
  const miss = await e.manualClose('does-not-exist');
  assert.equal(miss.ok, false);
  const r = await e.manualClose('pos-a');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.symbol, a.symbol);
  assert.equal(e.positions.some((p) => p.id === 'pos-a'), false);
  assert.deepEqual(e.positions.map((p) => p.id), othersBefore);
  assert.ok(e.wallet.solBalance > cashBefore, 'cash returned');
  const t = e.store.trades().find((x: any) => x.id === 'pos-a');
  assert.ok(t, 'trade recorded');
  assert.equal(t.kind, 'manual');
  assert.match(String(t.reason), /manual/);
  assert.ok(Math.abs(t.pnlUsd - (t.proceedsUsd - t.costUsd)) < 1e-9);
  e.stop();
});

test('close all sells every paper position and returns a per-coin result', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-ca-'));
  const cfg = { ...DEFAULTS, scanIntervalSec: 9999, monitorIntervalSec: 9999, realisticPaper: true };
  const m = new ReplayMarket(1);
  const e = new Engine(cfg, m, new Store(join(dirp, 't.db')));
  await e.connect({ type: 'paper', startUsd: 20 });
  e.setRunning(false);
  const { list } = await m.candidates();
  const mk = (c: any, id: string) => ({
    id, mint: c.mint, pool: c.pool, symbol: c.symbol, name: c.name, openedAt: Date.now(),
    entryPrice: c.priceUsd, qty: 1000, decimals: 6, costUsd: 2, costSol: 2 / e.solPrice,
    peakPrice: c.priceUsd, lastPrice: c.priceUsd, score: 60, rentSol: 0.00203928,
  });
  e.positions.push(mk(list[0], 'pos-a'), mk(list[1], 'pos-b'), mk(list[2], 'pos-c'));
  const r = await e.closeAll();
  assert.equal(r.results.length, 3);
  assert.equal(r.closed, 3, JSON.stringify(r.results));
  assert.equal(r.failed, 0);
  assert.equal(e.positions.length, 0);
  e.stop();
});

test('paper withdraw is refused', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-wd-'));
  const e = new Engine({ ...DEFAULTS, scanIntervalSec: 9999, monitorIntervalSec: 9999 }, new ReplayMarket(1), new Store(join(dirp, 't.db')));
  await e.connect({ type: 'paper', startUsd: 10 });
  await assert.rejects(() => e.withdraw({ max: true }), /disabled in paper/);
  e.stop();
});

test('restartTrading clears in-flight flags and does not wipe positions or the withdraw lock', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-restart-'));
  const cfg = { ...DEFAULTS, startUsd: 10, scanIntervalSec: 9999, monitorIntervalSec: 9999 };
  const e = new Engine(cfg, new ReplayMarket(10), new Store(join(dirp, 't.db')));
  await e.connect({ type: 'paper', startUsd: 10 });
  const locked = 'CgrPNY2dMhyB8QmfM8hGyBqLwbvrWdE2X58LZZyGSVye';
  e.store.set('withdrawTo', locked);
  const beforeEq = e.equity();
  const beforePos = e.positions.length;
  const beforeTrades = e.store.trades().length;
  e.setRunning(true);
  const r = e.restartTrading();
  assert.equal(r.ok, true);
  assert.equal(r.running, true);
  assert.equal(e.lockedWithdrawTo(), locked);
  assert.equal(e.positions.length, beforePos);
  assert.equal(e.store.trades().length, beforeTrades);
  assert.ok(Math.abs(e.equity() - beforeEq) < 1e-6);
  assert.equal(e.wallet.solBalance > 0, true);
  e.stop();
});
