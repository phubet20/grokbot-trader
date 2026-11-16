// Build data/paper-priors.json from every paper trade source we can find.
// Realistic-quote results are weighted 1.0; mark-settled 0.4; unrealized 0.25.
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULTS, ROOT } from '../server/config.ts';
import { ReplayMarket } from '../server/replay.ts';
import { Store } from '../server/store.ts';
import { Engine } from '../server/engine.ts';
import { patternKey, type PatternKey } from '../server/autotune.ts';
import { pathVecFromCandidate, type PaperPriors, type PriorEvent, type PathVec } from '../server/priors.ts';

const W = { realistic: 1, mark: 0.4, unrealized: 0.25 } as const;
const events: PriorEvent[] = [];
const sources: string[] = [];

function add(ev: Omit<PriorEvent, 'weight'> & { weight?: number }) {
  events.push({ ...ev, weight: ev.weight ?? W[ev.quality] });
}

function kindOf(reason: string): string {
  const r = (reason || '').toLowerCase();
  if (r.includes('take profit')) return 'take_profit';
  if (r.includes('trail')) return 'trailing_stop';
  if (r.includes('stop')) return 'hard_stop';
  if (r.includes('momentum')) return 'momentum_fade';
  if (r.includes('stale')) return 'stale_flat';
  return 'other';
}

// 1) Livetest SQLite (early live-market paper run, pre-realistic default — mark weight)
const liveDb = join(ROOT, 'data-livetest/grokbot.db');
if (existsSync(liveDb)) {
  sources.push('data-livetest/grokbot.db');
  const db = new DatabaseSync(liveDb);
  const rows = db.prepare('SELECT j FROM trades').all() as { j: string }[];
  for (const row of rows) {
    const t = JSON.parse(row.j);
    const holdSec = t.closedAt && t.openedAt ? (t.closedAt - t.openedAt) / 1000 : 0;
    // Stops that overshot the printed -8% were likely mark-settled or high-impact.
    const slipped = /stop/i.test(t.reason || '') && (t.pnlPct || 0) < -10;
    add({
      source: 'livetest-sqlite', symbol: t.symbol, pattern: patternKey(t.entryPattern || t.reason || 'score'),
      pnlUsd: t.pnlUsd, pnlPct: t.pnlPct, costUsd: t.costUsd, holdSec,
      exitReason: t.reason || '', exitKind: kindOf(t.reason || ''),
      quality: slipped || /stop/i.test(t.reason || '') ? 'mark' : 'mark',
      score: t.score,
    });
  }
  const posRow = db.prepare("SELECT v FROM kv WHERE k='positions'").get() as { v: string } | undefined;
  if (posRow) {
    for (const p of JSON.parse(posRow.v) as any[]) {
      const last = p.lastPrice || p.peakPrice || p.entryPrice;
      const pnlPct = p.entryPrice ? (last / p.entryPrice - 1) * 100 : 0;
      const cost = p.costUsd || 0;
      if (!(cost > 0)) continue;
      add({
        source: 'livetest-open', symbol: p.symbol, pattern: patternKey(p.entryPattern || 'score'),
        pnlUsd: cost * pnlPct / 100, pnlPct, costUsd: cost, holdSec: 0,
        exitReason: 'unrealized', exitKind: 'unrealized', quality: 'unrealized', score: p.score,
      });
    }
  }
  db.close();
}

// 2) Replay engine, realistic-quote TP (high weight)
async function harvestReplay(realistic: boolean, loops: number, startUsd: number): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'priors-'));
  const cfg = { ...DEFAULTS, startUsd, minScore: 35, minHolders: 50, minAgeMin: 1, minMcapUsd: 1000, minLiquidityUsd: 5000, cooldownMin: 1, scanIntervalSec: 9999, monitorIntervalSec: 9999, minTradeUsd: 0, realisticPaper: realistic };
  const m = new ReplayMarket(700);
  const e = new Engine(cfg, m, new Store(join(dir, 't.db')));
  await e.connect({ type: 'paper', startUsd });
  for (let i = 0; i < loops; i++) {
    await e.scan();
    await e.flushWork(600);
    await e.monitor();
    await e.flushWork(600);
  }
  const trades = e.store.trades();
  for (const t of trades) {
    const holdSec = t.closedAt && t.openedAt ? (t.closedAt - t.openedAt) / 1000 : 0;
    const reason = t.reason || '';
    const mark = /mark/i.test(reason);
    add({
      source: realistic ? 'replay-realistic' : 'replay-mark',
      symbol: t.symbol,
      pattern: patternKey(t.entryPattern || reason || 'score'),
      pnlUsd: t.pnlUsd, pnlPct: t.pnlPct, costUsd: t.costUsd, holdSec,
      exitReason: reason, exitKind: kindOf(reason),
      quality: mark || !realistic ? 'mark' : 'realistic',
      score: t.score,
    });
  }
  e.stop();
  return trades.length;
}

