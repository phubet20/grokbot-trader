// Online self-tuning for paper trading. Learns per-pattern expectancy and
// adjusts weights / score floors / exit sensitivity with tight guardrails.
// Objective: equity-curve slope and smoothness (Sharpe-like), not raw PnL alone.

export const MIN_SAMPLES = 3;
export const EPS = 0.08;
const W_MIN = 0;
const W_MAX = 1.8;
const SENS_MIN = 0.75;
const SENS_MAX = 1.35;
const SCORE_ADJ_MIN = -3;
const SCORE_ADJ_MAX = 3;

export type PatternKey =
  | 'fresh-launch'
  | 'curve-breakout'
  | 'near-graduation'
  | 'post-graduation'
  | 'first-pullback'
  | 'dip-reclaim'
  | 'buy-candle'
  | 'whale-inflow'
  | 'big-money'
  | 'bounce'
  | 'momentum-burst'
  | 'ob-pullback'
  | 'fvg-pullback'
  | 'score'
  | 'other';

export type PatternStats = {
  key: PatternKey;
  n: number;
  wins: number;
  losses: number;
  wr: number;
  expectancy: number;
  sumPnl: number;
  ddContrib: number;
  weight: number;
  minScoreAdj: number;
  disabled: boolean;
  exploring: boolean;
  immediateRed: number;
  immediateRate: number;
};

export type GovernorMode = 'relaxed' | 'tight';

export type GovernorState = {
  mode: GovernorMode;
  slopePctPerMin: number;
  tradeSlopePct: number;
  windowTrades: number;
  windowMin: number;
  minScoreAdj: number;
  tpPct: number;
  sizeMult: number;
  earlyCutSec: number;
  favored: PatternKey[];
  note: string;
};

export const FAVORED_PATTERNS: PatternKey[] = ['first-pullback', 'momentum-burst'];

export function defaultGovernor(baseTp = 3): GovernorState {
  return {
    mode: 'relaxed',
    slopePctPerMin: 0,
    tradeSlopePct: 0,
    windowTrades: 0,
    windowMin: 8,
    minScoreAdj: 0,
    tpPct: baseTp,
    sizeMult: 1,
    earlyCutSec: 0,
    favored: [...FAVORED_PATTERNS],
    note: 'relaxed — waiting for equity slope',
  };
}

export type TuneSnapshot = {
  enabled: boolean;
  patterns: PatternStats[];
  exits: Record<string, number>;
  exitSensitivity: number;
  equityScore: number;
  slope: number;
  smoothness: number;
  trades: number;
  minSamples: number;
  updatedAt: number;
  note: string;
  governor: GovernorState;
};

type TradeRec = { pattern: PatternKey; pnlUsd: number; costUsd: number; pnlPct: number; equity: number; ts: number; exitKind?: string; exitReason?: string; immediateRed?: boolean; weight?: number; prior?: boolean };

const PATTERN_KEYS: PatternKey[] = ['fresh-launch','curve-breakout','near-graduation','post-graduation','first-pullback','dip-reclaim','buy-candle','whale-inflow','big-money','bounce','momentum-burst','ob-pullback','fvg-pullback','score','other'];

function classify(reason: string): PatternKey {
  const r = (reason || '').toLowerCase().replace(/_/g, '-');
  if (PATTERN_KEYS.includes(r as PatternKey)) return r as PatternKey;
  if (r.includes('fresh-launch') || r.includes('fresh launch')) return 'fresh-launch';
  if (r.includes('curve-breakout') || r.includes('curve breakout')) return 'curve-breakout';
  if (r.includes('near-graduation') || r.includes('near graduation')) return 'near-graduation';
  if (r.includes('post-graduation') || r.includes('post graduation')) return 'post-graduation';
  if (r.includes('first-pullback') || r.includes('first pullback')) return 'first-pullback';
  if (r.includes('dip-reclaim') || r.includes('dip-buy') || r.includes('dip reclaim')) return 'dip-reclaim';
  if (r.includes('buy-candle') || r.includes('buy candle')) return 'buy-candle';
  if (r.includes('whale') || r.includes('big-money inflow') || r.includes('big money')) return 'whale-inflow';
  if (r.includes('net buy volume')) return 'big-money';
  if (r.includes('bounce')) return 'bounce';
  if (r.includes('momentum-thrust') || r.includes('momentum thrust') || r.includes('momentum-burst') || r.includes('momentum burst') || r.includes('buy pressure') || (r.includes('breakout') && !r.includes('curve'))) return 'momentum-burst';
  if (r.includes('ob-pullback') || r.includes('ob pullback') || r.includes('order block')) return 'ob-pullback';
  if (r.includes('fvg-pullback') || r.includes('fvg pullback') || r.includes('fair value')) return 'fvg-pullback';
  if (r.startsWith('score') || r.includes('score ')) return 'score';
  return 'other';
}

