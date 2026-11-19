// Central configuration. Single source of truth for all risk and runtime params.
// MODE is "paper" unless explicitly changed AND confirmed (see liveGate()).
// Live-auto uses this scalp profile. Tuned for real fees/slippage, not paper cosmetics.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const CFG_FILE = join(DATA_DIR, 'config.json');

export const LIVE_CONFIRM_PHRASE = 'I UNDERSTAND REAL FUNDS ARE AT RISK';

export type Config = {
  appName: string;
  mode: 'paper' | 'live' | 'live-auto';
  dataSource: 'live' | 'replay';
  port: number;
  startUsd: number;
  positionPct: number;
  minTradeUsd: number;
  maxPositions: number;
  takeProfitPct: number;
  hardStopPct: number;
  trailingStopPct: number;
  maxHoldMin: number;
  redExitSec: number;
  dailyLossLimitPct: number;
  cooldownMin: number;
  minScore: number;
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  minHolders: number;
  minAgeMin: number;
  maxAgeHours: number;
  minMcapUsd: number;
  maxMcapUsd: number;
  maxTopHolderPct: number;
  slippageBps: number;
  extraSlippageBps: number;
  priorityFeeSol: number;
  scanIntervalSec: number;
  monitorIntervalSec: number;
  rpcUrl: string;
  liveConfirm: string;
  realisticPaper: boolean;
};

/**
 * Live-money momentum scalp (Nov 2026).
 *
 * Design for real Solana fills (not paper):
 * - TP high enough that round-trip fees + impact still leave net profit
 * - Stops tight so losers do not sit through meme dumps
 * - Larger ticket % so fixed fees are a smaller share of size
 * - Cap concurrent positions; strict score + liquidity so weak coins never enter
 * - Slightly higher priority fee so exits land when the book is moving
 */
export const DEFAULTS: Config = {
  appName: 'Grok Bot',
  mode: 'paper',
  dataSource: 'live',
  port: 8787,
  startUsd: 81,
  // Fewer, fuller tickets beat many fee-eaten micro trades on small books.
  positionPct: 12,
  minTradeUsd: 0,
  // Hard cap concurrent risk on live capital.
  maxPositions: 3,
  // Gross move must clear ~1–1.5% round-trip friction on small size.
  takeProfitPct: 3.5,
  hardStopPct: 5,
  trailingStopPct: 5,
  maxHoldMin: 5,
  redExitSec: 25,
  dailyLossLimitPct: 10,
  cooldownMin: 2,
  minScore: 55,
  minLiquidityUsd: 5_000,
  maxLiquidityUsd: 50_000_000,
  minHolders: 60,
  minAgeMin: 1,
  maxAgeHours: 18,
  minMcapUsd: 8_000,
  maxMcapUsd: 25_000_000,
  maxTopHolderPct: 18,
  slippageBps: 500,
  extraSlippageBps: 75,
  priorityFeeSol: 0.00035,
  scanIntervalSec: 2.5,
  monitorIntervalSec: 1,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  liveConfirm: '',
  realisticPaper: true,
};

const NUM_KEYS = Object.keys(DEFAULTS).filter((k) => typeof (DEFAULTS as any)[k] === 'number');

function fromEnv(): Partial<Config> {
  const e = process.env;
  const out: any = {};
  if (e.APP_NAME) out.appName = e.APP_NAME;
  if (e.MODE) out.mode = e.MODE;
  if (e.DATA_SOURCE) out.dataSource = e.DATA_SOURCE;
  if (e.PORT) out.port = Number(e.PORT);
  if (e.START_USD) out.startUsd = Number(e.START_USD);
  if (e.POSITION_PCT) out.positionPct = Number(e.POSITION_PCT);
  if (e.TAKE_PROFIT_PCT) out.takeProfitPct = Number(e.TAKE_PROFIT_PCT);
  if (e.HARD_STOP_PCT) out.hardStopPct = Number(e.HARD_STOP_PCT);
  if (e.TRAILING_STOP_PCT) out.trailingStopPct = Number(e.TRAILING_STOP_PCT);
  if (e.RPC_URL) out.rpcUrl = e.RPC_URL;
  if (e.LIVE_CONFIRM) out.liveConfirm = e.LIVE_CONFIRM;
  return out;
}

