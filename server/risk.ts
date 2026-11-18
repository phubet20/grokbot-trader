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

/** SOL that must stay free so open positions can still exit (fees + optional new ATA). */
export function exitReserveSol(priorityFeeSol: number, openPositions = 0, openingNew = false): number {
  const fee = sellFeeSol(priorityFeeSol);
  const exits = Math.max(1, openPositions + (openingNew ? 1 : 0));
  return fee * exits + (openingNew ? ATA_RENT_SOL : 0);
}

export function reserveSol(priorityFeeSol: number): number {
  return sellFeeSol(priorityFeeSol) + ATA_RENT_SOL;
}

/** USD size for one new position. Tiny books (<~$5 free after reserve) go all-in. */
export function positionSizeUsd(p: RiskParams, portfolioUsd: number, freeCashUsd: number, reserveUsd: number, sizeMult = 1): number {
  const free = Math.max(0, freeCashUsd - reserveUsd);
  if (free <= 0) return 0;
  if (free <= 5) return free; // all-in after reserve on tiny books
  const pct = Math.min(25, Math.max(1, p.positionPct)) / 100;
  const raw = portfolioUsd * pct * (sizeMult > 0 ? sizeMult : 1);
  return Math.min(free, Math.max(0, raw));
}

export function usableSlots(p: RiskParams, equityUsd: number, freeCashUsd: number, reserveUsd: number, openPositions = 0): number {
  if (p.maxPositions > 0) return Math.max(0, p.maxPositions - openPositions);
  const free = Math.max(0, freeCashUsd - reserveUsd);
  if (free <= 0) return 0;
  if (free <= 5) return openPositions > 0 ? 0 : 1;
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
  // Mild anti-martingale: after wins size up a little; after losses size down.
  const last = recentPnlsChrono.slice(-5);
  if (!last.length) return 1;
  const wins = last.filter((x) => x > 0).length;
  const losses = last.filter((x) => x < 0).length;
  if (wins >= 3 && losses === 0) return 1.15;
  if (losses >= 3) return 0.7;
  if (losses >= 2) return 0.85;
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
  const minScore = Math.min(70, base.minScore + (cl >= 3 ? 4 : cl >= 2 ? 2 : 0));
  return {
    minScore,
    trailingStopPct: base.trailingStopPct,
    hardStopPct: base.hardStopPct,
    pauseMs: cl >= 4 ? 3 * 60_000 : cl >= 3 ? 90_000 : 0,
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

/** Small-book gate: only coins that are already pumping with real buy pressure. */
export function momentumEntryOk(c: Candidate): boolean {
  const b5 = c.txns.m5b, s5 = c.txns.m5s;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0;
  const volAccel = c.volume.h1 > 0 ? (c.volume.m5 * 12) / c.volume.h1 : (c.volume.m5 > 0 ? 2 : 0);
  if (c.change.m5 < 4) return false;
  if (c.change.m5 > 55) return false;
  if ((c.change.m15 || 0) < 1) return false;
  if (r5 < 0.58) return false;
  if ((b5 + s5) < 10) return false;
  if (volAccel < 1.0) return false;
  return true;
}

export function momentumFade(c: Pick<Candidate, 'txns' | 'change' | 'volume' | 'liquidityUsd'>, peakPrice: number, lastPrice: number): { exit: boolean; reason: string } {
  const b5 = c.txns?.m5b || 0, s5 = c.txns?.m5s || 0;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0.5;
  const fromPeak = peakPrice > 0 ? (lastPrice / peakPrice - 1) * 100 : 0;
  if (fromPeak <= -8 && r5 < 0.45) return { exit: true, reason: 'fade after peak' };
  if ((c.change?.m5 || 0) < -6 && r5 < 0.4) return { exit: true, reason: '5m dump + sell pressure' };
  return { exit: false, reason: '' };
}

export function activeStop(p: RiskParams, pos: Pick<Position, 'entryPrice' | 'peakPrice'>): { level: number; kind: 'hard' | 'trailing' } {
  const hard = pos.entryPrice * (1 - p.hardStopPct / 100);
  const trail = (pos.peakPrice || pos.entryPrice) * (1 - p.trailingStopPct / 100);
  if (trail > hard) return { level: trail, kind: 'trailing' };
  return { level: hard, kind: 'hard' };
}

export function fmtPct(x: number) { return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }
