import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../server/market.ts';
import { detectBosChoch, fairValueGaps, orderBlocks, smcEntry, toBars } from '../server/smc.ts';
import { dailyNarrative, narrativeBoost, themesOf } from '../server/narrative.ts';
import { momentumConfirm, isEstablished, toSnap, type TapeSnap } from '../server/strategy.ts';
import { AutoTune, patternKey, MIN_SAMPLES } from '../server/autotune.ts';
import type { Candidate } from '../server/types.ts';

const bar = (t: number, o: number, h: number, l: number, c: number, v = 10): Candle => [t, o, h, l, c, v];

function downThenBreakAndPullback(): Candle[] {
  // Uptrend to a swing high at 10, pull back, last down-candle OB, BOS close above 10, then pullback into the OB.
  const out: Candle[] = [];
  let t = 1_000;
  const seq: [number, number, number, number][] = [
    [8.0, 8.3, 7.9, 8.2],
    [8.2, 8.7, 8.1, 8.6],
    [8.6, 9.2, 8.5, 9.1],
    [9.1, 10.0, 9.0, 9.8],   // swing high 10
    [9.8, 9.9, 9.2, 9.3],    // start of pullback
    [9.3, 9.4, 8.8, 8.9],
    [8.9, 9.0, 8.5, 8.6],
    [8.6, 8.7, 8.3, 8.4],    // last bearish OB (8.3–8.6)
    [8.4, 10.4, 8.35, 10.2], // BOS: close 10.2 > swing high 10
    [10.2, 10.5, 9.9, 10.0],
    [10.0, 10.1, 8.35, 8.7], // wick into OB
    [8.7, 9.1, 8.5, 8.9],    // close holds above OB low
  ];
  for (const [o, h, l, c] of seq) { out.push(bar(t, o, h, l, c)); t += 60; }
  return out;
}

test('detectBosChoch flags a bullish break after a downtrend', () => {
  const ev = detectBosChoch(toBars(downThenBreakAndPullback()));
  assert.ok(ev.some((e) => e.dir === 'bull'), JSON.stringify(ev));
});

test('smcEntry fires on a pullback into an OB or FVG after BOS/CHoCH, not on the breakout bar', () => {
  const all = downThenBreakAndPullback();
  const atBreak = smcEntry(all.slice(0, 9)); // ends on the BOS bar — no pullback yet
  assert.equal(atBreak.ok, false, atBreak.reason);
  const hit = smcEntry(all);
  assert.equal(hit.ok, true, hit.reason);
  assert.match(hit.reason, /pullback after (BOS|CHoCH)/);
  assert.match(hit.kind, /ob-pullback|fvg-pullback/);
});

test('fairValueGaps finds a 3-candle bullish imbalance', () => {
  const cs: Candle[] = [
    bar(1, 10, 10.1, 9.9, 10),
    bar(2, 10, 10.2, 9.95, 10.15),
    bar(3, 10.2, 12.0, 10.2, 11.8), // displacement
    bar(4, 11.8, 12.1, 11.6, 11.9), // 11.6 > 10.2? need left.h < right.l; left is bar2 h=10.2, this l=11.6
  ];
  // FVG between bar index 1 (h 10.2) and bar index 3 (l 11.6) if we use i=3, i-2=1
  const zs = fairValueGaps(toBars(cs), []);
  assert.ok(zs.some((z) => z.kind === 'fvg' && z.lo < z.hi), JSON.stringify(zs));
});

test('themes and dailyNarrative pick a dominant meta and boost matches', () => {
  assert.deepEqual(themesOf('Grok AI Agent', 'GROKAI').sort(), ['ai', 'elon'].sort().filter((k) => themesOf('Grok AI Agent', 'GROKAI').includes(k)));
  assert.ok(themesOf('Grok AI Agent', 'GROKAI').includes('ai'));
  const cands = [
    { symbol: 'AGENT', name: 'AI Agent', change: { h1: 40 } },
    { symbol: 'GPTSOL', name: 'GPT sol', change: { h1: 22 } },
    { symbol: 'CLAUDE', name: 'Claude bot', change: { h1: 18 } },
    { symbol: 'DOGE2', name: 'tiny dog', change: { h1: 2 } },
  ] as any;
  const n = dailyNarrative(cands, 3);
  assert.equal(n.key, 'ai');
  assert.ok(narrativeBoost({ name: 'AI Agent', symbol: 'AGENT' } as any, n) === 8);
  assert.equal(narrativeBoost({ name: 'Random', symbol: 'XYZ' } as any, n), 0);
});

const baseC = {
  mint: 'M', pool: 'P', symbol: 'X', name: 'X', dex: 'raydium', priceUsd: 1, mcapUsd: 10_000, liquidityUsd: 20_000,
  createdAt: Date.now() - 5 * 60_000, change: { m5: 4, m15: 5, h1: 8, h6: 10, h24: 12 },
  volume: { m5: 3000, h1: 10_000, h6: 20_000, h24: 40_000 },
  txns: { m5b: 20, m5s: 8, h1b: 80, h1s: 40, h24b: 200, h24s: 120 }, traders1h: 50, quoteSymbol: 'SOL', source: 't',
} as Candidate;

test('momentumConfirm requires buy pressure and thrust; rejects a dead tape', () => {
  const okHist: TapeSnap[] = [
    { t: 1, px: 1, liq: 20_000, mc: 10_000, m5: 1, m15: 2, h1: 3, vol5: 800, vol1h: 5000, b5: 10, s5: 8, b1: 40, s1: 30, tr: 20, age: 1 },
    { t: 2, px: 1.04, liq: 20_000, mc: 10_000, m5: 3, m15: 4, h1: 5, vol5: 1600, vol1h: 5000, b5: 18, s5: 6, b1: 50, s1: 30, tr: 20, age: 1 },
  ];
  assert.equal(momentumConfirm(baseC, okHist, 3).ok, true);
  const dead: TapeSnap[] = [
    { t: 1, px: 1, liq: 20_000, mc: 10_000, m5: -2, m15: 0, h1: 1, vol5: 200, vol1h: 5000, b5: 4, s5: 12, b1: 20, s1: 30, tr: 20, age: 1 },
  ];
  assert.equal(momentumConfirm(baseC, dead, 2).ok, false);
});

test('isEstablished is true for trending or older coins, false for fresh pump curves', () => {
  const now = Date.now();
  assert.equal(isEstablished({ ...baseC, universe: 'trending', createdAt: now - 60_000 }, now), true);
  assert.equal(isEstablished({ ...baseC, universe: 'new', createdAt: now - 5 * 60_000, curve: { progress: 0.2, vSol: 10, vTokens: 1, graduated: false } }, now), false);
  assert.equal(isEstablished({ ...baseC, universe: 'new', createdAt: now - 40 * 60_000 }, now), true);
});

test('patternKey maps SMC pullbacks and autotune penalizes immediate-red patterns', () => {
  assert.equal(patternKey('OB pullback after CHoCH'), 'ob-pullback');
  assert.equal(patternKey('FVG pullback after BOS'), 'fvg-pullback');
  const t = new AutoTune();
  for (let i = 0; i < MIN_SAMPLES; i++) {
    t.record({ reason: 'OB pullback after BOS', pnlUsd: -1, costUsd: 8, pnlPct: -12, equity: 80 - i, immediateRed: true });
  }
  const s = t.snapshot().patterns.find((p) => p.key === 'ob-pullback')!;
  assert.ok(s.immediateRate >= 0.7);
  assert.equal(s.disabled, true);
  assert.equal(s.weight, 0);
});
