// RISK agent - position sizing, exits, anti-martingale, adaptive filters.
import type { Position, Candidate } from './types.ts';

export type RiskParams = {
  positionPct: number;
  minTradeUsd: number;
  maxPositions: number;
  hardStopPct: number;
  trailingStopPct: number;
  maxHoldMin: number;
  dailyLossLimitPct: number;
};

export const BASE_FEE_SOL = 0.000005;
export const ATA_RENT_SOL = 0.00203928; // refundable when the token account is closed after sell

/** SOL to keep back: ATA rent (while a position is open) + buy and sell network+priority fees. */
export function reserveSol(priorityFeeSol: number): number {
  return ATA_RENT_SOL + 2 * (BASE_FEE_SOL + Math.max(0, Number(priorityFeeSol) || 0));
}

/** @deprecated use reserveSol(priorityFeeSol); kept as a conservative fallback number */
export const FEE_RESERVE_SOL = 0.0005;

function round2(x: number) { return Math.floor(x * 100) / 100; }

/**
 * USD size of the next trade.
 * Default is positionPct of the portfolio, scaled by an anti-martingale multiplier.
 * If that would be below minTradeUsd, use more of the free cash (up to all of it
 * minus the fee/rent reserve) so $2–$5 wallets can still place a viable trade.
 */
export function positionSizeUsd(p: RiskParams, portfolioUsd: number, freeCashUsd: number, reserveUsd: number, sizeMult = 1): number {
  if (!(portfolioUsd > 0)) return 0;
  const spendable = Math.max(0, freeCashUsd - reserveUsd);
  if (spendable < p.minTradeUsd) return 0;
  const target = (portfolioUsd * p.positionPct / 100) * Math.max(0.4, sizeMult);
  if (target >= p.minTradeUsd) {
    const size = Math.min(target, spendable);
    return size >= p.minTradeUsd ? round2(size) : 0;
  }
  return round2(spendable);
}

/**
 * How many concurrent slots this book can support.
 * Capital is split evenly across slots from equity, after reserving rent/fees
 * for every slot. Tiny books use fewer slots so each trade stays >= minTrade.
 */
export function usableSlots(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number, openPositions = 0): number {
  const max = Math.max(1, Math.min(10, p.maxPositions || 10));
  for (let n = max; n >= 1; n--) {
    if (openPositions >= n) continue;
    const reserved = n * reserveUsd;
    const tradable = equityUsd - reserved;
    if (tradable < n * p.minTradeUsd) continue;
    const size = tradable / n;
    if (freeCashUsd + 1e-9 < size + reserveUsd) continue;
    return n;
  }
  return 0;
}

export function slotSizeUsd(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number, openPositions = 0): number {
  const n = usableSlots(p, equityUsd, freeCashUsd, reserveUsd, openPositions);
  if (!n) return 0;
  const size = (equityUsd - n * reserveUsd) / n;
  const cap = freeCashUsd - reserveUsd;
  if (size < p.minTradeUsd || cap < p.minTradeUsd) return 0;
  return round2(Math.min(size, cap));
}

/**
 * Size the next entry as a % of spendable cash (free cash minus rent/fee reserve),
 * never below minTrade and never more than spendable, so cash cannot go negative.
 * No concurrent-position cap — keep opening until spendable is below the minimum.
 */
export function openSizeUsd(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number): number {
  const spendable = Math.max(0, freeCashUsd - reserveUsd);
  if (spendable < p.minTradeUsd) return 0;
  const pct = Math.max(1, Math.min(100, p.positionPct || 8)) / 100;
  let size = spendable * pct;
  if (size < p.minTradeUsd) size = p.minTradeUsd;
  if (size > spendable) return 0;
  if (equityUsd > 0) size = Math.min(size, equityUsd * 0.24);
  return round2(size);
}

export function lowBalanceReason(portfolioUsd: number, freeCashUsd: number, reserveUsd: number, minTradeUsd: number): string | null {
  if (freeCashUsd <= 0) return 'wallet is empty — deposit SOL to the bot address';
  if (freeCashUsd <= reserveUsd) return `balance too low to cover fees and token-account rent (need ~$${reserveUsd.toFixed(2)} reserved, have $${freeCashUsd.toFixed(2)})`;
  if (freeCashUsd - reserveUsd < minTradeUsd) return `balance too low for a viable trade (spendable $${Math.max(0, freeCashUsd - reserveUsd).toFixed(2)}, minimum $${minTradeUsd.toFixed(2)})`;
  return null;
}

/** Anti-martingale: grow size after wins, shrink after losses. Never add size to recover a loss. */
export function sizeMultiplier(recentPnlsChrono: number[]): number {
  let m = 1;
  for (const p of recentPnlsChrono) {
    if (p > 0) m = Math.min(1.6, m * 1.2);
    else if (p < 0) m = Math.max(0.5, m * 0.7);
  }
  return Math.round(m * 100) / 100;
}

export function consecutiveLosses(recentPnlsChrono: number[]): number {
  let n = 0;
  for (let i = recentPnlsChrono.length - 1; i >= 0; i--) {
    if (recentPnlsChrono[i] < 0) n++;
    else break;
  }
  return n;
}

