// Central configuration. Single source of truth for all risk and runtime params.
// MODE is "paper" unless explicitly changed AND confirmed (see liveGate()).
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
  startUsd: number;            // paper wallet starting balance (USD), min 2
  positionPct: number;         // % of current portfolio per trade
  minTradeUsd: number;         // unused as a gate (0); kept for config compat
  maxPositions: number;        // 0 = unlimited (cash is the only cap)
  takeProfitPct: number;       // take-profit floor (net %)
  hardStopPct: number;         // exit if price drops this % below entry
  trailingStopPct: number;     // exit if price drops this % from the peak
  maxHoldMin: number;          // exit stale positions after N minutes (0 = disabled)
  redExitSec: number;          // sell a red position after this many seconds
  dailyLossLimitPct: number;   // pause new buys after losing this % of day-start equity
  cooldownMin: number;         // don't re-buy the same token for N minutes after exit
  minScore: number;            // analyst score needed to buy (0-100)
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  minHolders: number;
  minAgeMin: number;
  maxAgeHours: number;
  minMcapUsd: number;
  maxMcapUsd: number;
  maxTopHolderPct: number;
  slippageBps: number;         // slippage tolerance passed to Jupiter
  extraSlippageBps: number;    // extra pessimistic slippage applied to paper fills
  priorityFeeSol: number;      // per-tx priority fee assumption
  scanIntervalSec: number;
  monitorIntervalSec: number;
  rpcUrl: string;
  liveConfirm: string;         // must equal LIVE_CONFIRM_PHRASE for live mode
  realisticPaper: boolean;     // paper TP/close settles on the real sell quote (default)
};

/**
 * Stable defaults (Nov 2026 cleanup).
 * - positionPct 5%: meaningful size without over-concentration
 * - hardStop 7% / trailing 10%: tight enough to limit damage, not so tight that noise stops us out
 * - takeProfit 2.5%: realistic scalp target for meme volatility
 * - maxHoldMin 30: prevent zombie positions
 */
export const DEFAULTS: Config = {
  appName: 'Grok Bot',
  mode: 'paper',
  dataSource: 'live',
  port: 8787,
  startUsd: 81,
  positionPct: 5,
  minTradeUsd: 0,
  maxPositions: 0,
  takeProfitPct: 2.5,
  hardStopPct: 7,
  trailingStopPct: 10,
  maxHoldMin: 30,
  redExitSec: 60,
  dailyLossLimitPct: 12,
  cooldownMin: 1,
  minScore: 42,
  minLiquidityUsd: 1200,
  maxLiquidityUsd: 50_000_000,
  minHolders: 40,
  minAgeMin: 1,
  maxAgeHours: 48,
  minMcapUsd: 2_000,
  maxMcapUsd: 50_000_000,
  maxTopHolderPct: 22,
  slippageBps: 400,
  extraSlippageBps: 50,
  priorityFeeSol: 0.0002,
  scanIntervalSec: 3,
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
  if (out.redExitSec !== undefined) out.redExitSec = Math.min(180, Math.max(20, Math.round(out.redExitSec)));
  if (out.maxHoldMin !== undefined) out.maxHoldMin = Math.min(120, Math.max(0, Math.round(out.maxHoldMin)));
  if (out.mode !== undefined && out.mode !== 'live' && out.mode !== 'live-auto') out.mode = 'paper';
  if (out.dataSource !== undefined && out.dataSource !== 'replay') out.dataSource = 'live';
  return out;
}

/**
 * One-time migration: force old conflicting defaults to the new stable set.
 * Only rewrites values that match known-bad previous defaults so user custom
 * settings are preserved.
 */
export function migrateStockDefaults(file: Partial<Config>): Partial<Config> {
  const out: Partial<Config> = { ...file };
  // Old ultra-loose stops → new tight defaults
  if (out.hardStopPct === 35 || out.hardStopPct === 8) out.hardStopPct = DEFAULTS.hardStopPct;
  if (out.trailingStopPct === 60 || out.trailingStopPct === 12) out.trailingStopPct = DEFAULTS.trailingStopPct;
  // Old micro-size or 8% → 5%
  if (out.positionPct === 1 || out.positionPct === 8) out.positionPct = DEFAULTS.positionPct;
  // Old TP values
  if (out.takeProfitPct === 1.8 || out.takeProfitPct === 3) out.takeProfitPct = DEFAULTS.takeProfitPct;
  // Old scan / score
  if (out.scanIntervalSec === 2.5 || out.scanIntervalSec === 6) out.scanIntervalSec = DEFAULTS.scanIntervalSec;
  if (out.minScore === 40 || out.minScore === 48) out.minScore = DEFAULTS.minScore;
  // Ensure time stop is enabled
  if (out.maxHoldMin === 0) out.maxHoldMin = DEFAULTS.maxHoldMin;
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

// precedence: defaults < config.json < env
export const config: Config = { ...DEFAULTS, ...sanitize(fileCfg), ...sanitize(fromEnv()) } as Config;

export function updateConfig(patch: Partial<Config>): Config {
  const clean = sanitize(patch);
  // mode/liveConfirm can never be changed from the HTTP API - only by editing
  // data/config.json or env + restart (explicit, deliberate action).
  delete (clean as any).mode;
  delete (clean as any).liveConfirm;
  delete (clean as any).port;
  delete (clean as any).rpcUrl;
  Object.assign(config, clean);
  fileCfg = { ...fileCfg, ...clean };
  writeFileSync(CFG_FILE, JSON.stringify(fileCfg, null, 2));
  return config;
}

/** Live trading needs mode=live or live-auto AND the exact confirmation phrase. */
export function liveGate(c: Config = config): { live: boolean; auto: boolean; reason: string } {
  if (c.mode !== 'live' && c.mode !== 'live-auto')
    return { live: false, auto: false, reason: 'MODE=paper (default). Simulated fills only.' };
  if (c.liveConfirm !== LIVE_CONFIRM_PHRASE)
    return { live: false, auto: false, reason: `MODE=${c.mode} requested but LIVE_CONFIRM is not set to the required phrase - staying in paper mode.` };
  if (c.mode === 'live-auto')
    return { live: true, auto: true, reason: 'LIVE AUTO: the bot wallet signs swaps. Withdrawals go only to the locked address.' };
  return { live: true, auto: false, reason: 'LIVE mode armed: every swap still needs approval in Phantom.' };
}
