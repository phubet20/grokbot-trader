import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoTune, patternKey, equityScore, MIN_SAMPLES, EPS, betaSample } from '../server/autotune.ts';

test('patternKey maps entry reasons to stable labels', () => {
  assert.equal(patternKey('fresh-launch burst · buyers + vol'), 'fresh-launch');
  assert.equal(patternKey('dip-reclaim after whale buy'), 'dip-reclaim');
  assert.equal(patternKey('buy candle · 15s green'), 'buy-candle');
  assert.equal(patternKey('whale inflow + unique buyers'), 'whale-inflow');
  assert.equal(patternKey('score 62 ≥ 50'), 'score');
  assert.equal(patternKey('curve breakout 48%'), 'curve-breakout');
});

test('equityScore prefers a smooth uptrend over a jumpy path with similar end equity', () => {
  const start = 100;
  const smooth = Array.from({ length: 20 }, (_, i) => start + i * 2);
  const jumpy = Array.from({ length: 20 }, (_, i) => start + i * 2 + (i % 2 ? 18 : -16));
  const a = equityScore(smooth);
  const b = equityScore(jumpy);
  assert.ok(a.smoothness > b.smoothness, `smooth ${a.smoothness} vs jumpy ${b.smoothness}`);
  assert.ok(a.score > b.score, `smooth score ${a.score} vs jumpy ${b.score}`);
});

test('weights lean after 2 losses, but patterns are never disabled and score nudges stay within ±3', () => {
  const t = new AutoTune();
  t.record({ reason: 'fresh-launch burst', pnlUsd: -2, costUsd: 10, pnlPct: -20, equity: 80 });
  const one = t.snapshot().patterns.find((p) => p.key === 'fresh-launch')!;
  assert.equal(one.disabled, false);
  assert.equal(one.weight, 1);
  t.record({ reason: 'fresh-launch burst', pnlUsd: -2, costUsd: 10, pnlPct: -20, equity: 78 });
  const early = t.snapshot().patterns.find((p) => p.key === 'fresh-launch')!;
  assert.equal(early.disabled, false);
  assert.ok(early.weight < 1, 'should lean after 2 losses, weight=' + early.weight);
  assert.ok(early.weight >= 0.85, 'lean is light, weight=' + early.weight);
  t.record({ reason: 'fresh-launch burst', pnlUsd: -2, costUsd: 10, pnlPct: -20, equity: 70 });
  const later = t.snapshot().patterns.find((p) => p.key === 'fresh-launch')!;
  assert.equal(later.n, MIN_SAMPLES);
  assert.equal(later.disabled, false);
  assert.ok(later.weight >= 0.85);
  assert.ok(later.minScoreAdj <= 3 && later.minScoreAdj >= -3);
  let allowed = 0;
  const rnd = (() => { let i = 0; return () => { i = (i * 17 + 11) % 1000; return i / 1000; }; })();
  for (let i = 0; i < 200; i++) if (t.allow('fresh-launch burst', rnd).ok) allowed++;
  assert.equal(allowed, 200, 'losing patterns stay allowed');
});

test('positive expectancy raises weight and does not disable', () => {
  const t = new AutoTune();
  let eq = 100;
  for (let i = 0; i < MIN_SAMPLES; i++) {
    eq += 3;
    t.record({ reason: 'buy candle · green', pnlUsd: 3, costUsd: 10, pnlPct: 30, equity: eq });
  }
  const s = t.snapshot().patterns.find((p) => p.key === 'buy-candle')!;
  assert.equal(s.disabled, false);
  assert.ok(s.weight > 1, `weight ${s.weight}`);
  assert.ok(s.weight <= 1.8);
  assert.ok(s.expectancy > 0);
  assert.ok(t.sizeMult('buy candle') >= 1);
  const g = t.allow('buy candle · green', () => 0.99);
  assert.equal(g.ok, true);
});

test('exit sensitivity stays inside guardrails and tightens after a losing streak', () => {
  const t = new AutoTune();
  assert.equal(t.exitSensitivity, 1);
  for (let i = 0; i < 20; i++) t.record({ reason: 'score 55 ≥ 50', pnlUsd: -4, costUsd: 10, pnlPct: -40, equity: 100 - i * 3 });
  assert.ok(t.exitSensitivity >= 0.75 && t.exitSensitivity <= 1.35);
  assert.ok(t.exitSensitivity > 1, `sens ${t.exitSensitivity}`);
});