export function sanitize(c: Partial<Config>): Partial<Config> {
  const out: any = {};
  for (const [k, v] of Object.entries(c)) {
    if (!(k in DEFAULTS)) continue;
    if (NUM_KEYS.includes(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (typeof (DEFAULTS as any)[k] === 'boolean') {
      out[k] = v === true || v === 'true' || v === 1 || v === '1';
    } else if (typeof v === 'string') out[k] = v;
  }
  if (out.startUsd !== undefined) out.startUsd = Math.max(2, out.startUsd);
  if (out.positionPct !== undefined) out.positionPct = Math.min(25, Math.max(1, out.positionPct));
  if (out.maxPositions !== undefined) out.maxPositions = Math.min(1000, Math.max(0, Math.round(out.maxPositions)));
  if (out.takeProfitPct !== undefined) out.takeProfitPct = Math.min(50, Math.max(0.5, out.takeProfitPct));
  if (out.hardStopPct !== undefined) out.hardStopPct = Math.min(25, Math.max(3, out.hardStopPct));
  if (out.trailingStopPct !== undefined) out.trailingStopPct = Math.min(30, Math.max(3, out.trailingStopPct));
  if (out.redExitSec !== undefined) out.redExitSec = Math.min(180, Math.max(15, Math.round(out.redExitSec)));
  if (out.maxHoldMin !== undefined) out.maxHoldMin = Math.min(120, Math.max(0, Math.round(out.maxHoldMin)));
  if (out.mode !== undefined && out.mode !== 'live' && out.mode !== 'live-auto') out.mode = 'paper';
  if (out.dataSource !== undefined && out.dataSource !== 'replay') out.dataSource = 'live';
  return out;
}

/** Only rewrite known stock defaults from older builds — never overwrite intentional custom values. */
export function migrateStockDefaults(file: Partial<Config>): Partial<Config> {
  const out: Partial<Config> = { ...file };
  // Previous stock / pre-live-scalp values → new live-money scalp
  if (out.hardStopPct === 35 || out.hardStopPct === 8 || out.hardStopPct === 6) out.hardStopPct = DEFAULTS.hardStopPct;
  if (out.trailingStopPct === 60 || out.trailingStopPct === 10 || out.trailingStopPct === 7) out.trailingStopPct = DEFAULTS.trailingStopPct;
  if (out.positionPct === 1 || out.positionPct === 5 || out.positionPct === 8) out.positionPct = DEFAULTS.positionPct;
  if (out.takeProfitPct === 1.8 || out.takeProfitPct === 2 || out.takeProfitPct === 2.5 || out.takeProfitPct === 3) out.takeProfitPct = DEFAULTS.takeProfitPct;
  if (out.scanIntervalSec === 2 || out.scanIntervalSec === 6 || out.scanIntervalSec === 3) out.scanIntervalSec = DEFAULTS.scanIntervalSec;
  if (out.minScore === 40 || out.minScore === 48 || out.minScore === 42 || out.minScore === 50) out.minScore = DEFAULTS.minScore;
  if (out.maxHoldMin === 0 || out.maxHoldMin === 30 || out.maxHoldMin === 8) out.maxHoldMin = DEFAULTS.maxHoldMin;
  if (out.redExitSec === 60 || out.redExitSec === 45 || out.redExitSec === 35) out.redExitSec = DEFAULTS.redExitSec;
  if (out.maxPositions === 0) out.maxPositions = DEFAULTS.maxPositions;
  if (out.dailyLossLimitPct === 12 || out.dailyLossLimitPct === 15) out.dailyLossLimitPct = DEFAULTS.dailyLossLimitPct;
  if (out.cooldownMin === 0.25 || out.cooldownMin === 1) out.cooldownMin = DEFAULTS.cooldownMin;
  if (out.minLiquidityUsd === 1200 || out.minLiquidityUsd === 3000) out.minLiquidityUsd = DEFAULTS.minLiquidityUsd;
  if (out.minHolders === 40 || out.minHolders === 50) out.minHolders = DEFAULTS.minHolders;
  if (out.maxAgeHours === 48 || out.maxAgeHours === 24) out.maxAgeHours = DEFAULTS.maxAgeHours;
  if (out.minMcapUsd === 2000 || out.minMcapUsd === 5000) out.minMcapUsd = DEFAULTS.minMcapUsd;
  if (out.maxTopHolderPct === 25 || out.maxTopHolderPct === 20) out.maxTopHolderPct = DEFAULTS.maxTopHolderPct;
  if (out.slippageBps === 400) out.slippageBps = DEFAULTS.slippageBps;
  if (out.priorityFeeSol === 0.0002) out.priorityFeeSol = DEFAULTS.priorityFeeSol;
  return out;
}

let fileCfg: Partial<Config> = {};
if (existsSync(CFG_FILE)) {
  try { fileCfg = JSON.parse(readFileSync(CFG_FILE, 'utf8')); } catch { fileCfg = {}; }
}
{
  const migrated = migrateStockDefaults(fileCfg);
  if (JSON.stringify(migrated) !== JSON.stringify(fileCfg)) {
    fileCfg = migrated;
    try { writeFileSync(CFG_FILE, JSON.stringify(fileCfg, null, 2)); } catch { /* volume may be read-only in tests */ }
  }
}

export const config: Config = { ...DEFAULTS, ...sanitize(fileCfg), ...sanitize(fromEnv()) } as Config;

export function updateConfig(patch: Partial<Config>): Config {
  const clean = sanitize(patch);
  delete (clean as any).mode;
  delete (clean as any).liveConfirm;
  delete (clean as any).port;
  delete (clean as any).rpcUrl;
  Object.assign(config, clean);
  fileCfg = { ...fileCfg, ...clean };
  writeFileSync(CFG_FILE, JSON.stringify(fileCfg, null, 2));
  return config;
}

export function liveGate(c: Config = config): { live: boolean; auto: boolean; reason: string } {
  if (c.mode !== 'live' && c.mode !== 'live-auto')
    return { live: false, auto: false, reason: 'MODE=paper (default). Simulated fills only.' };
  if (c.liveConfirm !== LIVE_CONFIRM_PHRASE)
    return { live: false, auto: false, reason: `MODE=${c.mode} requested but LIVE_CONFIRM is not set to the required phrase - staying in paper mode.` };
  if (c.mode === 'live-auto')
    return { live: true, auto: true, reason: 'LIVE AUTO: the bot wallet signs swaps. Withdrawals go only to the locked address.' };
  return { live: true, auto: false, reason: 'LIVE mode armed: every swap still needs approval in Phantom.' };
}
