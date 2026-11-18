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
