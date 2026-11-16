// Central configuration. Everything has a safe default. MODE is "paper" unless
// explicitly changed AND confirmed (see liveGate()).
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
  minTradeUsd: number;         // never open a trade smaller than this
  maxPositions: number;        // max concurrent open positions
  hardStopPct: number;         // exit if price drops this % below entry
  trailingStopPct: number;     // exit if price drops this % from the peak
  maxHoldMin: number;          // exit stale positions after N minutes
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
};

export const DEFAULTS: Config = {
  appName: 'Grok Bot',
  mode: 'paper',
  dataSource: 'live',
  port: 8787,
  startUsd: 81,
  positionPct: 8,
  minTradeUsd: 0.25,
  maxPositions: 1,
  hardStopPct: 5,
  trailingStopPct: 6,
  maxHoldMin: 20,
  dailyLossLimitPct: 15,
  cooldownMin: 30,
  minScore: 55,
  minLiquidityUsd: 8000,
  maxLiquidityUsd: 5_000_000,
  minHolders: 40,
  minAgeMin: 1,
  maxAgeHours: 72,
  minMcapUsd: 8_000,
  maxMcapUsd: 50_000_000,
  maxTopHolderPct: 25,
  slippageBps: 400,
  extraSlippageBps: 50,
  priorityFeeSol: 0.0002,
  scanIntervalSec: 6,
  monitorIntervalSec: 1,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  liveConfirm: '',
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
    } else if (typeof v === 'string') out[k] = v;
  }
  if (out.startUsd !== undefined) out.startUsd = Math.max(2, out.startUsd);
  if (out.positionPct !== undefined) out.positionPct = Math.min(100, Math.max(1, out.positionPct));
  if (out.maxPositions !== undefined) out.maxPositions = Math.min(20, Math.max(1, Math.round(out.maxPositions)));
  if (out.hardStopPct !== undefined) out.hardStopPct = Math.min(50, Math.max(1, out.hardStopPct));
  if (out.trailingStopPct !== undefined) out.trailingStopPct = Math.min(60, Math.max(2, out.trailingStopPct));
  if (out.mode !== undefined && out.mode !== 'live' && out.mode !== 'live-auto') out.mode = 'paper';
  if (out.dataSource !== undefined && out.dataSource !== 'replay') out.dataSource = 'live';
  return out;
}

let fileCfg: Partial<Config> = {};
if (existsSync(CFG_FILE)) {
  try { fileCfg = JSON.parse(readFileSync(CFG_FILE, 'utf8')); } catch { fileCfg = {}; }
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