const nReal = await harvestReplay(true, 70, 81);
sources.push(`replay-realistic (${nReal} trades)`);
const nMark = await harvestReplay(false, 40, 81);
sources.push(`replay-mark (${nMark} trades)`);

// Pattern summary (weighted)
const map = new Map<PatternKey, { key: PatternKey; n: number; wins: number; losses: number; wr: number; expectancy: number; sumPnl: number; weightSum: number }>();
for (const ev of events) {
  const s = map.get(ev.pattern) || { key: ev.pattern, n: 0, wins: 0, losses: 0, wr: 0, expectancy: 0, sumPnl: 0, weightSum: 0 };
  const w = ev.weight;
  s.n += w;
  if (ev.pnlUsd > 0) s.wins += w; else s.losses += w;
  s.sumPnl += ev.pnlUsd * w;
  s.weightSum += w * ev.costUsd;
  map.set(ev.pattern, s);
}
const patterns = [...map.values()].map((s) => ({
  ...s,
  wr: s.n ? s.wins / s.n : 0,
  expectancy: s.weightSum > 0 ? s.sumPnl / s.weightSum : 0,
})).sort((a, b) => b.n - a.n);

// Winner/loser path templates from replay candidates we can still describe via typical winner shapes
// When a trade has no stored tape, synthesize a modest template from outcome:
const winnerPaths: PathVec[] = [
  { volAccel: 1.8, buyRatio: 0.62, chM5: 8, chM15: 14, buyers: 20 },
  { volAccel: 2.4, buyRatio: 0.72, chM5: 14, chM15: 22, buyers: 35 },
  { volAccel: 1.4, buyRatio: 0.58, chM5: 4, chM15: 9, buyers: 14 },
];
const loserPaths: PathVec[] = [
  { volAccel: 0.4, buyRatio: 0.28, chM5: -8, chM15: -14, buyers: 6 },
  { volAccel: 0.8, buyRatio: 0.35, chM5: -12, chM15: -6, buyers: 8 },
];
for (const ev of events) {
  if (ev.path) {
    if (ev.pnlUsd > 0) winnerPaths.push(ev.path);
    else if (ev.quality === 'realistic') loserPaths.push(ev.path);
  }
}
// de-dup near-identical templates
function uniq(list: PathVec[]): PathVec[] {
  const out: PathVec[] = [];
  for (const v of list) {
    if (out.some((u) => Math.abs(u.volAccel - v.volAccel) < 0.15 && Math.abs(u.buyRatio - v.buyRatio) < 0.05 && Math.abs(u.chM5 - v.chM5) < 3)) continue;
    out.push(v);
  }
  return out.slice(0, 24);
}

// Fast-TP winners (hold under 3 min, profit) vs quick stops inform stale window.
const fastWins = events.filter((e) => e.pnlUsd > 0 && e.holdSec > 0 && e.holdSec < 180 && e.quality === 'realistic');
const slowFlats = events.filter((e) => e.pnlUsd <= 0 && e.holdSec >= 90 && /trail|stale|time/i.test(e.exitReason));
const defaultSec = 105;

const priors: PaperPriors = {
  version: 1,
  builtAt: new Date().toISOString(),
  sources,
  weighting: { ...W },
  events,
  patterns,
  winnerPaths: uniq(winnerPaths.length ? winnerPaths : [{ volAccel: 1.8, buyRatio: 0.62, chM5: 8, chM15: 14, buyers: 20 }]),
  loserPaths: uniq(loserPaths),
  staleExit: { defaultSec, minSec: 90, maxSec: 180 },
};

const out = join(ROOT, 'server/paper-priors.json');
writeFileSync(out, JSON.stringify(priors, null, 2));
console.log(JSON.stringify({
  out,
  sources,
  events: events.length,
  patterns: patterns.map((p) => ({ key: p.key, n: +p.n.toFixed(2), wr: +p.wr.toFixed(3), exp: +p.expectancy.toFixed(3), pnl: +p.sumPnl.toFixed(2) })),
  winnerPaths: priors.winnerPaths.length,
  fastWins: fastWins.length,
  slowFlats: slowFlats.length,
}, null, 2));
