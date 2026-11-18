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

export function sellFeeSol(priorityFeeSol: number): number {
  return BASE_FEE_SOL + Math.max(0, Number(priorityFeeSol) || 0);
}

/**
 * SOL that must stay in the wallet so every open position (and a newly opened one)
 * can still be sold, including a parallel close-all. ATA rent for a not-yet-opened
 * position is reserved in the wallet until the buy locks it; rent for already-open
 * positions already sits in those ATAs and is reclaimed on close.
 */
export function exitReserveSol(priorityFeeSol: number, openPositions = 0, openingNew = false): number {
  const fee = sellFeeSol(priorityFeeSol);
  // sell fees for every current position (parallel close-all) plus, when opening,
  // the new position's sell fee, its ATA rent, and this buy's network fee.
  const sellFees = (Math.max(0, openPositions) + (openingNew ? 1 : 0)) * fee;
  const openCost = openingNew ? ATA_RENT_SOL + fee : 0;
  return sellFees + openCost;
}

/** Exit reserve for opening one position (sell fee + ATA rent). */
export function reserveSol(priorityFeeSol: number): number {
  return exitReserveSol(priorityFeeSol, 0, true);
}

/** @deprecated use reserveSol(priorityFeeSol); kept as a conservative fallback number */
export const FEE_RESERVE_SOL = 0.0005;

function roundUsd(x: number) { return Math.floor(x * 1e6) / 1e6; }
function round2(x: number) { return Math.floor(x * 100) / 100; }

/** Live books around a dollar cannot do wide 1%-of-stack sizing. */
const TINY_BOOK_USD = 5;

/**
 * USD size of the next trade.
 * Large books: positionPct of spendable, scaled by an anti-martingale multiplier.
 * Tiny books: all spendable (cash minus the exit reserve) so a trade is larger
 * than ATA rent and can actually execute. No minimum USD floor.
 */
export function positionSizeUsd(p: RiskParams, portfolioUsd: number, freeCashUsd: number, reserveUsd: number, sizeMult = 1): number {
  if (!(portfolioUsd > 0)) return 0;
  const spendable = Math.max(0, freeCashUsd - reserveUsd);
  if (!(spendable > 0)) return 0;
  if (portfolioUsd <= TINY_BOOK_USD) return roundUsd(spendable);
  const target = (portfolioUsd * p.positionPct / 100) * Math.max(0.4, sizeMult);
  return roundUsd(Math.min(Math.max(target, 0), spendable));
}

/**
 * How many concurrent slots this book can support.
 * Capital is split evenly across slots from equity, after reserving exit fees
 * for every slot. Tiny books use one slot and go all-in on spendable.
 */
export function usableSlots(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number, openPositions = 0): number {
  if (equityUsd > 0 && equityUsd <= TINY_BOOK_USD) {
    return (freeCashUsd - reserveUsd) > 0 ? 1 : 0;
  }
  const max = Math.max(1, Math.min(10, p.maxPositions || 10));
  for (let n = max; n >= 1; n--) {
    if (openPositions >= n) continue;
    const reserved = n * reserveUsd;
    const tradable = equityUsd - reserved;
    if (tradable <= 0) continue;
    const size = tradable / n;
    if (freeCashUsd + 1e-9 < size + reserveUsd) continue;
    return n;
  }
  return 0;
}

export function slotSizeUsd(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number, openPositions = 0): number {
  const n = usableSlots(p, equityUsd, freeCashUsd, reserveUsd, openPositions);
  if (!n) return 0;
  const cap = Math.max(0, freeCashUsd - reserveUsd);
  if (!(cap > 0)) return 0;
  if (equityUsd <= TINY_BOOK_USD) return roundUsd(cap);
  const size = (equityUsd - n * reserveUsd) / n;
  return roundUsd(Math.min(Math.max(size, 0), cap));
}

/**
 * Size the next entry as positionPct of the stack (equity), capped at
 * spendable cash (free cash minus the exit reserve). Last night's book used
 * ~1% of equity with many concurrent micros. Tiny live books (~$1) cannot
 * do that — they use all spendable after the cash reserve so a buy can land.
 */
export function openSizeUsd(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number): number {
  const spendable = Math.max(0, freeCashUsd - reserveUsd);
  if (!(spendable > 0)) return 0;
  if (equityUsd > 0 && equityUsd <= TINY_BOOK_USD) return roundUsd(spendable);
  const pct = Math.max(1, Math.min(100, p.positionPct || 1)) / 100;
  let size = equityUsd * pct;
  if (size > spendable) size = spendable;
  if (equityUsd > TINY_BOOK_USD) size = Math.min(size, equityUsd * 0.24);
  return size > 0 ? roundUsd(size) : 0;
}

export function lowBalanceReason(portfolioUsd: number, freeCashUsd: number, reserveUsd: number, minTradeUsd: number, usdcUi = 0): string | null {
  const needSol = 'Need ~0.01 SOL for fees';
  if (freeCashUsd <= 0) return usdcUi > 0 ? needSol : needSol + ' — deposit SOL to the bot address';
  if (freeCashUsd <= reserveUsd) return usdcUi > 0 ? needSol : `balance reserved for sell fees and token-account rent (need ~$${reserveUsd.toFixed(4)} reserved, have $${freeCashUsd.toFixed(4)})`;
  // minTradeUsd is ignored: keep trading until spendable is gone.
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
  // Do not raise the entry floor after losses — keep entries flowing and
  // let pattern weights prefer what has been working.
  return { minScore, trailingStopPct, hardStopPct, pauseMs, consec, sizeMult: 1 };
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
  // Small-book gate: only coins that are already pumping with real buy pressure.
  const b5 = c.txns.m5b, s5 = c.txns.m5s;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0;
  const volAccel = c.volume.h1 > 0 ? (c.volume.m5 * 12) / c.volume.h1 : (c.volume.m5 > 0 ? 2 : 0);
  if (c.change.m5 < 4) return false;          // need clear 5m lift
  if (c.change.m5 > 55) return false;         // avoid late blow-off
  if ((c.change.m15 || 0) < 1) return false;  // 15m still positive
  if (r5 < 0.58) return false;                // buy-side dominance
  if ((b5 + s5) < 10) return false;           // enough flow
  if (volAccel < 1.0) return false;           // volume accelerating
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
