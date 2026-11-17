import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryReason, exitReason, STRAT_DEFAULTS, dipReclaim, firstPullback, alreadyPumpedHard, entrySignal, signalAdjustments, currentlyPumping, momentumBreakdown, liveExit, isStrongRunner, estimatedNetPnlPct, netPnlFromSellQuote, RUNNER_TRAIL_PCT, type TapeSnap, type StratParams } from '../server/strategy.ts';

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

test('liveExit does not cap a runner at the TP floor — it scales, then trails', () => {
  const pos = { entryPrice: 100, qty: 1, costUsd: 100, peakPrice: 100, openedAt: 0 };
  const opts = { catStopPct: 35, takeProfitPct: 1.8, extraSlippageBps: 0, feeUsd: 0 };
  // Weak / no tape just above the floor: take the scalp.
  const weak = liveExit(pos, 104, undefined, [], opts);
  assert.equal(weak.kind, 'take_profit');
  assert.equal(weak.partial, false);

  const runner = {
    priceUsd: 120, liquidityUsd: 25_000,
    change: { m5: 12, m15: 20, h1: 20, h6: 20, h24: 20 },
    volume: { m5: 8000, h1: 10_000, h6: 10_000, h24: 10_000 },
    txns: { m5b: 40, m5s: 8, h1b: 80, h1s: 20 },
  } as any;
  const hist: TapeSnap[] = [{ t: 1, px: 120, liq: 25_000, mc: 80_000, m5: 12, m15: 20, h1: 20, vol5: 8000, vol1h: 10_000, b5: 40, s5: 8, b1: 80, s1: 20, tr: 100, age: 1 }];
  assert.equal(isStrongRunner(pos, 120, runner, hist, { takeProfitPct: 1.8 }), true);
  const scale = liveExit(pos, 120, runner, hist, opts);
  assert.equal(scale.kind, 'partial_tp', scale.reason);
  assert.equal(scale.partial, true);

  const rest = liveExit({ ...pos, partialTaken: true, peakPrice: 120 }, 118, runner, hist, opts);
  assert.equal(rest.exit, false, 'runner remainder stays open near highs: ' + rest.reason);

  // Extended move, no tape, still near highs: do not full-close at the floor.
  const moon = liveExit({ ...pos, peakPrice: 900, partialTaken: true }, 890, undefined, [], opts);
  assert.equal(moon.exit, false, moon.reason);

  const trailPx = 900 * (1 - RUNNER_TRAIL_PCT / 100);
  const trailed = liveExit({ ...pos, peakPrice: 900, partialTaken: true }, trailPx, undefined, [], opts);
  assert.equal(trailed.exit, true);
  assert.equal(trailed.kind, 'trailing_stop');
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

test('already-pumped coins take a penalty only when the move is fading, not while still pumping', () => {
  const t0 = 4_000_000;
  const stillUp = { ...baseCoin, createdAt: t0 - 20 * 60_000, change: { m5: 42, m15: 55, h1: 80, h6: 80, h24: 80 }, priceUsd: 180 } as any;
  const histUp: TapeSnap[] = [snap({ t: t0, px: 180, m5: 42, m15: 55, h1: 80, b5: 20, s5: 6 })];
  assert.equal(alreadyPumpedHard(stillUp, histUp, t0), true);
  const live = signalAdjustments(stillUp, histUp, t0);
  assert.equal(live.notes.some((n) => n.includes('already pumped')), false, 'live pump should not be penalized: ' + live.notes.join('|'));
  assert.ok(currentlyPumping(stillUp, t0).ok);

  const pumped = { ...baseCoin, createdAt: t0 - 20 * 60_000, change: { m5: -2, m15: 55, h1: 80, h6: 80, h24: 80 }, priceUsd: 180 } as any;
  const histP: TapeSnap[] = [snap({ t: t0, px: 100, m5: -2, m15: 55, h1: 80 })];
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

test('tiny paper position still hits +3% TP when fixed fees are large vs size', () => {
  // $0.26 fill, $0.02 priority fee would be ~8% of cost un-capped and could block TP.
  const pos = { entryPrice: 1, qty: 0.26, costUsd: 0.26, peakPrice: 1, openedAt: 0 };
  const opts = { catStopPct: 35, takeProfitPct: 3, extraSlippageBps: 50, feeUsd: 0.02 };
  const miss = liveExit(pos, 1.03, undefined, [], opts);
  assert.equal(miss.exit, false, 'a bare +3% mark is still under after % costs, net=' + estimatedNetPnlPct(pos, 1.03, opts));
  const hit = liveExit(pos, 1.06, undefined, [], opts);
  assert.equal(hit.exit, true, 'net=' + estimatedNetPnlPct(pos, 1.06, opts) + ' ' + hit.reason);
  assert.equal(hit.kind, 'take_profit');
  // Uncapped, $0.02 fees on $0.26 would require a much bigger move; the cap keeps +6% reachable.
  assert.ok(estimatedNetPnlPct(pos, 1.06, opts) >= 3);
});

test('netPnlFromSellQuote caps fixed fees so a tiny winner stays a winner', () => {
  // 0.01 SOL received at $80 = $0.80, 0.0003 SOL fees = $0.024 on a $0.26 cost.
  const net = netPnlFromSellQuote(0.26, 0.01, 0.0003, 80);
  assert.ok(net > 100, 'net=' + net); // proceeds ~$0.80 minus capped ~$0.0026
  const loss = netPnlFromSellQuote(0.26, 0.003, 0.0003, 80);
  assert.ok(loss < 0, 'loss=' + loss);
});

test('currentlyPumping accepts pumping coins of any age and rejects dumps or flat tape', () => {
  const t0 = Date.now();
  const pump = { ...baseCoin, change: { m5: 6, m15: 8, h1: 8, h6: 8, h24: 8 }, txns: { m5b: 14, m5s: 5, h1b: 20, h1s: 10, h24b: 20, h24s: 10 }, volume: { m5: 4000, h1: 5000, h6: 5000, h24: 5000 } } as any;
  const r = currentlyPumping(pump, t0);
  assert.equal(r.ok, true, r.reason);
  const flat = { ...baseCoin, change: { m5: 0, m15: 0, h1: 0, h6: 0, h24: 0 }, txns: { m5b: 0, m5s: 0, h1b: 0, h1s: 0, h24b: 0, h24s: 0 }, volume: { m5: 0, h1: 0, h6: 0, h24: 0 }, curve: undefined, flow: {} } as any;
  assert.equal(currentlyPumping(flat, t0).ok, false);
  const dump = { ...baseCoin, change: { m5: -6, m15: 2, h1: 2, h6: 2, h24: 2 }, txns: { m5b: 2, m5s: 12, h1b: 8, h1s: 20, h24b: 8, h24s: 20 } } as any;
  assert.equal(currentlyPumping(dump, t0).ok, false);
});
