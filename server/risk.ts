// Position sizing, reserves, entry gates, and exit helpers.
import type { Config } from './config.ts';
import type { Candidate, Position } from './types.ts';

export const BASE_FEE_SOL = 0.000005;
export const ATA_RENT_SOL = 0.00203928;

export type RiskParams = Pick<
  Config,
  'positionPct' | 'minTradeUsd' | 'maxPositions' | 'takeProfitPct' | 'hardStopPct' | 'trailingStopPct' | 'maxHoldMin' | 'redExitSec' | 'dailyLossLimitPct' | 'cooldownMin' | 'minScore' | 'priorityFeeSol'
>;

export function sellFeeSol(priorityFeeSol: number): number {
  return BASE_FEE_SOL + priorityFeeSol;
}

export function exitReserveSol(priorityFeeSol: number, openPositions = 0, openingNew = false): number {
  const fee = sellFeeSol(priorityFeeSol);
  const exits = Math.max(1, openPositions + (openingNew ? 1 : 0));
  return fee * exits + (openingNew ? ATA_RENT_SOL : 0);
}

export function reserveSol(priorityFeeSol: number): number {
  return sellFeeSol(priorityFeeSol) + ATA_RENT_SOL;
}

/**
 * USD size for one new position.
 * Live-aware: skip dust tickets where fixed fees dominate; prefer fuller size.
 * Tiny books (<~$8 free after reserve) still go all-in so capital is not stranded.
 */
export function positionSizeUsd(p: RiskParams, portfolioUsd: number, freeCashUsd: number, reserveUsd: number, sizeMult = 1): number {
  const free = Math.max(0, freeCashUsd - reserveUsd);
  if (free <= 0) return 0;
  if (free <= 8) return free;
  const pct = Math.min(25, Math.max(1, p.positionPct)) / 100;
  const raw = portfolioUsd * pct * (sizeMult > 0 ? sizeMult : 1);
  // Floor ~$2.5 so round-trip fees are not the whole trade on mid-size books.
  const sized = Math.min(free, Math.max(0, raw));
  if (sized > 0 && sized < 2.5 && free >= 2.5) return Math.min(free, 2.5);
  return sized;
}

export function usableSlots(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number, openPositions = 0): number {
  if (p.maxPositions > 0) return Math.max(0, p.maxPositions - openPositions);
  const free = Math.max(0, freeCashUsd - reserveUsd);
  if (free <= 0) return 0;
  if (free <= 8) return openPositions > 0 ? 0 : 1;
  const one = positionSizeUsd(p, equityUsd, freeCashUsd, reserveUsd);
  if (one <= 0) return 0;
  return Math.max(0, Math.floor(free / one));
}

export function slotSizeUsd(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number, openPositions = 0): number {
  return positionSizeUsd(p, equityUsd, freeCashUsd, reserveUsd);
}

export function openSizeUsd(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number): number {
  return positionSizeUsd(p, equityUsd, freeCashUsd, reserveUsd);
}

export function lowBalanceReason(portfolioUsd: number, freeCashUsd: number, reserveUsd: number, minTradeUsd: number, usdcUi = 0): string | null {
  if (freeCashUsd + usdcUi * 0.99 >= reserveUsd + Math.max(0.5, minTradeUsd)) return null;
  return `balance reserved for sell fees and token-account rent (need ~$${reserveUsd.toFixed(4)} reserved, have $${freeCashUsd.toFixed(4)})`;
}

export function sizeMultiplier(recentPnlsChrono: number[]): number {
  const last = recentPnlsChrono.slice(-5);
  if (!last.length) return 1;
  const wins = last.filter((x) => x > 0).length;
  const losses = last.filter((x) => x < 0).length;
  if (wins >= 3 && losses === 0) return 1.12;
  if (losses >= 3) return 0.65;
  if (losses >= 2) return 0.8;
  return 1;
}

export function consecutiveLosses(recentPnlsChrono: number[]): number {
  let n = 0;
  for (let i = recentPnlsChrono.length - 1; i >= 0; i--) {
    if (recentPnlsChrono[i] < 0) n++;
    else break;
  }
  return n;
}

export function adaptFilters(base: { minScore: number; trailingStopPct: number; hardStopPct: number }, recentPnlsChrono: number[]) {
  const cl = consecutiveLosses(recentPnlsChrono);
  const minScore = Math.min(72, base.minScore + (cl >= 3 ? 5 : cl >= 2 ? 3 : 0));
  return {
    minScore,
    trailingStopPct: base.trailingStopPct,
    hardStopPct: base.hardStopPct,
    pauseMs: cl >= 4 ? 4 * 60_000 : cl >= 3 ? 120_000 : 0,
  };
}

