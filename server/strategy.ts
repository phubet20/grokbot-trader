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
  partialPct: 0,           // full exit preferred for small books
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

export function matchEntryPatterns(c: Candidate, hist: TapeSnap[], p: StratParams, now: number): { ok: boolean; reason: string } {
  const s = hist[hist.length - 1] || toSnap(now, c);
  const r5 = buyRatio(s.b5, s.s5);
  const ageMin = s.age ? (now - s.age) / 60_000 : (now - (c.createdAt || now)) / 60_000;
  const flow = c.flow;
  const progress = c.curve?.progress ?? flow?.progress ?? 0;
  const unique = flow?.uniqueBuyers || s.tr || 0;
  const vel = flow?.progressVel ?? 0;
  if (r5 > p.maxBuyRatio5 && (s.b5 + s.s5) >= 8) return { ok: false, reason: 'honeypot-ratio' };
  if (flow?.devSold) return { ok: false, reason: 'dev selling' };
  if (flow?.bundled) return { ok: false, reason: 'bundled sniper' };
  if ((flow?.devHoldPct || 0) > 25) return { ok: false, reason: 'dev hold cap' };
  if (s.m5 > 80 && unique < 10) return { ok: false, reason: 'blow-off' };

  const onCurve = !!c.curve && !c.curve.graduated;
  const risingBuyers = unique >= 3 || (hist.length >= 2 && unique > (hist[0].tr || 0));

  if (ageMin <= 8 && (onCurve || c.source === 'pumpportal' || c.dex === 'pump') && (s.b5 + s.s5 >= 1 || (flow?.netBuySol || 0) > 0) && r5 >= 0.52 && risingBuyers)
    return { ok: true, reason: `fresh-launch burst · ${ageMin.toFixed(1)}m · r5 ${(r5 * 100).toFixed(0)}%` };
  if (onCurve && progress >= 0.12 && progress < 0.72 && vel > 0.02 && r5 >= 0.52 && unique >= 4)
    return { ok: true, reason: `curve breakout · ${(progress * 100).toFixed(0)}% · vel ${vel.toFixed(2)}` };
  if (onCurve && progress >= 0.72 && r5 >= 0.52 && (flow?.largeSells || 0) === 0)
    return { ok: true, reason: `near-graduation · ${(progress * 100).toFixed(0)}%` };
  if (c.curve?.graduated && ageMin <= 45 && r5 >= 0.55 && (s.b5 + s.s5) >= 6 && s.liq >= Math.min(p.minLiq, 4000))
    return { ok: true, reason: `post-graduation breakout · r5 ${(r5 * 100).toFixed(0)}%` };
  const whale = flow?.whaleBuyUsd || 0;
  if (whale >= 30 && hist.length >= 2) {
    const peak = Math.max(...hist.map((x) => x.px).filter((x) => x > 0));
    const dip = peak > 0 ? (1 - s.px / peak) * 100 : 0;
    if (dip >= 2 && dip <= 18 && r5 >= 0.55)
      return { ok: true, reason: `dip-buy after whale · dip ${dip.toFixed(1)}%` };
  }
  return { ok: false, reason: 'no pattern' };
}

export function liveEntryOk(c: Candidate, hist: TapeSnap[], p: StratParams = STRAT_DEFAULTS, now = Date.now()) {
  const snap = toSnap(now, c);
  const h = hist.length ? hist : [snap];
  if (h[h.length - 1].t !== snap.t) h.push(snap);
  const pat = matchEntryPatterns(c, h, p, now);
  if (pat.ok) return pat;
  return entryReason(h, p, now);
}

export function sellPressure(c: Candidate | undefined, s: TapeSnap): { exit: boolean; reason: string } {
  const r5 = buyRatio(s.b5, s.s5);
  const flow = c?.flow;
  if (flow?.devSold) return { exit: true, reason: 'sell pressure · dev/top-holder selling' };
  if ((flow?.largeSells || 0) >= 2 && (flow?.largeSells || 0) > (flow?.largeBuys || 0))
    return { exit: true, reason: 'sell pressure · large sells' };
  const net = (s.b5 - s.s5);
  if ((s.b5 + s.s5) >= 6 && net < 0 && r5 < 0.48) return { exit: true, reason: 'sell pressure · net sell flow' };
  return momentumFadeStrict(s);
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
  const beLevel = pos.entryPrice * (1 + (p.exitSlipPct + 0.15) / 100);
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

export function candlesFromTicks(hist: TapeSnap[], bucketMs: number) {
  if (!hist.length) return [] as { t: number; o: number; h: number; l: number; c: number; buy: number; sell: number }[];
  const out: { t: number; o: number; h: number; l: number; c: number; buy: number; sell: number }[] = [];
  const start = Math.floor(hist[0].t / bucketMs) * bucketMs;
  let cur = { t: start, o: hist[0].px, h: hist[0].px, l: hist[0].px, c: hist[0].px, buy: 0, sell: 0 };
  for (const s of hist) {
    const tb = Math.floor(s.t / bucketMs) * bucketMs;
    if (tb !== cur.t) {
      out.push(cur);
      cur = { t: tb, o: s.px, h: s.px, l: s.px, c: s.px, buy: 0, sell: 0 };
    }
    cur.h = Math.max(cur.h, s.px);
    cur.l = Math.min(cur.l || s.px, s.px);
    cur.c = s.px;
    cur.buy = s.b5;
    cur.sell = s.s5;
  }
  out.push(cur);
  return out;
}

export function buyCandlePattern(hist: TapeSnap[]): { ok: boolean; reason: string } {
  for (const ms of [1000, 15_000, 60_000]) {
    const cs = candlesFromTicks(hist, ms);
    if (cs.length < 2) continue;
    const last = cs[cs.length - 1], prev = cs[cs.length - 2];
    const green = last.c > last.o && last.buy >= last.sell;
    const body = last.c - last.o;
    const prevBody = Math.max(0, prev.c - prev.o);
    const big = body > 0 && body >= prevBody;
    const lows = cs.slice(-4).map((x) => x.l);
    const higherLows = lows.length >= 3 && lows[lows.length - 1] >= lows[lows.length - 2] && lows[lows.length - 2] >= lows[0] * 0.997;
    if (green && (big || higherLows))
      return { ok: true, reason: `buy candle ${ms / 1000}s` + (higherLows ? ' · higher lows' : '') };
  }
  return { ok: false, reason: '' };
}

export function dipReclaim(hist: TapeSnap[]): { ok: boolean; reason: string; dip?: number } {
  if (hist.length < 3) return { ok: false, reason: '' };
  const last = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  if (!(last.px > 0)) return { ok: false, reason: '' };
  if (last.px < prev.px) return { ok: false, reason: 'still falling' };
  const r5 = buyRatio(last.b5, last.s5);
  const peak = Math.max(...hist.map((h) => h.px));
  const peakI = hist.reduce((bi, h, i) => (h.px >= hist[bi].px ? i : bi), 0);
  const after = hist.slice(peakI);
  const trough = Math.min(...after.map((h) => h.px));
  const dip = peak > 0 ? (1 - trough / peak) * 100 : 0;
  const mid = (trough + peak) / 2;
  const reclaimed = last.px >= trough * 1.012 && last.px >= mid * 0.97;
  if (dip >= 3 && dip <= 28 && reclaimed && r5 >= 0.52)
    return { ok: true, reason: `dip-reclaim ${dip.toFixed(1)}%`, dip };
  return { ok: false, reason: '' };
}

export function bigMoneyInflow(c: Candidate, s: TapeSnap): { ok: boolean; reason: string } {
  const r5 = buyRatio(s.b5, s.s5);
  const net = s.b5 - s.s5;
  const whale = c.flow?.whaleBuyUsd || 0;
  const large = c.flow?.largeBuys || 0;
  if ((whale >= 30 || large >= 1) && r5 >= 0.55 && net > 0) return { ok: true, reason: 'big-money inflow' };
  if (s.vol5 > 0 && r5 >= 0.65 && s.b5 >= 6 && net > 0) return { ok: true, reason: 'net buy volume spike' };
  return { ok: false, reason: '' };
}

export function isEstablished(c: Candidate, now = Date.now()): boolean {
  if (c.universe === 'trending') return true;
  const ageMin = (now - (c.createdAt || now)) / 60_000;
  if (c.curve && !c.curve.graduated && ageMin < 30) return false;
  return ageMin >= 30;
}

export function momentumConfirm(c: Candidate, hist: TapeSnap[] = [], now = Date.now()): { ok: boolean; reason: string } {
  const s = hist[hist.length - 1] || toSnap(now, c);
  const r5 = buyRatio(s.b5, s.s5);
  const tot = s.b5 + s.s5;
  const dumping = (s.m5 || 0) <= -5 || (c.change?.m5 || 0) <= -5 || !!c.flow?.devSold;
  if (dumping) return { ok: false, reason: 'dumping' };
  const net = (s.b5 - s.s5) > 0 || (c.flow?.netBuySol || 0) > 0;
  const vol = (s.vol5 || 0) > 0 || (c.volume?.m5 || 0) > 0;
  const buyPress = net && (tot >= 3 ? r5 >= 0.52 : (r5 >= 0.55 || (c.flow?.netBuySol || 0) > 0 || tot >= 1));
  const prevVol = hist.length >= 2 ? (hist[hist.length - 2].vol5 || 0) : 0;
  const volAccel = s.vol5 > 0 && prevVol > 0 && s.vol5 >= prevVol * 1.15;
  const pxUp = s.m5 >= 0.8 || (c.change?.m5 || 0) >= 0.8;
  const freshVol = vol && (pxUp || (c.flow?.netBuySol || 0) > 0);
  const thrust = s.m5 >= 1.2 || volAccel || freshVol || (vol && pxUp);
  if (buyPress && thrust) return { ok: true, reason: 'buy pressure + volume thrust' };
  const freshCurve = !!c.curve && !c.curve.graduated;
  if (freshCurve && tot < 4 && net && vol) return { ok: true, reason: 'fresh curve buy flow' };
  return { ok: false, reason: !buyPress ? 'no buy pressure' : 'no thrust' };
}

export function alreadyPumpedHard(c: Candidate, hist: TapeSnap[] = [], now = Date.now()): boolean {
  const s = hist[hist.length - 1] || toSnap(now, c);
  if ((s.m5 || 0) >= 25 || (s.m15 || 0) >= 40 || (s.h1 || 0) >= 60) return true;
  if ((s.m5 || 0) >= 18 && (s.m15 || 0) >= 30) return true;
  const prices = hist.map((h) => h.px).filter((x) => x > 0);
  if (prices.length >= 2) {
    const first = prices[0], peak = Math.max(...prices), last = prices[prices.length - 1];
    const run = first > 0 ? (peak / first - 1) * 100 : 0;
    const fromPeak = peak > 0 ? (1 - last / peak) * 100 : 0;
    if (run >= 80) return true;
    if (run >= 40 && fromPeak < 3) return true;
  }
  return false;
}

export function currentlyPumping(c: Candidate, _now = Date.now()): { ok: boolean; reason: string } {
  const m5 = c.change?.m5 || 0;
  const buys = c.txns?.m5b || 0;
  const sells = c.txns?.m5s || 0;
  const r5 = buys + sells > 0 ? buys / (buys + sells) : 0;
  const vol5 = c.volume?.m5 || 0;
  const net = (buys - sells) > 0 || (c.flow?.netBuySol || 0) > 0;
  const active = vol5 > 0 || (buys + sells) >= 2 || !!c.curve;
  if (!active) return { ok: false, reason: 'no flow' };
  if (m5 <= -3) return { ok: false, reason: 'dumping' };
  if (m5 >= 0.3 && (net || r5 >= 0.5)) return { ok: true, reason: `pumping +${m5.toFixed(1)}% 5m` };
  if (m5 >= 0 && r5 >= 0.55 && vol5 > 0) return { ok: true, reason: 'steady buy flow' };
  return { ok: false, reason: 'no pump' };
}
