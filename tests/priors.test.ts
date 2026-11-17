import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoTune } from '../server/autotune.ts';
import { pathSimilarity, pumpPathBoost, isStalePosition, isDeadPosition, staleExitSec, DEAD_EXIT_SEC, type PaperPriors, type PathVec } from '../server/priors.ts';

const winner: PathVec = { volAccel: 1.8, buyRatio: 0.65, chM5: 10, chM15: 16, buyers: 22 };
const priors: PaperPriors = {
  version: 1, builtAt: '2026-11-17', sources: ['test'],
  weighting: { realistic: 1, mark: 0.4, unrealized: 0.25 },
  events: [], patterns: [], winnerPaths: [winner], loserPaths: [],
  staleExit: { defaultSec: 105, minSec: 90, maxSec: 180 },
};

test('path similarity is high for close winner-like tapes and low for dumps', () => {
  const close = { volAccel: 1.7, buyRatio: 0.63, chM5: 9, chM15: 15, buyers: 18 };
  const dump = { volAccel: 0.2, buyRatio: 0.25, chM5: -12, chM15: -20, buyers: 3 };
  assert.ok(pathSimilarity(winner, close) > 0.85, 'close=' + pathSimilarity(winner, close));
  assert.ok(pathSimilarity(winner, dump) < 0.7, 'dump=' + pathSimilarity(winner, dump));
});

test('pumpPathBoost only fires for close matches', () => {
  const c = { volume: { m5: 1500, h1: 8000, h6: 0, h24: 0 }, txns: { m5b: 40, m5s: 20, h1b: 0, h1s: 0, h24b: 0, h24s: 0 }, change: { m5: 10, m15: 16, h1: 20, h6: 0, h24: 0 }, traders1h: 20 } as any;
  const hit = pumpPathBoost(c, [], priors);
  assert.ok(hit.boost >= 4, 'boost=' + hit.boost + ' best=' + hit.best);
  const miss = pumpPathBoost({ ...c, volume: { m5: 10, h1: 8000, h6: 0, h24: 0 }, txns: { m5b: 2, m5s: 20, h1b: 0, h1s: 0, h24b: 0, h24s: 0 }, change: { m5: -8, m15: -12, h1: 0, h6: 0, h24: 0 } }, [], priors);
  assert.equal(miss.boost, 0);
});

test('isStalePosition requires flat price and dead volume after the window', () => {
  const now = 1_000_000;
  const base = { openedAt: now - 120_000, entryPrice: 1, lastPrice: 1.002, now, staleSec: 105, volumeM5: 10, txM5: 1 };
  assert.equal(isStalePosition(base), true);
  assert.equal(isStalePosition({ ...base, lastPrice: 1.04 }), false); // still working
  assert.equal(isStalePosition({ ...base, openedAt: now - 30_000 }), false); // too new
  assert.equal(isStalePosition({ ...base, volumeM5: 500, txM5: 40 }), false); // volume alive
});

test('stale window tightens when the governor is tight', () => {
  assert.equal(staleExitSec(priors, true), 120);
  assert.equal(staleExitSec(priors, false), 120);
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

test('isDeadPosition sells losers that went quiet for ~12 minutes', () => {
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
