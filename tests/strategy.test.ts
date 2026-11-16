import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryReason, exitReason, STRAT_DEFAULTS, dipReclaim, firstPullback, alreadyPumpedHard, entrySignal, signalAdjustments, momentumBreakdown, liveExit, estimatedNetPnlPct, netPnlFromSellQuote, type TapeSnap, type StratParams } from '../server/strategy.ts';

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

test('netPnlFromSellQuote only counts a fill as profit after fees', () => {
  // $8 cost, sell 0.11 SOL at $80 (= $8.80) minus 0.0002 fees — clearly in profit
  const win = netPnlFromSellQuote(8, 0.11, 0.0002, 80);
  assert.ok(win > 3, 'win=' + win);
  // same cost, sell 0.096 SOL at $80 (= $7.68) — a loss, must not look like TP
  const loss = netPnlFromSellQuote(8, 0.096, 0.0002, 80);
  assert.ok(loss < 0, 'loss=' + loss);
});

const baseCoin = {
  mint: 'M', pool: 'P', symbol: 'X', name: 'X', dex: 'pump', priceUsd: 1, mcapUsd: 20_000, liquidityUsd: 8_000,
  createdAt: 0, change: { m5: 6, m15: 12, h1: 14, h6: 14, h24: 14 },
  volume: { m5: 2000, h1: 4000, h6: 4000, h24: 4000 },
  txns: { m5b: 12, m5s: 6, h1b: 20, h1s: 10, h24b: 20, h24s: 10 },
  traders1h: 20, quoteSymbol: 'SOL', source: 'pumpportal', universe: 'new' as const,
  curve: { progress: 0.15, vSol: 35, vTokens: 1e9, graduated: false },
  flow: { netBuySol: 0.4, largeBuys: 0, largeSells: 0, uniqueBuyers: 8, uniqueSellers: 2, whaleBuyUsd: 20 },
};

test('firstPullback fires on a modest impulse then a reclaim with buy pressure', () => {
  const t0 = 3_000_000;
  const hist: TapeSnap[] = [
    snap({ t: t0, px: 100, m5: 0, m15: 0, h1: 0, b5: 8, s5: 5 }),
    snap({ t: t0 + 1000, px: 112, m5: 12, m15: 12, h1: 12, b5: 14, s5: 6 }),
    snap({ t: t0 + 2000, px: 103, m5: 3, m15: 12, h1: 12, b5: 7, s5: 8 }),
    snap({ t: t0 + 3000, px: 107, m5: 5, m15: 12, h1: 12, b5: 16, s5: 7 }),
  ];
  const c = { ...baseCoin, createdAt: t0 - 10 * 60_000, priceUsd: 107 } as any;
  const r = firstPullback(c, hist, t0 + 3000);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.reason, /first pullback/);
  assert.equal(entrySignal(c, hist, STRAT_DEFAULTS, t0 + 3000).ok, true);
});

test('already-pumped coins take a penalty, they are not hard-skipped', () => {
  const t0 = 4_000_000;
  const pumped = { ...baseCoin, createdAt: t0 - 20 * 60_000, change: { m5: 42, m15: 55, h1: 80, h6: 80, h24: 80 }, priceUsd: 180 } as any;
  const histP: TapeSnap[] = [snap({ t: t0, px: 100, m5: 42, m15: 55, h1: 80 })];
  assert.equal(alreadyPumpedHard(pumped, histP, t0), true);
  const adj = signalAdjustments(pumped, histP, t0);
  assert.ok(adj.notes.some((n) => n.includes('already pumped')), adj.notes.join('|'));
  assert.ok(adj.adj <= 8, 'pumped penalty should offset some bonuses, adj=' + adj.adj);

  const second: TapeSnap[] = [
    snap({ t: t0, px: 100, m5: 0, m15: 0, b5: 10, s5: 5 }),
    snap({ t: t0 + 1000, px: 112, m5: 12, m15: 12, b5: 14, s5: 6 }),
    snap({ t: t0 + 2000, px: 104, m5: 4, m15: 12, b5: 8, s5: 7 }),
    snap({ t: t0 + 3000, px: 125, m5: 16, m15: 25, b5: 18, s5: 8 }),
    snap({ t: t0 + 4000, px: 118, m5: 10, m15: 25, b5: 16, s5: 7 }),
  ];
  const c = { ...baseCoin, createdAt: t0 - 15 * 60_000, priceUsd: 118, change: { m5: 10, m15: 25, h1: 25, h6: 25, h24: 25 } } as any;
  const r = firstPullback(c, second, t0 + 4000);
  assert.equal(r.ok, false, r.reason);
});
