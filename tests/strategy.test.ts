import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryReason, exitReason, STRAT_DEFAULTS, dipReclaim, momentumBreakdown, liveExit, estimatedNetPnlPct, type TapeSnap, type StratParams } from '../server/strategy.ts';

function snap(over: Partial<TapeSnap> & { t: number; px: number }): TapeSnap {
  return {
    liq: 40_000, mc: 80_000, m5: 4, m15: 8, h1: 12, vol5: 5000, vol1h: 12000,
    b5: 20, s5: 10, b1: 80, s1: 40, tr: 80, age: over.t - 30 * 60_000, ...over,
  };
}

const STRICT: StratParams = {
  ...STRAT_DEFAULTS,
  minHistTicks: 4, minImpulsePct: 3.5, pullbackMinPct: 1.2, pullbackMaxPct: 7,
  holdFloorPct: 9, maxTickVolPct: 8, maxH1: 45, maxM5: 10,
};

test('fast default entry can fire on the first qualifying snapshot', () => {
  const t0 = 1_000_000;
  const r = entryReason([snap({ t: t0, px: 100 })], STRAT_DEFAULTS, t0);
  assert.equal(r.ok, true, r.reason);
});

test('fast entry still rejects honeypot-ratio and blow-off pumps', () => {
  const t0 = 1_000_000;
  const honey = snap({ t: t0, px: 100, b5: 40, s5: 1, m5: 8 });
  assert.equal(entryReason([honey], STRAT_DEFAULTS, t0).ok, false);
  const blown = snap({ t: t0, px: 100, m5: 80, h1: 120 });
  assert.equal(entryReason([blown], STRAT_DEFAULTS, t0).ok, false);
});

test('optional strict preset still requires impulse + pullback and rejects a chase', () => {
  const t0 = 1_000_000;
  const hist: TapeSnap[] = [
    snap({ t: t0, px: 100 }),
    snap({ t: t0 + 8000, px: 104 }),
    snap({ t: t0 + 16000, px: 106 }),
    snap({ t: t0 + 24000, px: 103, m5: 3, m15: 8 }),
  ];
  const ok = entryReason(hist, STRICT, t0 + 24000);
  assert.equal(ok.ok, true, ok.reason);
  const chase: TapeSnap[] = hist.slice(0, 3);
  chase[2] = snap({ t: t0 + 16000, px: 106, m5: 20, h1: 80 });
  assert.equal(entryReason(chase, STRICT, t0 + 16000).ok, false);
});

test('strict preset rejects high-vol candles and already-pumped coins', () => {
  const t0 = 2_000_000;
  const hist: TapeSnap[] = [
    snap({ t: t0, px: 100 }),
    snap({ t: t0 + 8000, px: 120 }),
    snap({ t: t0 + 16000, px: 118 }),
    snap({ t: t0 + 24000, px: 116, h1: 80 }),
  ];
  assert.equal(entryReason(hist, STRICT, t0 + 24000).ok, false);
});

test('partial take-profit then breakeven on the runner', () => {
  const p = { ...STRAT_DEFAULTS, takeProfitPct: 4.5, partialPct: 50, breakevenAtPct: 2, hardStopPct: 3.5 };
  const pos = { entryPrice: 100, peakPrice: 100, openedAt: 0, partialTaken: false, breakeven: false };
  const tp = exitReason(pos, 104.6, p, 1000);
  assert.equal(tp.partial, true);
  assert.equal(tp.kind, 'partial_tp');
  const after = { ...pos, peakPrice: 104.6, partialTaken: true, breakeven: true };
  const be = exitReason(after, 100.05, p, 5000);
  assert.equal(be.kind, 'breakeven');
  const hard = exitReason(after, 96, p, 6000);
  assert.equal(hard.kind, 'hard_stop');
});