/** Self-correction: tighten filters and pause after a losing streak. Does not average down. */
export function adaptFilters(base: { minScore: number; trailingStopPct: number; hardStopPct: number }, recentPnlsChrono: number[]) {
  const last = recentPnlsChrono.slice(-8);
  const consec = consecutiveLosses(last);
  const losses = last.filter((x) => x < 0).length;
  let minScore = base.minScore;
  let trailingStopPct = base.trailingStopPct;
  let hardStopPct = base.hardStopPct;
  let pauseMs = 0;
  if (consec >= 2) {
    minScore += 8;
    trailingStopPct = Math.max(3, trailingStopPct - 2);
    pauseMs = 0;
  }
  if (consec >= 3 || (last.length >= 6 && losses >= 5)) {
    minScore += 5;
    hardStopPct = Math.max(3, hardStopPct - 1);
    pauseMs = 0;
  }
  return { minScore, trailingStopPct, hardStopPct, pauseMs, consec, sizeMult: sizeMultiplier(recentPnlsChrono) };
}

export type GateInput = {
  openPositions: number;
  dayStartEquityUsd: number;
  equityUsd: number;
  alreadyHolding: boolean;
  inCooldown: boolean;
  pausedUntil?: number;
  now?: number;
};

export function entryBlocked(p: RiskParams, g: GateInput): string | null {
  if (g.alreadyHolding) return 'already holding';
  if (g.inCooldown) return 'cooldown after recent exit';
  if (g.pausedUntil && (g.now || Date.now()) < g.pausedUntil) return 'cooldown after consecutive losses';
  // maxPositions is not enforced — entries are limited only by free cash.
  if (g.dayStartEquityUsd > 0) {
    const ddPct = ((g.dayStartEquityUsd - g.equityUsd) / g.dayStartEquityUsd) * 100;
    if (ddPct >= p.dailyLossLimitPct) return `daily loss limit hit (-${ddPct.toFixed(1)}%)`;
  }
  return null;
}

export type ExitDecision = { exit: boolean; kind: 'hard_stop' | 'trailing_stop' | 'time_stop' | 'momentum_fade' | null; reason: string };

export function evaluateExit(p: RiskParams, pos: Pick<Position, 'entryPrice' | 'peakPrice' | 'openedAt'>, price: number, now = Date.now()): ExitDecision & { peak: number } {
  const peak = Math.max(pos.peakPrice, price);
  if (!(price > 0)) return { exit: false, kind: null, reason: 'no price', peak };
  const fromEntry = (price / pos.entryPrice - 1) * 100;
  const fromPeak = (price / peak - 1) * 100;
  const hardStop = pos.entryPrice * (1 - p.hardStopPct / 100);
  const trail = peak * (1 - p.trailingStopPct / 100);
  if (trail > hardStop && price <= trail)
    return { exit: true, kind: 'trailing_stop', reason: `trailing stop ${fmtPct(fromEntry)} (−${Math.abs(fromPeak).toFixed(1)}% from top)`, peak };
  if (price <= hardStop)
    return { exit: true, kind: 'hard_stop', reason: `-${p.hardStopPct}% stop (${fmtPct(fromEntry)})`, peak };
  if (p.maxHoldMin > 0 && now - pos.openedAt >= p.maxHoldMin * 60_000)
    return { exit: true, kind: 'time_stop', reason: `time stop ${p.maxHoldMin}m (${fmtPct(fromEntry)})`, peak };
  return { exit: false, kind: null, reason: '', peak };
}

export function momentumEntryOk(c: Candidate): boolean {
  const b5 = c.txns.m5b, s5 = c.txns.m5s;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0;
  const volAccel = c.volume.h1 > 0 ? (c.volume.m5 * 12) / c.volume.h1 : (c.volume.m5 > 0 ? 2 : 0);
  if (c.change.m5 < 2) return false;
  if (c.change.m5 > 80) return false; // blow-off
  if (r5 < 0.55) return false;
  if (volAccel < 0.9) return false;
  return true;
}

export function momentumFade(c: Pick<Candidate, 'txns' | 'change' | 'volume' | 'liquidityUsd'>, peakPrice: number, lastPrice: number): { exit: boolean; reason: string } {
  const b5 = c.txns.m5b, s5 = c.txns.m5s;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0.5;
  if (r5 < 0.42 && (b5 + s5) >= 8) return { exit: true, reason: 'momentum fade · buy-ratio drop' };
  if (c.change.m5 < -3) return { exit: true, reason: 'momentum fade · 5m reversal' };
  if (peakPrice > 0 && lastPrice < peakPrice && c.change.m5 <= 0 && r5 < 0.48)
    return { exit: true, reason: 'momentum fade · lower high' };
  if (c.volume.h1 > 0 && c.volume.m5 * 12 < c.volume.h1 * 0.35 && r5 < 0.5)
    return { exit: true, reason: 'momentum fade · volume drop' };
  return { exit: false, reason: '' };
}

export function activeStop(p: RiskParams, pos: Pick<Position, 'entryPrice' | 'peakPrice'>): { level: number; kind: 'hard' | 'trailing' } {
  const hard = pos.entryPrice * (1 - p.hardStopPct / 100);
  const trail = pos.peakPrice * (1 - p.trailingStopPct / 100);
  return trail > hard ? { level: trail, kind: 'trailing' } : { level: hard, kind: 'hard' };
}

export function fmtPct(x: number) { return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }
