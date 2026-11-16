// Higher-selectivity entries and structured exits (take-profit, partial, breakeven).
// Used by the engine and the tape backtester so research and production stay aligned.
import type { Candidate } from './types.ts';

export type TapeSnap = {
  t: number;
  px: number;
  liq: number;
  mc: number;
  m5: number; m15: number; h1: number;
  vol5: number; vol1h: number;
  b5: number; s5: number; b1: number; s1: number;
  tr: number;
  age: number;
};

export type StratParams = {
  minAgeMin: number;
  maxAgeHours: number;
  minLiq: number;
  maxLiq: number;
  minMcap: number;
  maxMcap: number;
  minTraders: number;
  minBuyRatio5: number;
  maxBuyRatio5: number;
  minTx5: number;
  minM15: number;
  minM5: number;
  maxM5: number;
  maxH1: number;
  minHistTicks: number;
  lookback: number;
  pullbackMinPct: number;
  pullbackMaxPct: number;
  holdFloorPct: number;
  minImpulsePct: number;
  maxTickVolPct: number;
  minLiqGrowthPct: number;
  takeProfitPct: number;
  partialPct: number;
  breakevenAtPct: number;
  hardStopPct: number;
  trailingStopPct: number;
  maxHoldMin: number;
  entrySlipPct: number;
  exitSlipPct: number;
};

export const STRAT_DEFAULTS: StratParams = {
  // "balanced" profile: first-snapshot entry (no watch/pullback wait),
  // modest extra filters vs the fastest profile. Walk-forward on a 66-minute
  // live tape did not reach >80% WR; this set had the better frequency/WR
  // trade-off among those tested (see backtest notes).
  minAgeMin: 3,
  maxAgeHours: 48,
  minLiq: 12_000,
  maxLiq: 2_000_000,
  minMcap: 8_000,
  maxMcap: 15_000_000,
  minTraders: 20,
  minBuyRatio5: 0.55,
  maxBuyRatio5: 0.93,
  minTx5: 8,
  minM15: 1,
  minM5: -2,
  maxM5: 18,
  maxH1: 70,
  minHistTicks: 1,
  lookback: 8,
  pullbackMinPct: 0,
  pullbackMaxPct: 100,
  holdFloorPct: 20,
  minImpulsePct: 0,
  maxTickVolPct: 12,
  minLiqGrowthPct: -25,
  takeProfitPct: 3,
  partialPct: 50,
  breakevenAtPct: 1.8,
  hardStopPct: 3,
  trailingStopPct: 5,
  maxHoldMin: 12,
  entrySlipPct: 0.6,
  exitSlipPct: 0.6,
};

export function toSnap(t: number, c: any): TapeSnap {
  // Accept either Candidate or compact tape row
  if (c.m || c.ch) {
    const ch = c.ch || [];
    const vo = c.vo || [];
    const tx = c.tx || [];
    return {
      t, px: c.px, liq: c.liq, mc: c.mc,
      m5: ch[0] || 0, m15: ch[1] || 0, h1: ch[2] || 0,
      vol5: vo[0] || 0, vol1h: vo[1] || 0,
      b5: tx[0] || 0, s5: tx[1] || 0, b1: tx[2] || 0, s1: tx[3] || 0,
      tr: c.tr || 0, age: c.age || 0,
    };
  }
  return {
    t, px: c.priceUsd, liq: c.liquidityUsd, mc: c.mcapUsd,
    m5: c.change.m5, m15: c.change.m15, h1: c.change.h1,
    vol5: c.volume.m5, vol1h: c.volume.h1,
    b5: c.txns.m5b, s5: c.txns.m5s, b1: c.txns.h1b, s1: c.txns.h1s,
    tr: c.traders1h || 0, age: c.createdAt,
  };
}

export function buyRatio(b: number, s: number) {
  const t = b + s;
  return t > 0 ? b / t : 0;
}

export function entryReason(hist: TapeSnap[], p: StratParams = STRAT_DEFAULTS, now?: number): { ok: boolean; reason: string } {
  if (hist.length < p.minHistTicks) return { ok: false, reason: 'watching' };
  const c = hist[hist.length - 1];
  const ts = now ?? c.t;
  const ageMin = c.age ? (ts - c.age) / 60_000 : Infinity;
  if (ageMin < p.minAgeMin) return { ok: false, reason: `age ${ageMin.toFixed(0)}m` };
  if (ageMin > p.maxAgeHours * 60) return { ok: false, reason: 'too old' };
  if (c.liq < p.minLiq || c.liq > p.maxLiq) return { ok: false, reason: 'liq' };
  if (c.mc > 0 && (c.mc < p.minMcap || c.mc > p.maxMcap)) return { ok: false, reason: 'mcap' };
  if (c.tr < p.minTraders) return { ok: false, reason: 'traders' };
  const r5 = buyRatio(c.b5, c.s5);
  if (r5 < p.minBuyRatio5) return { ok: false, reason: 'buy-ratio' };
  if (r5 > p.maxBuyRatio5) return { ok: false, reason: 'honeypot-ratio' };
  if (c.b5 + c.s5 < p.minTx5) return { ok: false, reason: 'thin prints' };
  if (c.m15 < p.minM15) return { ok: false, reason: 'no confirmed trend' };
  if (c.m5 < p.minM5 || c.m5 > p.maxM5) return { ok: false, reason: 'm5 not in band' };
  if (c.h1 > p.maxH1) return { ok: false, reason: 'already pumped' };
  if (c.mc > 0 && c.liq / c.mc < 0.025) return { ok: false, reason: 'thin liq/mcap' };

  // Path-dependent checks only apply when enough history exists AND the
  // params ask for them. Defaults (minImpulse/pullback = 0, minHistTicks = 1)
  // enter immediately on a qualifying snapshot.
  const window = hist.slice(-p.lookback);
  const prices = window.map((x) => x.px).filter((x) => x > 0);
  if (prices.length >= 2) {
    const peak = Math.max(...prices);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const impulse = first > 0 ? (peak / first - 1) * 100 : 0;
    const fromPeak = peak > 0 ? (1 - last / peak) * 100 : 0;
    if (p.minImpulsePct > 0 && impulse < p.minImpulsePct) return { ok: false, reason: 'no impulse' };
    if (p.pullbackMinPct > 0 && (fromPeak < p.pullbackMinPct || fromPeak > p.pullbackMaxPct))
      return { ok: false, reason: 'no pullback hold' };
    if (p.pullbackMinPct > 0) {
      const floor = peak * (1 - p.holdFloorPct / 100);
      if (prices.some((x) => x < floor)) return { ok: false, reason: 'broke hold floor' };
    }
    for (let i = 1; i < window.length; i++) {
      const a = window[i - 1].px, b = window[i].px;
      if (a > 0 && Math.abs(b / a - 1) * 100 > p.maxTickVolPct) return { ok: false, reason: 'high-vol candle' };
    }
    const old = window[0];
    if (old.liq > 0 && p.minLiqGrowthPct > -99) {
      const g = (c.liq / old.liq - 1) * 100;
      if (g < p.minLiqGrowthPct) return { ok: false, reason: 'liq fading' };
    }
    return { ok: true, reason: `r5 ${(r5 * 100).toFixed(0)}% · m5 ${c.m5.toFixed(1)}% · liq $${Math.round(c.liq)}` };
  }
  return { ok: true, reason: `fast entry · r5 ${(r5 * 100).toFixed(0)}% · m5 ${c.m5.toFixed(1)}%` };
}

