// Online self-tuning for paper trading. Learns per-pattern expectancy and
// adjusts weights / score floors / exit sensitivity with tight guardrails.
// Objective: equity-curve slope and smoothness (Sharpe-like), not raw PnL alone.

export const MIN_SAMPLES = 3;
export const EPS = 0.08;
const W_MIN = 0;
const W_MAX = 1.8;
const SENS_MIN = 0.75;
const SENS_MAX = 1.35;
const SCORE_ADJ_MIN = -4;
const SCORE_ADJ_MAX = 16;

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

type TradeRec = { pattern: PatternKey; pnlUsd: number; costUsd: number; pnlPct: number; equity: number; ts: number; exitKind?: string; exitReason?: string; immediateRed?: boolean };

function classify(reason: string): PatternKey {
  const r = (reason || '').toLowerCase();
  if (r.includes('fresh-launch') || r.includes('fresh launch')) return 'fresh-launch';
  if (r.includes('curve breakout')) return 'curve-breakout';
  if (r.includes('near-graduation') || r.includes('near graduation')) return 'near-graduation';
  if (r.includes('post-graduation') || r.includes('post graduation')) return 'post-graduation';
  if (r.includes('first pullback')) return 'first-pullback';
  if (r.includes('dip-reclaim') || r.includes('dip-buy') || r.includes('dip reclaim')) return 'dip-reclaim';
  if (r.includes('buy candle')) return 'buy-candle';
  if (r.includes('whale') || r.includes('big-money inflow') || r.includes('big money')) return 'whale-inflow';
  if (r.includes('net buy volume')) return 'big-money';
  if (r.includes('bounce')) return 'bounce';
  if (r.includes('momentum thrust') || r.includes('momentum burst') || r.includes('buy pressure') || (r.includes('breakout') && !r.includes('curve'))) return 'momentum-burst';
  if (r.includes('ob pullback') || r.includes('order block')) return 'ob-pullback';
  if (r.includes('fvg pullback') || r.includes('fair value')) return 'fvg-pullback';
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

  load(raw: any) {
    if (!raw || typeof raw !== 'object') return;
    this.exitSensitivity = clamp(Number(raw.exitSensitivity) || 1, SENS_MIN, SENS_MAX);
    this.equityScore = Number(raw.equityScore) || 0;
    this.slope = Number(raw.slope) || 0;
    this.smoothness = Number(raw.smoothness) || 1;
    this.updatedAt = Number(raw.updatedAt) || 0;
    this.tight = !!raw.tight;
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
      eqTicks: this.eqTicks.slice(-300),
    };
  }

  record(opts: { reason: string; pnlUsd: number; costUsd: number; pnlPct: number; equity: number; ts?: number; exitKind?: string; exitReason?: string; immediateRed?: boolean }) {
    if (!this.enabled) return;
    const pattern = classify(opts.reason);
    const cost = Math.max(1e-6, opts.costUsd);
    const rec: TradeRec = { pattern, pnlUsd: opts.pnlUsd, costUsd: cost, pnlPct: opts.pnlPct, equity: opts.equity, ts: opts.ts || Date.now(), exitKind: opts.exitKind, exitReason: opts.exitReason, immediateRed: !!opts.immediateRed };
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
      const s = map.get(t.pattern) || empty(t.pattern);
      s.n++;
      if (t.immediateRed) s.immediateRed++;
      if (t.pnlUsd > 0) s.wins++; else s.losses++;
      s.sumPnl += t.pnlUsd;
      if (t.pnlUsd < 0) s.ddContrib += t.pnlUsd;
      s.expectancy += t.pnlUsd / t.costUsd;
      map.set(t.pattern, s);
    }
    for (const s of map.values()) {
      s.wr = s.n ? s.wins / s.n : 0;
      s.immediateRate = s.n ? s.immediateRed / s.n : 0;
      s.expectancy = s.n ? s.expectancy : 0; // already summed as pnl/cost, divide
      s.expectancy = s.n ? s.sumPnl / Math.max(1e-6, this.trades.filter((t) => t.pattern === s.key).reduce((a, t) => a + t.costUsd, 0)) : 0;
      if (s.n >= this.minSamples) {
        if (s.expectancy < -0.04 || (s.wr < 0.35 && s.expectancy < 0)) {
          s.disabled = true;
          s.weight = 0;
          s.minScoreAdj = SCORE_ADJ_MAX;
        } else {
          s.disabled = false;
          // Map expectancy to a bounded weight; positive gets more size, negative is down-weighted.
          let w = 1 + clamp(s.expectancy * 3, -0.7, 0.8) + clamp((s.wr - 0.5) * 0.6, -0.3, 0.3);
          if (s.immediateRate >= 0.45) w -= 0.35;
          s.weight = clamp(w, 0.35, W_MAX);
          s.minScoreAdj = clamp(Math.round(-s.expectancy * 20), SCORE_ADJ_MIN, SCORE_ADJ_MAX);
          if (s.expectancy < 0) s.minScoreAdj = clamp(6 + Math.round(-s.expectancy * 20), 4, SCORE_ADJ_MAX);
          else s.minScoreAdj = clamp(Math.round(-s.expectancy * 15), SCORE_ADJ_MIN, 2);
          if (s.immediateRate >= 0.45) s.minScoreAdj = clamp(s.minScoreAdj + 6, SCORE_ADJ_MIN, SCORE_ADJ_MAX);
          if (s.immediateRate >= 0.7 && s.expectancy <= 0) { s.disabled = true; s.weight = 0; }
        }
      } else if (s.n >= 2) {
        // Lean after 2 closes so a losing pattern is cut without waiting for a full sample.
        s.disabled = false;
        if (s.expectancy < 0 && s.losses >= 2) {
          s.weight = clamp(0.65 + s.expectancy, 0.4, 1);
          s.minScoreAdj = clamp(4 + Math.round(-s.expectancy * 15), 2, 10);
          if (s.immediateRate >= 0.5) s.minScoreAdj = clamp(s.minScoreAdj + 4, 2, 12);
        } else if (s.expectancy > 0 && s.wins >= 2) {
          s.weight = clamp(1 + s.expectancy * 1.5, 1, 1.3);
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
    const haveTicks = ticks.length >= 3;
    const haveTrades = recent.length >= 4;
    const stalled = (haveTicks && slopePctPerMin <= 0.02) || (haveTrades && tradeSlopePct <= 0);
    const recovered = (!haveTicks || slopePctPerMin > 0.05) && (!haveTrades || tradeSlopePct > 0);
    if (!haveTicks && !haveTrades) this.tight = false;
    else if (stalled) this.tight = true;
    else if (recovered) this.tight = false;

    let sizeMult = 1;
    for (const t of recent) {
      if (t.pnlUsd > 0) sizeMult = Math.min(1.4, sizeMult * 1.2);
      else if (t.pnlUsd < 0) sizeMult = Math.max(0.55, sizeMult * 0.7);
    }
    if (this.tight) sizeMult = Math.min(sizeMult, 0.85);

    this.gov = {
      mode: this.tight ? 'tight' : 'relaxed',
      slopePctPerMin,
      tradeSlopePct,
      windowTrades: recent.length,
      windowMin,
      minScoreAdj: this.tight ? 8 : 0,
      tpPct: this.tight ? Math.max(1.2, Math.min(baseTp, 1.8)) : baseTp,
      sizeMult,
      earlyCutSec: this.tight ? 25 : 0,
      favored: [...FAVORED_PATTERNS],
      note: this.tight
        ? 'tight — equity stalled; higher score, faster TP, early cut, favor pullback + thrust'
        : 'relaxed — equity slope ok; default TP and size',
    };
  }

  governor(baseTp = 3): GovernorState {
    this.refreshGovernor(baseTp);
    return this.gov;
  }

  takeProfitPct(base: number): number { return this.governor(base).tpPct; }

  patternAdj(why: string): number {
    if (!this.tight) return 0;
    const k = classify(why);
    if (FAVORED_PATTERNS.includes(k)) return 6;
    return -5;
  }

  entrySizeMult(why: string): number {
    return clamp(this.sizeMult(why) * this.governor().sizeMult, 0.45, 1.6);
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
    if (s.disabled) {
      const explore = rnd() < EPS;
      return { ok: explore, key, weight: explore ? 0.5 : 0, minScoreAdj: s.minScoreAdj, exploring: explore };
    }
    // Thompson: P(arm beats a baseline Beta(2,2) dummy)
    const draw = betaSample(1 + s.wins, 1 + s.losses, rnd);
    const baseline = betaSample(2, 2, rnd);
    const explore = rnd() < EPS;
    const ok = explore || draw >= baseline * 0.85 || s.expectancy > 0;
    return { ok, key, weight: s.weight, minScoreAdj: s.minScoreAdj, exploring: explore && !ok ? true : explore };
  }

  sizeMult(reason: string): number {
    const key = classify(reason);
    const s = this.patterns.get(key);
    if (!s || s.n < this.minSamples) return 1;
    return clamp(s.weight, 0.5, 1.5);
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
