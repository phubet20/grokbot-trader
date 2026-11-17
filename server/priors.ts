// Seeded paper-trade priors and pump-path matching. No secrets.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';
import type { PatternKey } from './autotune.ts';
import { patternKey } from './autotune.ts';
import type { Candidate } from './types.ts';
import type { TapeSnap } from './strategy.ts';

export type PathVec = {
  volAccel: number;
  buyRatio: number;
  chM5: number;
  chM15: number;
  buyers: number;
};

export type PriorEvent = {
  source: string;
  symbol: string;
  pattern: PatternKey;
  pnlUsd: number;
  pnlPct: number;
  costUsd: number;
  holdSec: number;
  exitReason: string;
  exitKind: string;
  quality: 'realistic' | 'mark' | 'unrealized';
  weight: number;
  score?: number;
  path?: PathVec;
};

export type PaperPriors = {
  version: number;
  builtAt: string;
  sources: string[];
  weighting: { realistic: number; mark: number; unrealized: number };
  events: PriorEvent[];
  patterns: { key: PatternKey; n: number; wins: number; losses: number; wr: number; expectancy: number; sumPnl: number; weightSum: number }[];
  winnerPaths: PathVec[];
  loserPaths: PathVec[];
  staleExit: { defaultSec: number; minSec: number; maxSec: number };
};

export const PRIORS_PATH = join(ROOT, 'server/paper-priors.json');
export const DEFAULT_STALE_SEC = 105;

export function loadPaperPriors(path = PRIORS_PATH): PaperPriors | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || raw.version < 1) return null;
    return raw as PaperPriors;
  } catch { return null; }
}

export function pathVecFromCandidate(c: Pick<Candidate, 'volume' | 'txns' | 'change' | 'traders1h' | 'flow'>): PathVec {
  const v5 = c.volume?.m5 || 0, v1 = c.volume?.h1 || 0;
  const volAccel = v1 > 0 ? (v5 * 12) / v1 : (v5 > 0 ? 2 : 0);
  const b = c.txns?.m5b || 0, s = c.txns?.m5s || 0;
  const buyRatio = b + s > 0 ? b / (b + s) : 0.5;
  const buyers = c.flow?.uniqueBuyers || c.traders1h || (b || 0);
  return { volAccel, buyRatio, chM5: c.change?.m5 || 0, chM15: c.change?.m15 || 0, buyers };
}

export function pathVecFromHist(hist: TapeSnap[]): PathVec | null {
  if (!hist.length) return null;
  const s = hist[hist.length - 1];
  const first = hist[0];
  const v5 = s.vol5 || 0, v1 = s.vol1h || 0;
  const volAccel = v1 > 0 ? (v5 * 12) / v1 : (v5 > 0 ? 2 : 0);
  const buyRatio = (s.b5 + s.s5) > 0 ? s.b5 / (s.b5 + s.s5) : 0.5;
  const chM5 = s.m5;
  const chM15 = s.m15;
  // price-path slope over the tape, as an extra m15-ish cue
  const pathCh = first.px > 0 && hist.length >= 3 ? ((s.px / first.px) - 1) * 100 : chM15;
  return { volAccel, buyRatio, chM5, chM15: pathCh || chM15, buyers: s.tr || 0 };
}

function norm(v: PathVec): number[] {
  // Rough feature scales so cosine isn't dominated by one axis.
  return [
    Math.log1p(Math.max(0, v.volAccel)) / 3,
    v.buyRatio,
    Math.tanh((v.chM5 || 0) / 40),
    Math.tanh((v.chM15 || 0) / 60),
    Math.tanh((v.buyers || 0) / 40),
  ];
}

export function pathSimilarity(a: PathVec, b: PathVec): number {
  const x = norm(a), y = norm(b);
  let dot = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
  const d = Math.sqrt(nx) * Math.sqrt(ny);
  if (!(d > 0)) return 0;
  return (dot / d + 1) / 2; // 0..1
}

/** 0–8 point boost for candidates whose pre-pump tape is close to past winners. */
export function pumpPathBoost(c: Candidate, hist: TapeSnap[], priors: PaperPriors | null): { boost: number; best: number } {
  if (!priors?.winnerPaths?.length) return { boost: 0, best: 0 };
  const vec = pathVecFromHist(hist) || pathVecFromCandidate(c);
  let best = 0;
  for (const w of priors.winnerPaths) best = Math.max(best, pathSimilarity(vec, w));
  if (best < 0.72) return { boost: 0, best };
  const boost = best >= 0.9 ? 8 : best >= 0.82 ? 6 : 4;
  return { boost, best };
}

export function staleExitSec(priors: PaperPriors | null, _governorTight = false): number {
  const d = priors?.staleExit?.defaultSec || DEFAULT_STALE_SEC;
  const lo = priors?.staleExit?.minSec || 90;
  const hi = priors?.staleExit?.maxSec || 180;
  const raw = Math.max(d, 120);
  return Math.max(lo, Math.min(hi, raw));
}

/** Losers with no volume for ~10–15 minutes (default 12 min) — sell and rotate. */
export const DEAD_EXIT_SEC = 12 * 60;
export function isDeadPosition(opts: {
  openedAt: number;
  entryPrice: number;
  lastPrice: number;
  now: number;
  deadSec?: number;
  hist?: { t: number; px: number; vol5?: number; b5?: number; s5?: number }[];
  volumeM5?: number;
  txM5?: number;
}): boolean {
  const need = (opts.deadSec ?? DEAD_EXIT_SEC) * 1000;
  if (opts.now - opts.openedAt < need) return false;
  const fromEntry = opts.entryPrice > 0 ? (opts.lastPrice / opts.entryPrice - 1) * 100 : 0;
  if (fromEntry >= 0) return false;
  const cutoff = opts.now - need;
  const window = (opts.hist || []).filter((s) => s.t >= cutoff);
  const vol = opts.volumeM5 ?? window[window.length - 1]?.vol5 ?? 0;
  const tx = opts.txM5 ?? ((window[window.length - 1]?.b5 || 0) + (window[window.length - 1]?.s5 || 0));
  return vol < 80 && tx < 6;
}

/** Flat price and dead volume for staleSec after entry — rotate the capital. */
export function isStalePosition(opts: {
  openedAt: number;
  entryPrice: number;
  lastPrice: number;
  now: number;
  staleSec: number;
  hist?: TapeSnap[];
  volumeM5?: number;
  txM5?: number;
}): boolean {
  const age = opts.now - opts.openedAt;
  if (age < opts.staleSec * 1000) return false;
  const fromEntry = opts.entryPrice > 0 ? (opts.lastPrice / opts.entryPrice - 1) * 100 : 0;
  if (fromEntry >= 1.5) return false; // still working
  const cutoff = opts.now - opts.staleSec * 1000;
  const window = (opts.hist || []).filter((s) => s.t >= cutoff);
  let pxMove = Math.abs(fromEntry);
  if (window.length >= 2 && window[0].px > 0) {
    pxMove = Math.abs((window[window.length - 1].px / window[0].px - 1) * 100);
  }
  const vol = opts.volumeM5 ?? window[window.length - 1]?.vol5 ?? 0;
  const tx = opts.txM5 ?? ((window[window.length - 1]?.b5 || 0) + (window[window.length - 1]?.s5 || 0));
  const volDead = vol < 80 && tx < 6;
  return pxMove < 1.2 && volDead;
}

export { patternKey };