test('dump/load restores weights', () => {
  const t = new AutoTune();
  for (let i = 0; i < MIN_SAMPLES; i++) t.record({ reason: 'whale inflow', pnlUsd: 2, costUsd: 8, pnlPct: 25, equity: 100 + i });
  const t2 = new AutoTune();
  t2.load(t.dump());
  const a = t.snapshot().patterns.find((p) => p.key === 'whale-inflow')!;
  const b = t2.snapshot().patterns.find((p) => p.key === 'whale-inflow')!;
  assert.equal(b.n, a.n);
  assert.equal(b.weight, a.weight);
  assert.equal(t2.exitSensitivity, t.exitSensitivity);
});

test('take-profit is recorded as an exit reason', () => {
  const t = new AutoTune();
  t.record({ reason: 'whale inflow', pnlUsd: 0.4, costUsd: 8, pnlPct: 5, equity: 82, exitKind: 'take_profit', exitReason: 'take profit +3.2% net (target +3%)' });
  t.record({ reason: 'whale inflow', pnlUsd: -0.2, costUsd: 8, pnlPct: -2.5, equity: 81.8, exitKind: 'momentum_fade', exitReason: 'momentum break · net sell flow' });
  const s = t.snapshot();
  assert.equal(s.exits.take_profit, 1);
  assert.equal(s.exits.momentum_fade, 1);
  const pat = s.patterns.find((p) => p.key === 'whale-inflow')!;
  assert.equal(pat.n, 2);
  assert.equal(pat.wins, 1);
});

test('betaSample stays in (0,1)', () => {
  for (let i = 0; i < 30; i++) {
    const x = betaSample(3, 5, () => (i + 1) / 31);
    assert.ok(x > 0 && x < 1, String(x));
  }
});

void EPS;

test('governor stays relaxed on cash-only SOL drift until there are closed trades', () => {
  const t = new AutoTune();
  const start = 100;
  const t0 = Date.now() - 8 * 60_000;
  for (let i = 0; i < 10; i++) t.observeEquity(start - i * 0.8, t0 + i * 50_000);
  assert.equal(t.governor(3).mode, 'relaxed');
});

test('governor no longer tightens score, size, or take-profit when equity stalls', () => {
  const t = new AutoTune();
  const start = 100;
  const t0 = Date.now() - 8 * 60_000;
  let eq = start;
  for (let i = 0; i < 4; i++) {
    eq -= 2;
    t.record({ reason: 'score 55', pnlUsd: -2, costUsd: 8, pnlPct: -25, equity: eq, ts: t0 + i * 50_000 });
  }
  for (let i = 0; i < 10; i++) t.observeEquity(start - i * 0.8, t0 + i * 50_000);
  const stalled = t.governor(3);
  assert.equal(stalled.mode, 'relaxed');
  assert.equal(stalled.minScoreAdj, 0);
  assert.equal(stalled.tpPct, 3);
  assert.equal(stalled.earlyCutSec, 25);
  assert.equal(stalled.sizeMult, 1);
  assert.equal(t.takeProfitPct(3), 3);
  const nudge = t.patternAdj('score 55');
  assert.ok(nudge >= -3 && nudge <= 3, `nudge ${nudge}`);
});

test('governor keeps size at 1 after wins and losses', () => {
  const t = new AutoTune();
  let eq = 100;
  const t0 = Date.now() - 6 * 60_000;
  for (let i = 0; i < 6; i++) {
    eq += 2;
    t.record({ reason: 'first pullback bounce', pnlUsd: 2, costUsd: 8, pnlPct: 25, equity: eq, ts: t0 + i * 50_000 });
  }
  const up = t.governor(3);
  assert.equal(up.sizeMult, 1);
  assert.equal(up.mode, 'relaxed');
  for (let i = 0; i < 6; i++) {
    eq -= 3;
    t.record({ reason: 'score 55 ≥ 50', pnlUsd: -3, costUsd: 8, pnlPct: -37, equity: eq, ts: Date.now() - (6 - i) * 40_000 });
  }
  const down = t.governor(3);
  assert.equal(down.mode, 'relaxed');
  assert.equal(down.sizeMult, 1);
});

test('governor state stays relaxed across dump/load', () => {
  const t = new AutoTune();
  const t0 = Date.now() - 8 * 60_000;
  let eq = 100;
  for (let i = 0; i < 4; i++) {
    eq -= 2;
    t.record({ reason: 'score 55', pnlUsd: -2, costUsd: 8, pnlPct: -25, equity: eq, ts: t0 + i * 50_000 });
  }
  for (let i = 0; i < 10; i++) t.observeEquity(100 - i, t0 + i * 50_000);
  assert.equal(t.governor().mode, 'relaxed');
  const t2 = new AutoTune();
  t2.load(t.dump());
  assert.equal(t2.governor().mode, 'relaxed');
  assert.equal(t2.snapshot().governor.minScoreAdj, 0);
  assert.equal(t2.snapshot().governor.tpPct, 3);
});