/** Candidate-shaped entry for the live engine (builds hist from a short in-memory ring). */
export function liveEntryOk(c: Candidate, hist: TapeSnap[], p: StratParams = STRAT_DEFAULTS, now = Date.now()) {
  const snap = toSnap(now, c);
  const h = hist.length ? hist : [snap];
  if (h[h.length - 1].t !== snap.t) h.push(snap);
  return entryReason(h, p, now);
}

export type PosMark = {
  entryPrice: number;
  peakPrice: number;
  openedAt: number;
  partialTaken?: boolean;
  breakeven?: boolean;
};

export type ExitKind = 'take_profit' | 'partial_tp' | 'breakeven' | 'hard_stop' | 'trailing_stop' | 'time_stop' | 'momentum_fade';

export function exitReason(pos: PosMark, price: number, p: StratParams, now = Date.now(), fade = false, fadeWhy = ''): { exit: boolean; kind: ExitKind | null; reason: string; partial: boolean; peak: number } {
  const peak = Math.max(pos.peakPrice, price);
  if (!(price > 0)) return { exit: false, kind: null, reason: 'no price', partial: false, peak };
  const fromEntry = (price / pos.entryPrice - 1) * 100;
  const fromPeak = (price / peak - 1) * 100;
  const beArmed = pos.breakeven || (peak / pos.entryPrice - 1) * 100 >= p.breakevenAtPct;
  const hard = pos.entryPrice * (1 - p.hardStopPct / 100);
  const beLevel = pos.entryPrice * (1 + (p.exitSlipPct + 0.15) / 100); // arm above entry so a BE fill can still be flat after slippage
  const trail = peak * (1 - p.trailingStopPct / 100);
  const floor = beArmed ? Math.max(hard, beLevel, trail) : hard;

  if (!pos.partialTaken && p.partialPct > 0 && p.partialPct < 100 && fromEntry >= p.takeProfitPct)
    return { exit: true, kind: 'partial_tp', reason: `partial ${p.partialPct}% at ${fromEntry.toFixed(1)}%`, partial: true, peak };
  if ((pos.partialTaken || p.partialPct >= 100 || p.partialPct <= 0) && fromEntry >= p.takeProfitPct)
    return { exit: true, kind: 'take_profit', reason: `take profit ${fromEntry.toFixed(1)}%`, partial: false, peak };
  if (beArmed && price <= beLevel && price > hard)
    return { exit: true, kind: 'breakeven', reason: `breakeven (${fromEntry.toFixed(1)}%)`, partial: false, peak };
  if (beArmed && trail > floor - 1e-12 && price <= trail)
    return { exit: true, kind: 'trailing_stop', reason: `trailing ${fromEntry.toFixed(1)}% (−${Math.abs(fromPeak).toFixed(1)}% from top)`, partial: false, peak };
  if (price <= hard)
    return { exit: true, kind: 'hard_stop', reason: `-${p.hardStopPct}% stop (${fromEntry.toFixed(1)}%)`, partial: false, peak };
  if (fade) return { exit: true, kind: 'momentum_fade', reason: fadeWhy || 'momentum fade', partial: false, peak };
  if (p.maxHoldMin > 0 && now - pos.openedAt >= p.maxHoldMin * 60_000)
    return { exit: true, kind: 'time_stop', reason: `time stop ${p.maxHoldMin}m (${fromEntry.toFixed(1)}%)`, partial: false, peak };
  return { exit: false, kind: null, reason: '', partial: false, peak };
}

export function momentumFadeStrict(s: TapeSnap): { exit: boolean; reason: string } {
  const r5 = buyRatio(s.b5, s.s5);
  if (r5 < 0.42 && (s.b5 + s.s5) >= 8) return { exit: true, reason: 'momentum fade · buy-ratio drop' };
  if (s.m5 < -2.5) return { exit: true, reason: 'momentum fade · 5m reversal' };
  return { exit: false, reason: '' };
}