test('liveExit without a TP setting only uses momentum break or a wide catastrophic stop', () => {
  const pos = { entryPrice: 100, peakPrice: 110, openedAt: 0 };
  const hold = liveExit(pos, 97, undefined, [], { catStopPct: 35 }); // -3%, a normal pullback
  assert.equal(hold.exit, false, hold.reason);
  const noTp = liveExit(pos, 115, undefined, [], { catStopPct: 35, takeProfitPct: 0 });
  assert.equal(noTp.exit, false, 'TP disabled');
  const cat = liveExit(pos, 64, undefined, [], { catStopPct: 35 });
  assert.equal(cat.exit, true);
  assert.match(cat.reason, /catastrophic/);
  const rug = liveExit({ ...pos, entryLiq: 10_000 }, 100, { liquidityUsd: 3000 } as any, [], { catStopPct: 35 });
  assert.equal(rug.exit, true);
  assert.match(rug.reason, /liquidity pulled/);
});

test('liveExit takes profit at +3% net after estimated fees and slippage, 100% close', () => {
  const pos = { entryPrice: 100, qty: 1, costUsd: 100.15, peakPrice: 100, openedAt: 0 };
  const opts = { catStopPct: 35, takeProfitPct: 3, extraSlippageBps: 50, feeUsd: 0.02 };
  const under = liveExit(pos, 103.0, undefined, [], opts);
  assert.equal(under.exit, false, `net ${estimatedNetPnlPct(pos, 103, opts)} should be under 3%. ${under.reason}`);
  const hit = liveExit(pos, 104.0, undefined, [], opts);
  assert.equal(hit.exit, true, `net ${estimatedNetPnlPct(pos, 104, opts)}`);
  assert.equal(hit.kind, 'take_profit');
  assert.equal(hit.partial, false);
  assert.match(hit.reason, /take profit/i);
  // A +2% mark with the haircut must not fire.
  const barely = liveExit(pos, 102.0, undefined, [], opts);
  assert.equal(barely.exit, false, barely.reason);
  // Momentum still used when below TP.
  const dump = { t: 1, px: 101, liq: 20_000, mc: 80_000, m5: -4, m15: 2, h1: 10, vol5: 1000, vol1h: 5000, b5: 4, s5: 16, b1: 20, s1: 40, tr: 40, age: 1 };
  const mom = liveExit(pos, 101, undefined, [dump], opts);
  assert.equal(mom.exit, true);
  assert.equal(mom.kind, 'momentum_fade');
});

test('momentum breakdown exits on net sell flow or a lower low after the peak', () => {
  const now = 1_000_000;
  const dump = { t: now, px: 90, liq: 20_000, mc: 80_000, m5: -4, m15: 2, h1: 10, vol5: 1000, vol1h: 5000, b5: 4, s5: 16, b1: 20, s1: 40, tr: 40, age: now };
  assert.equal(momentumBreakdown(undefined, dump, [dump]).exit, true);
  const hist = [
    snap({ t: now, px: 100 }),
    snap({ t: now + 1000, px: 120 }),
    snap({ t: now + 2000, px: 110 }),
    snap({ t: now + 3000, px: 108, b5: 8, s5: 6 }),
  ];
  const shallow = momentumBreakdown(undefined, hist[3], hist);
  assert.equal(shallow.exit, false, shallow.reason);
  const ll = [
    snap({ t: now, px: 100 }),
    snap({ t: now + 1000, px: 120 }),
    snap({ t: now + 2000, px: 108 }),
    snap({ t: now + 3000, px: 100 }),
  ];
  assert.equal(momentumBreakdown(undefined, ll[3], ll).exit, true);
});

test('dip-reclaim fires only after a bounce with buy flow, never while still falling', () => {
  const t0 = 2_000_000;
  const falling: TapeSnap[] = [
    snap({ t: t0, px: 100 }),
    snap({ t: t0 + 1000, px: 92 }),
    snap({ t: t0 + 2000, px: 88, b5: 8, s5: 6 }),
  ];
  assert.equal(dipReclaim(falling).ok, false);
  const rebound: TapeSnap[] = [
    snap({ t: t0, px: 100 }),
    snap({ t: t0 + 1000, px: 88 }),
    snap({ t: t0 + 2000, px: 95, b5: 20, s5: 8 }),
  ];
  const r = dipReclaim(rebound);
  assert.equal(r.ok, true, r.reason);
});