export function patternKey(reason: string): PatternKey {
  return classify(reason);
}

function empty(key: PatternKey): PatternStats {
  return { key, n: 0, wins: 0, losses: 0, wr: 0, expectancy: 0, sumPnl: 0, ddContrib: 0, weight: 1, minScoreAdj: 0, disabled: false, exploring: false, immediateRed: 0, immediateRate: 0 };
}

/** Sample Beta(a,b) via two gamma draws (Marsaglia-Tsang for a>=1). */
export function betaSample(a: number, b: number, rnd: () => number = Math.random): number {
  const g = (shape: number) => {
    const s = Math.max(1, shape);
    const d = s - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 40; i++) {
      let x: number, v: number;
      do { x = gaussian(rnd); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = rnd();
      if (u < 1 - 0.0331 * (x * x) * (x * x) || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
        return d * v * (shape < 1 ? Math.pow(rnd(), 1 / Math.max(shape, 1e-6)) : 1);
    }
    return s;
  };
  const x = g(Math.max(0.5, a)), y = g(Math.max(0.5, b));
  return x / Math.max(1e-9, x + y);
}

function gaussian(rnd: () => number) {
  const u = Math.max(1e-12, rnd()), v = Math.max(1e-12, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(n: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, n)); }

export class AutoTune {
  enabled = true;
  minSamples = MIN_SAMPLES;
  exitSensitivity = 1;
  equityScore = 0;
  slope = 0;
  smoothness = 1;
  updatedAt = 0;
  private trades: TradeRec[] = [];
  private patterns = new Map<PatternKey, PatternStats>();
  private eqTicks: { t: number; eq: number }[] = [];
  private tight = false;
  private gov: GovernorState = defaultGovernor();
  private priorsSeeded = false;

  load(raw: any) {
    if (!raw || typeof raw !== 'object') return;
    this.exitSensitivity = clamp(Number(raw.exitSensitivity) || 1, SENS_MIN, SENS_MAX);
    this.equityScore = Number(raw.equityScore) || 0;
    this.slope = Number(raw.slope) || 0;
    this.smoothness = Number(raw.smoothness) || 1;
    this.updatedAt = Number(raw.updatedAt) || 0;
    this.tight = !!raw.tight;
    this.priorsSeeded = !!raw.priorsSeeded;
    if (Array.isArray(raw.trades)) this.trades = raw.trades.slice(-400);
    if (Array.isArray(raw.eqTicks)) this.eqTicks = raw.eqTicks.slice(-300);
    if (Array.isArray(raw.patterns)) {
      for (const p of raw.patterns) {
        if (p && p.key) this.patterns.set(p.key, { ...empty(p.key), ...p });
      }
    }
    this.refreshGovernor();
  }

  dump() {
    return {
      exitSensitivity: this.exitSensitivity,
      equityScore: this.equityScore,
      slope: this.slope,
      smoothness: this.smoothness,
      updatedAt: this.updatedAt,
      trades: this.trades.slice(-400),
      patterns: [...this.patterns.values()],
      tight: this.tight,
      priorsSeeded: this.priorsSeeded,
      eqTicks: this.eqTicks.slice(-300),
    };
  }

  record(opts: { reason: string; pnlUsd: number; costUsd: number; pnlPct: number; equity: number; ts?: number; exitKind?: string; exitReason?: string; immediateRed?: boolean }) {
    if (!this.enabled) return;
    const pattern = classify(opts.reason);
    const cost = Math.max(1e-6, opts.costUsd);
    const rec: TradeRec = { pattern, pnlUsd: opts.pnlUsd, costUsd: cost, pnlPct: opts.pnlPct, equity: opts.equity, ts: opts.ts || Date.now(), exitKind: opts.exitKind, exitReason: opts.exitReason, immediateRed: !!opts.immediateRed, weight: (opts as any).weight, prior: (opts as any).prior };
    this.trades.push(rec);
    if (this.trades.length > 400) this.trades = this.trades.slice(-400);
    this.rebuild();
  }

  private rebuild() {
    const map = new Map<PatternKey, PatternStats>();
    const eqs = this.trades.map((t) => t.equity).filter((x) => x > 0);
    const { slope, smoothness, score } = equityScore(eqs);
    this.slope = slope;
    this.smoothness = smoothness;
    this.equityScore = score;

    for (const t of this.trades) {
      const w = Math.max(0, t.weight ?? 1);
      const s = map.get(t.pattern) || empty(t.pattern);
      s.n += w;
      if (t.immediateRed) s.immediateRed += w;
      if (t.pnlUsd > 0) s.wins += w; else s.losses += w;
      s.sumPnl += t.pnlUsd * w;
      if (t.pnlUsd < 0) s.ddContrib += t.pnlUsd * w;
      s.expectancy += (t.pnlUsd / t.costUsd) * w;
      map.set(t.pattern, s);
    }
    for (const s of map.values()) {
      s.wr = s.n ? s.wins / s.n : 0;
      s.immediateRate = s.n ? s.immediateRed / s.n : 0;
      const costSum = this.trades.filter((t) => t.pattern === s.key).reduce((a, t) => a + t.costUsd * Math.max(0, t.weight ?? 1), 0);
      s.expectancy = s.n ? s.sumPnl / Math.max(1e-6, costSum) : 0;
      if (s.n >= this.minSamples) {
        // Light adaptation only: never disable a pattern or raise the floor by more than ±3.
        s.disabled = false;
        let w = 1 + clamp(s.expectancy * 1.2, -0.2, 0.25) + clamp((s.wr - 0.5) * 0.3, -0.15, 0.15);
        if (s.immediateRate >= 0.45) w -= 0.1;
        s.weight = clamp(w, 0.85, W_MAX);
        s.minScoreAdj = clamp(Math.round(-s.expectancy * 12), SCORE_ADJ_MIN, SCORE_ADJ_MAX);
        if (s.immediateRate >= 0.45) s.minScoreAdj = clamp(s.minScoreAdj + 1, SCORE_ADJ_MIN, SCORE_ADJ_MAX);
      } else if (s.n >= 2) {
        s.disabled = false;
        if (s.expectancy < 0 && s.losses >= 2) {
          s.weight = clamp(0.9 + s.expectancy * 0.3, 0.85, 1);
          s.minScoreAdj = clamp(Math.round(-s.expectancy * 10), 1, SCORE_ADJ_MAX);
        } else if (s.expectancy > 0 && s.wins >= 2) {
          s.weight = clamp(1 + s.expectancy * 0.8, 1, 1.2);
          s.minScoreAdj = 0;
        } else {
          s.weight = 1;
          s.minScoreAdj = 0;
        }
      } else {
        s.weight = 1;
        s.disabled = false;
        s.minScoreAdj = 0;
      }
    }
    this.patterns = map;
    this.tuneExitSensitivity();
    this.refreshGovernor();
    this.updatedAt = Date.now();
  }

  /** Drop mark-to-market ticks on a mode switch so paper and live equity are not mixed. */
  resetEquityWindow() {
    this.eqTicks = [];
  }

  /** Track equity even between closes so the governor can see a stall mid-session. */
  observeEquity(eq: number, ts = Date.now()) {
    if (!(eq > 0)) return;
    const last = this.eqTicks[this.eqTicks.length - 1];
    if (last && ts - last.t < 2000) { last.eq = eq; last.t = ts; }
    else this.eqTicks.push({ t: ts, eq });
    this.eqTicks = this.eqTicks.filter((x) => ts - x.t <= 20 * 60_000).slice(-300);
    this.refreshGovernor();
  }

  private refreshGovernor(baseTp = 3) {
    const now = Date.now();
    const windowMin = 8;
    const ticks = this.eqTicks.filter((x) => now - x.t <= windowMin * 60_000);
    let slopePctPerMin = 0;
    if (ticks.length >= 3) {
      const dt = (ticks[ticks.length - 1].t - ticks[0].t) / 60_000;
      const start = ticks[0].eq, end = ticks[ticks.length - 1].eq;
      if (dt >= 0.4 && start > 0) slopePctPerMin = ((end - start) / start * 100) / dt;
    }
    const recent = this.trades.slice(-8);
    let tradeSlopePct = 0;
    if (recent.length >= 4 && recent[0].equity > 0)
      tradeSlopePct = ((recent[recent.length - 1].equity - recent[0].equity) / recent[0].equity) * 100;
    // Tight mode (score raises, size cuts, faster TP) is retired. Equity slope is
    // still observed, but trading params stay at the configured defaults.
    this.tight = false;
    this.gov = {
      mode: 'relaxed',
      slopePctPerMin,
      tradeSlopePct,
      windowTrades: recent.length,
      windowMin,
      minScoreAdj: 0,
      tpPct: baseTp,
      sizeMult: 1,
      earlyCutSec: 0,
      favored: [...FAVORED_PATTERNS],
      note: 'light adapt only — score nudges capped at ±3; no TIGHT, no size cuts',
    };
  }

  governor(baseTp = 3): GovernorState {
    this.refreshGovernor(baseTp);
    return this.gov;
  }

  takeProfitPct(base: number): number { return this.governor(base).tpPct; }

  patternAdj(why: string): number {
    const s = this.patterns.get(classify(why));
    if (!s || s.n < 2) return 0;
    return clamp(Math.round(s.expectancy * 10), SCORE_ADJ_MIN, SCORE_ADJ_MAX);
  }

  entrySizeMult(_why: string): number {
    return 1;
  }

  private tuneExitSensitivity() {
    const recent = this.trades.slice(-40);
    if (recent.length < this.minSamples) { this.exitSensitivity = 1; return; }
    const rets = recent.map((t) => t.pnlUsd / t.costUsd);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, rets.length - 1);
    const sharpe = mean / Math.max(0.02, Math.sqrt(varr));
    // Choppy negative curve → exit a bit sooner; smooth positive → give trades more room.
    let s = 1;
    if (sharpe < 0) s = 1.1;
    if (mean < -0.05) s = 1.2;
    if (sharpe > 0.4 && mean > 0) s = 0.9;
    if (this.smoothness < 0.5 && mean < 0) s = 1.15;
    this.exitSensitivity = clamp(s, SENS_MIN, SENS_MAX);
  }

  /** Thompson sample vs a uniform exploration arm. */
  allow(reason: string, rnd: () => number = Math.random): { ok: boolean; key: PatternKey; weight: number; minScoreAdj: number; exploring: boolean } {
    const key = classify(reason);
    const s = this.patterns.get(key) || empty(key);
    if (s.n < this.minSamples) return { ok: true, key, weight: 1, minScoreAdj: 0, exploring: false };
    // Never block a pattern. Score floor nudges stay inside ±3.
    const explore = rnd() < EPS;
    return { ok: true, key, weight: s.weight || 1, minScoreAdj: clamp(s.minScoreAdj, SCORE_ADJ_MIN, SCORE_ADJ_MAX), exploring: explore };
  }

  sizeMult(reason: string): number {
    const key = classify(reason);
    const s = this.patterns.get(key);
    if (!s || s.n < this.minSamples) return 1;
    return 1;
  }

  seedFromPriors(events: { pattern: PatternKey | string; pnlUsd: number; costUsd: number; pnlPct: number; weight?: number; exitKind?: string; exitReason?: string; ts?: number }[]) {
    if (this.priorsSeeded) return;
    if (!events?.length) return;
    for (const ev of events) {
      const cost = Math.max(1e-6, ev.costUsd || 1);
      this.trades.push({
        pattern: (ev.pattern as PatternKey) || 'other',
        pnlUsd: ev.pnlUsd,
        costUsd: cost,
        pnlPct: ev.pnlPct,
        equity: 0,
        ts: ev.ts || 1,
        exitKind: ev.exitKind,
        exitReason: ev.exitReason,
        weight: ev.weight ?? 1,
        prior: true,
      });
    }
    if (this.trades.length > 400) {
      const priors = this.trades.filter((t) => t.prior);
      const live = this.trades.filter((t) => !t.prior).slice(-(400 - Math.min(200, priors.length)));
      this.trades = [...priors.slice(-200), ...live];
    }
    this.priorsSeeded = true;
    this.rebuild();
  }

  snapshot(): TuneSnapshot {
    const list = [...this.patterns.values()].sort((a, b) => b.n - a.n);
    const exits: Record<string, number> = {};
    for (const tr of this.trades) {
      const k = tr.exitKind || 'other';
      exits[k] = (exits[k] || 0) + 1;
    }
    return {
      enabled: this.enabled,
      patterns: list,
      exits,
      exitSensitivity: this.exitSensitivity,
      equityScore: this.equityScore,
      slope: this.slope,
      smoothness: this.smoothness,
      trades: this.trades.length,
      minSamples: this.minSamples,
      updatedAt: this.updatedAt,
      note: this.trades.length < this.minSamples
        ? `learning — leaning after 2 closes, full weights at ${this.minSamples} per pattern`
        : 'tuning from rolling expectancy and equity-curve smoothness',
      governor: this.governor(),
    };
  }
}

/** Sharpe-like score of an equity path: slope of OLS fit, penalized by residual noise. */
export function equityScore(eqs: number[]): { slope: number; smoothness: number; score: number } {
  if (eqs.length < 3) return { slope: 0, smoothness: 1, score: 0 };
  const n = eqs.length;
  const xs = eqs.map((_, i) => i);
  const xBar = (n - 1) / 2;
  const yBar = eqs.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xBar, dy = eqs[i] - yBar;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const ssRes = syy - (sxx > 0 ? (sxy * sxy) / sxx : 0);
  const r2 = syy > 0 ? Math.max(0, 1 - ssRes / syy) : 1;
  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push((eqs[i] - eqs[i - 1]) / Math.max(1e-6, eqs[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, rets.length - 1));
  const sharpe = mean / Math.max(0.002, sd);
  const score = slope / Math.max(0.5, eqs[0] / 20) * 0.5 + sharpe * 0.35 + r2 * 0.15;
  return { slope, smoothness: r2, score };
}
