// RISK agent - pure, unit-tested position sizing and exit logic.
import type { Position } from './types.ts';

export type RiskParams = {
  positionPct: number;
  minTradeUsd: number;
  maxPositions: number;
  hardStopPct: number;
  trailingStopPct: number;
  maxHoldMin: number;
  dailyLossLimitPct: number;
};

export const FEE_RESERVE_SOL = 0.006; // always keep for network fees + one token-account rent

/** USD size of the next trade: % of current total portfolio, capped by free cash. */
export function positionSizeUsd(p: RiskParams, portfolioUsd: number, freeCashUsd: number, reserveUsd: number): number {
  if (!(portfolioUsd > 0)) return 0;
  const target = (portfolioUsd * p.positionPct) / 100;
  const spendable = Math.max(0, freeCashUsd - reserveUsd);
  const size = Math.min(target, spendable);
  return size >= p.minTradeUsd ? round2(size) : 0;
}

export type GateInput = {
  openPositions: number;
  dayStartEquityUsd: number;
  equityUsd: number;
  alreadyHolding: boolean;
  inCooldown: boolean;
};

/** Can we open a new position? Returns null if ok, or a reason. */
export function entryBlocked(p: RiskParams, g: GateInput): string | null {
  if (g.alreadyHolding) return 'already holding';
  if (g.inCooldown) return 'cooldown after recent exit';
  if (g.openPositions >= p.maxPositions) return `max ${p.maxPositions} positions`;
  if (g.dayStartEquityUsd > 0) {
    const ddPct = ((g.dayStartEquityUsd - g.equityUsd) / g.dayStartEquityUsd) * 100;
    if (ddPct >= p.dailyLossLimitPct) return `daily loss limit hit (-${ddPct.toFixed(1)}%)`;
  }
  return null;
}

export type ExitDecision = { exit: boolean; kind: 'hard_stop' | 'trailing_stop' | 'time_stop' | null; reason: string };

/** Update the peak and decide whether to exit at `price`. Mutates nothing; returns new peak. */
export function evaluateExit(p: RiskParams, pos: Pick<Position, 'entryPrice' | 'peakPrice' | 'openedAt'>, price: number, now = Date.now()): ExitDecision & { peak: number } {
  const peak = Math.max(pos.peakPrice, price);
  if (!(price > 0)) return { exit: false, kind: null, reason: 'no price', peak };
  const fromEntry = (price / pos.entryPrice - 1) * 100;
  const fromPeak = (price / peak - 1) * 100;
  const hardStop = pos.entryPrice * (1 - p.hardStopPct / 100);
  const trail = peak * (1 - p.trailingStopPct / 100);
  // whichever stop level is higher is the active one
  if (trail > hardStop && price <= trail)
    return { exit: true, kind: 'trailing_stop', reason: `trailing stop ${fmtPct(fromEntry)} (−${Math.abs(fromPeak).toFixed(1)}% from top)`, peak };
  if (price <= hardStop)
    return { exit: true, kind: 'hard_stop', reason: `-${p.hardStopPct}% stop (${fmtPct(fromEntry)})`, peak };
  if (p.maxHoldMin > 0 && now - pos.openedAt >= p.maxHoldMin * 60_000)
    return { exit: true, kind: 'time_stop', reason: `time stop ${p.maxHoldMin}m (${fmtPct(fromEntry)})`, peak };
  return { exit: false, kind: null, reason: '', peak };
}

/** The price level that currently triggers an exit. */
export function activeStop(p: RiskParams, pos: Pick<Position, 'entryPrice' | 'peakPrice'>): { level: number; kind: 'hard' | 'trailing' } {
  const hard = pos.entryPrice * (1 - p.hardStopPct / 100);
  const trail = pos.peakPrice * (1 - p.trailingStopPct / 100);
  return trail > hard ? { level: trail, kind: 'trailing' } : { level: hard, kind: 'hard' };
}

export function fmtPct(x: number) { return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }
function round2(x: number) { return Math.floor(x * 100) / 100; }