export type GateInput = {
  equityUsd: number;
  freeCashUsd: number;
  reserveUsd: number;
  openPositions: number;
  dayPnlPct: number;
  score: number;
  cooldownUntil?: number;
  now?: number;
};

export function entryBlocked(p: RiskParams, g: GateInput): string | null {
  const now = g.now ?? Date.now();
  if (g.cooldownUntil && now < g.cooldownUntil) return 'cooldown';
  if (g.dayPnlPct <= -Math.abs(p.dailyLossLimitPct)) return 'daily loss limit';
  if (g.score < p.minScore) return `score ${g.score} < ${p.minScore}`;
  if (p.maxPositions > 0 && g.openPositions >= p.maxPositions) return 'max positions';
  const size = positionSizeUsd(p, g.equityUsd, g.freeCashUsd, g.reserveUsd);
  if (size <= 0) return 'no free cash after reserve';
  return null;
}

export type ExitDecision = { exit: boolean; kind?: string; reason?: string };

export function evaluateExit(p: RiskParams, pos: Pick<Position, 'entryPrice' | 'peakPrice' | 'openedAt'>, price: number, now = Date.now()): ExitDecision & { peak: number } {
  const peak = Math.max(pos.peakPrice || pos.entryPrice, price);
  const fromEntry = pos.entryPrice > 0 ? (price / pos.entryPrice - 1) * 100 : 0;
  const fromPeak = peak > 0 ? (price / peak - 1) * 100 : 0;
  if (fromEntry <= -p.hardStopPct) return { exit: true, kind: 'hard_stop', reason: `hard stop ${fromEntry.toFixed(1)}%`, peak };
  if (fromPeak <= -p.trailingStopPct && fromEntry > 0) return { exit: true, kind: 'trailing_stop', reason: `trail ${fromPeak.toFixed(1)}% from peak`, peak };
  if (p.maxHoldMin > 0 && (now - pos.openedAt) >= p.maxHoldMin * 60_000) return { exit: true, kind: 'time_stop', reason: `max hold ${p.maxHoldMin}m`, peak };
  return { exit: false, peak };
}

/** Live gate: only coins already pumping with real buy pressure (stricter than paper demos). */
export function momentumEntryOk(c: Candidate): boolean {
  const b5 = c.txns.m5b, s5 = c.txns.m5s;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0;
  const volAccel = c.volume.h1 > 0 ? (c.volume.m5 * 12) / c.volume.h1 : (c.volume.m5 > 0 ? 2 : 0);
  if (c.change.m5 < 5) return false;           // need clear 5m lift after fees
  if (c.change.m5 > 45) return false;          // avoid late blow-off
  if ((c.change.m15 || 0) < 2) return false;   // 15m still positive
  if (r5 < 0.60) return false;                 // buy-side dominance
  if ((b5 + s5) < 12) return false;            // enough flow
  if (volAccel < 1.15) return false;           // volume accelerating
  return true;
}

export function momentumFade(c: Pick<Candidate, 'txns' | 'change' | 'volume' | 'liquidityUsd'>, peakPrice: number, lastPrice: number): { exit: boolean; reason: string } {
  const b5 = c.txns?.m5b || 0, s5 = c.txns?.m5s || 0;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0.5;
  const fromPeak = peakPrice > 0 ? (lastPrice / peakPrice - 1) * 100 : 0;
  if (fromPeak <= -6 && r5 < 0.48) return { exit: true, reason: 'fade after peak' };
  if ((c.change?.m5 || 0) < -5 && r5 < 0.42) return { exit: true, reason: '5m dump + sell pressure' };
  return { exit: false, reason: '' };
}

export function activeStop(p: RiskParams, pos: Pick<Position, 'entryPrice' | 'peakPrice'>): { level: number; kind: 'hard' | 'trailing' } {
  const hard = pos.entryPrice * (1 - p.hardStopPct / 100);
  const trail = (pos.peakPrice || pos.entryPrice) * (1 - p.trailingStopPct / 100);
  if (trail > hard) return { level: trail, kind: 'trailing' };
  return { level: hard, kind: 'hard' };
}

export function fmtPct(x: number) { return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }
