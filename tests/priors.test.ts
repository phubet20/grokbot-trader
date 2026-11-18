import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoTune } from '../server/autotune.ts';
import {
  loadPaperPriors,
  pumpPathBoost,
  pumpPotential,
  isQuickRedExit,
  staleExitSec,
  isStalePosition,
  isDeadPosition,
  DEAD_EXIT_SEC,
  DEFAULT_STALE_SEC,
} from '../server/priors.ts';

const priors = loadPaperPriors();

test('paper priors load and expose winner paths', () => {
  assert.ok(priors);
  assert.ok((priors!.events?.length || 0) > 0);
  assert.ok(Array.isArray(priors!.winnerPaths));
});

test('isStalePosition flags flat quiet holds after the stale window', () => {
  const now = 1_000_000;
  const base = { openedAt: now - 120_000, entryPrice: 1, lastPrice: 1.002, now, staleSec: 105, volumeM5: 10, txM5: 1 };
  assert.equal(isStalePosition(base), true);
  assert.equal(isStalePosition({ ...base, lastPrice: 1.04 }), false);
  assert.equal(isStalePosition({ ...base, openedAt: now - 30_000 }), false);
  assert.equal(isStalePosition({ ...base, volumeM5: 500, txM5: 40 }), false);
});

test('stale window stays in the tight scalp band', () => {
  const a = staleExitSec(priors, true);
  const b = staleExitSec(priors, false);
  assert.ok(a >= 45 && a <= 90, 'stale=' + a);
  assert.ok(b >= 45 && b <= 90, 'stale=' + b);
  assert.ok(DEFAULT_STALE_SEC >= 45 && DEFAULT_STALE_SEC <= 90);
});

test('AutoTune seeds weighted priors once and favors realistic winners', () => {
  const t = new AutoTune();
  t.seedFromPriors([
    { pattern: 'first-pullback', pnlUsd: 2, costUsd: 6, pnlPct: 30, weight: 1 },
    { pattern: 'first-pullback', pnlUsd: 1.5, costUsd: 6, pnlPct: 25, weight: 1 },
    { pattern: 'first-pullback', pnlUsd: 1, costUsd: 6, pnlPct: 16, weight: 1 },
    { pattern: 'score', pnlUsd: -1, costUsd: 6, pnlPct: -16, weight: 0.4 },
    { pattern: 'score', pnlUsd: -0.8, costUsd: 6, pnlPct: -13, weight: 0.4 },
    { pattern: 'score', pnlUsd: -0.5, costUsd: 6, pnlPct: -8, weight: 0.4 },
  ]);
  const snap = t.snapshot();
  const fp = snap.patterns.find((p) => p.key === 'first-pullback')!;
  const sc = snap.patterns.find((p) => p.key === 'score')!;
  assert.ok(fp.n >= 3 && fp.expectancy > 0);
  assert.ok(sc.n > 0 && sc.n < 2, 'mark-settled should be down-weighted, n=' + sc.n);
  const n = snap.trades;
  t.seedFromPriors([{ pattern: 'score', pnlUsd: -10, costUsd: 6, pnlPct: -50, weight: 1 }]);
  assert.equal(t.snapshot().trades, n, 'seed only once');
});

test('isDeadPosition sells losers that went quiet', () => {
  const now = 10_000_000;
  const down = {
    openedAt: now - (DEAD_EXIT_SEC + 30) * 1000,
    entryPrice: 1,
    lastPrice: 0.92,
    now,
    volumeM5: 10,
    txM5: 1,
  };
  assert.equal(isDeadPosition(down), true);
  assert.equal(isDeadPosition({ ...down, lastPrice: 1.02 }), false);
  assert.equal(isDeadPosition({ ...down, openedAt: now - 60_000 }), false);
  assert.equal(isDeadPosition({ ...down, volumeM5: 400, txM5: 20 }), false);
});

test('isQuickRedExit sells a red position after the hold window, sooner if deeply red', () => {
  const now = 8_000_000;
  const red = { openedAt: now - 50_000, entryPrice: 1, lastPrice: 0.98, now, redExitSec: 45 };
  assert.equal(isQuickRedExit(red), true);
  assert.equal(isQuickRedExit({ ...red, lastPrice: 1.01 }), false);
  assert.equal(isQuickRedExit({ ...red, openedAt: now - 20_000 }), false);
  const deep = isQuickRedExit({ ...red, openedAt: now - 30_000, lastPrice: 0.95, redExitSec: 45 });
  assert.equal(deep, true);
});

test('pumpPotential ranks stronger volume+path tapes into higher tiers', () => {
  const weak: any = { change: { m5: 1.5, m15: 2, h1: 2 }, volume: { m5: 200, h1: 2000 }, txns: { m5b: 6, m5s: 5 }, flow: { netBuySol: 0.1 } };
  const mid: any = { change: { m5: 5, m15: 8, h1: 8 }, volume: { m5: 4000, h1: 18000 }, txns: { m5b: 20, m5s: 8 }, flow: { netBuySol: 0.8 } };
  const strong: any = {
    change: { m5: 8, m15: 14, h1: 14 }, volume: { m5: 12000, h1: 20000 }, txns: { m5b: 40, m5s: 10 },
    flow: { netBuySol: 2 }, curve: { progress: 0.3, vSol: 40, vTokens: 1, graduated: false },
  };
  const a = pumpPotential(weak, [], priors);
  const b = pumpPotential(mid, [], priors);
  const c = pumpPotential(strong, [], { ...priors!, winnerPaths: [{ volAccel: 7.2, buyRatio: 0.8, chM5: 8, chM15: 14, buyers: 40 }] });
  assert.ok(b.score >= a.score, `mid ${b.score} vs weak ${a.score}`);
  assert.ok(c.tier >= 10, `strong tier ${c.tier}`);
  assert.ok([0, 10, 100, 1000].includes(c.tier));
});
