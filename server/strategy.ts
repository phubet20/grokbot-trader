// Higher-selectivity entries and structured exits (take-profit, partial, breakeven).
// Used by the engine and the tape backtester so research and production stay aligned.
// Risk numbers here must stay consistent with server/config.ts DEFAULTS.
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

/**
 * Aligned with config.ts DEFAULTS (Nov 2026 stability cleanup).
 * hardStop 7%, trailing 10%, takeProfit 2.5%, maxHold 30m.
 */
export const STRAT_DEFAULTS: StratParams = {
  minAgeMin: 1,
  maxAgeHours: 48,
  minLiq: 1_200,
  maxLiq: 50_000_000,
  minMcap: 2_000,
  maxMcap: 50_000_000,
  minTraders: 20,
  minBuyRatio5: 0.52,
  maxBuyRatio5: 0.93,
  minTx5: 4,
  minM15: 0,
  minM5: -3,
  maxM5: 25,
  maxH1: 80,
  minHistTicks: 1,
  lookback: 8,
  pullbackMinPct: 0,
  pullbackMaxPct: 100,
  holdFloorPct: 20,
  minImpulsePct: 0,
  maxTickVolPct: 15,
  minLiqGrowthPct: -30,
  takeProfitPct: 2.5,
  partialPct: 0,
  breakevenAtPct: 1.5,
  hardStopPct: 7,
  trailingStopPct: 10,
  maxHoldMin: 30,
  entrySlipPct: 0.6,
  exitSlipPct: 0.6,
};

export function toSnap(t: number, c: any): TapeSnap {
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
