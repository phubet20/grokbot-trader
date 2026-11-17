import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gb-mode-'));
process.env.DATA_DIR = dir;

const { DEFAULTS, LIVE_CONFIRM_PHRASE } = await import('../server/config.ts');
const { Store } = await import('../server/store.ts');
const { ReplayMarket } = await import('../server/replay.ts');
const { Engine } = await import('../server/engine.ts');
const { snapCacheKey } = await import('../web/src/boot.ts');

function engine(name: string, live = false) {
  const store = new Store(join(dir, name + '.db'));
  const cfg = live
    ? { ...DEFAULTS, mode: 'live-auto' as const, liveConfirm: LIVE_CONFIRM_PHRASE, scanIntervalSec: 9999, monitorIntervalSec: 9999 }
    : { ...DEFAULTS, scanIntervalSec: 9999, monitorIntervalSec: 9999 };
  return { e: new Engine(cfg, new ReplayMarket(10), store), store, cfg };
}

test('paper and live books do not mix trades, equity, or activity', async () => {
  const { e, store } = engine('iso', true);
  // Switch to TEST first so connect writes the virtual book, not the live one.
  await e.setRuntimeMode('paper');
  await e.connect({ type: 'paper', startUsd: 70 });
  store.addTrade({ id: 'p1', closedAt: Date.now(), book: 'paper', symbol: 'PAPERCOIN', pnlUsd: 1, costUsd: 5, proceedsUsd: 6 } as any);
  store.addTrade({ id: 'l1', closedAt: Date.now(), book: 'live', symbol: 'LIVECOIN', pnlUsd: -2, costUsd: 4, proceedsUsd: 2 } as any);
  store.addEquity(Date.now(), 70, 'paper');
  store.addEquity(Date.now() + 1, 1.5, 'live');
  assert.equal(store.trades(10, 'paper').some((t: any) => t.symbol === 'LIVECOIN'), false);
  assert.equal(store.trades(10, 'live').some((t: any) => t.symbol === 'PAPERCOIN'), false);
  assert.ok(e.stats().equity > 10, 'paper stats use the paper book');
  await e.setRuntimeMode('live-auto');
  const liveStats = e.stats();
  assert.equal(liveStats.closed, 1, 'live sees only the live trade, closed=' + liveStats.closed);
  assert.equal(store.equity(0, 'live').some((r: any) => r.usd === 70 || r.usd > 60), false, 'paper $70 equity must not appear on the live book');
  e.stop();
});

test('switching to TEST keeps live positions managed and opens no live mix in paper PnL', async () => {
  const { e } = engine('hold', true);
  await e.setRuntimeMode('live-auto');
  e.positions.push({ id: 'liv1', mint: 'MintLive11111111111111111111111111111111111', pool: 'p', symbol: 'LIVE', name: 'LIVE', openedAt: Date.now(), entryPrice: 1, qty: 10, decimals: 6, costUsd: 0.5, costSol: 0.007, peakPrice: 1, lastPrice: 1, score: 60, rentSol: 0.002, book: 'live' } as any);
  (e as any).liveHeld = [...e.positions];
  (e as any).saveActiveBook();
  // Do not let a real on-chain reconcile wipe the planted live row in this isolation test.
  (e as any).reconcileOnchain = async () => {};
  (e as any).refreshLiveBook = async () => {};
  const r = await e.setRuntimeMode('paper');
  assert.equal(r.mode, 'paper');
  assert.equal(e.mode, 'paper');
  assert.equal((e as any).liveHeld.length, 1);
  const view = e.positionsView();
  assert.ok(view.some((p: any) => p.symbol === 'LIVE' && (p.book === 'live' || p.liveManaged)));
  assert.ok(e.stats().equity > 1, 'paper equity is the virtual book, not the live dust position');
  // paper PnL must not include the live position cost
  assert.ok(!e.positions.some((p) => p.id === 'liv1'), 'active paper book should not own the live row');
  e.stop();
});

test('switching to LIVE without the host confirm phrase is rejected', async () => {
  const { e } = engine('noconfirm', false);
  await assert.rejects(() => e.setRuntimeMode('live-auto'), /not armed/);
  e.stop();
});

test('reset paper book leaves live trades, withdraw lock, and learning alone', async () => {
  const { e, store } = engine('reset', true);
  await e.setRuntimeMode('paper');
  await e.connect({ type: 'paper', startUsd: 40 });
  store.set('withdrawTo', 'CgrPNY2dMhyB8QmfM8hGyBqLwbvrWdE2X58LZZyGSVye');
  store.addTrade({ id: 'live-keep', closedAt: Date.now(), book: 'live', symbol: 'KEEP', pnlUsd: 1, costUsd: 2, proceedsUsd: 3 } as any);
  e.tuner.record({ reason: 'first-pullback', pnlUsd: 2, costUsd: 6, pnlPct: 30, equity: 40, ts: Date.now() });
  e.store.set('autotune', e.tuner.dump());
  const n = e.tuner.snapshot().trades;
  e.reset();
  assert.equal(e.positions.length, 0);
  assert.equal(store.trades(10, 'live').some((t: any) => t.id === 'live-keep'), true);
  assert.equal(store.get('withdrawTo', ''), 'CgrPNY2dMhyB8QmfM8hGyBqLwbvrWdE2X58LZZyGSVye');
  const t2 = new (await import('../server/autotune.ts')).AutoTune();
  t2.load(store.get('autotune', null));
  assert.ok(t2.snapshot().trades >= n, 'learning kept');
  e.stop();
});

test('early dump skip catches coins that are already falling in the first seconds', async () => {
  const { e } = engine('dump', false);
  const earlyDump = { createdAt: Date.now() - 20_000, change: { m5: -8, m15: -4 }, txns: { m5b: 2, m5s: 12 } };
  const healthy = { createdAt: Date.now() - 20_000, change: { m5: 9, m15: 14 }, txns: { m5b: 20, m5s: 8 } };
  assert.equal((e as any).isDumpingEarly(earlyDump), true);
  assert.equal((e as any).isDumpingEarly(healthy), false);
  e.stop();
});

test('client cache keys are separate per mode so a refresh cannot show the other book', () => {
  assert.equal(snapCacheKey('paper'), 'grokbot.snap.v3.paper');
  assert.equal(snapCacheKey('live-auto'), 'grokbot.snap.v3.live');
  assert.notEqual(snapCacheKey('paper'), snapCacheKey('live'));
});
