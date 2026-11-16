#!/usr/bin/env node
// Paper-only market run. Never sends transactions.
// Usage: node --disable-warning=ExperimentalWarning scripts/paper-run.mjs <replay|live> <usd> [minutes] [outdir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const kind = process.argv[2] || 'replay';
const usd = Number(process.argv[3] || 10);
const minutes = Number(process.argv[4] || 8);
const outdir = process.argv[5] || join(tmpdir(), `gb-run-${kind}-${usd}`);
mkdirSync(outdir, { recursive: true });
process.env.DATA_DIR = join(outdir, 'data');
process.env.MODE = 'paper';

const { DEFAULTS } = await import('../server/config.ts');
const { Engine } = await import('../server/engine.ts');
const { Store } = await import('../server/store.ts');
const { ReplayMarket } = await import('../server/replay.ts');
const { LiveMarket } = await import('../server/market.ts');

const cfg = {
  ...DEFAULTS,
  startUsd: usd,
  minTradeUsd: 0.25,
  scanIntervalSec: kind === 'live' ? 6 : 9999,
  monitorIntervalSec: kind === 'live' ? 1 : 9999,
};
const market = kind === 'live' ? new LiveMarket() : new ReplayMarket(usd * 80 + Date.now() % 999);
const e = new Engine(cfg, market, new Store(join(outdir, 't.db')));
await e.connect({ type: 'paper', startUsd: usd });

const started = Date.now();
const end = started + minutes * 60_000;
let ticks = 0;
console.log(`[paper-run] ${kind} $${usd} for ${minutes} min → ${outdir}`);

while (Date.now() < end) {
  ticks++;
  try { await e.scan(); } catch (err) { console.error('scan', err.message); }
  try { await e.monitor(); } catch (err) { console.error('monitor', err.message); }
  if (kind === 'replay') await new Promise((r) => setTimeout(r, 80));
  else await new Promise((r) => setTimeout(r, 900));
  if (ticks % 20 === 0) {
    const s = e.stats();
    console.log(`[${new Date().toISOString()}] eq=$${s.equity.toFixed(2)} trades=${s.closed} wr=${Number(s.winRate).toFixed(0)}% pnl=$${s.pnlUsd.toFixed(2)}`);
  }
}

e.stop();
const s = e.stats();
function tradeKind(t) {
  if (t.kind) return t.kind;
  const r = String(t.reason || '');
  if (/momentum/i.test(r)) return 'momentum_fade';
  if (/time stop|max hold/i.test(r)) return 'time_stop';
  if (/trailing/i.test(r)) return 'trailing_stop';
  if (/% stop|hard/i.test(r)) return 'hard_stop';
  return 'unknown';
}
const trades = e.store.trades(500).map((t) => ({ ...t, kind: tradeKind(t), heldSec: t.heldSec ?? (t.closedAt && t.openedAt ? (t.closedAt - t.openedAt) / 1000 : 0) }));
const holds = trades.map((t) => t.heldSec).filter((n) => Number.isFinite(n));
const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
const hard = trades.filter((t) => t.kind === 'hard_stop');
const slip = hard.map((t) => Math.max(0, Math.abs(t.pnlPct || 0) - 5)); // extra loss past the -5% hard stop
const avgSlip = slip.length ? slip.reduce((a, b) => a + b, 0) / slip.length : 0;
const eqCurve = (typeof e.store.equity === 'function' ? e.store.equity(0) : []).map((x) => x.usd);
let peak = usd, maxDd = 0;
for (const v of eqCurve) { if (v > peak) peak = v; if (peak) maxDd = Math.max(maxDd, (peak - v) / peak * 100); }
maxDd = Math.max(maxDd, s.deposit ? Math.max(0, (s.deposit - s.equity) / s.deposit * 100) : 0);
const report = {
  kind, startUsd: usd, minutes, ticks,
  equity: s.equity, pnl: s.pnlUsd, pnlPct: s.pnlPct, trades: s.closed,
  wins: s.wins, losses: s.losses, winRate: s.winRate, maxDd,
  avgHoldSec: +avgHold.toFixed(1),
  hardStops: hard.length, trailing: trades.filter((t) => t.kind === 'trailing_stop').length,
  momentumFade: trades.filter((t) => t.kind === 'momentum_fade').length,
  timeStops: trades.filter((t) => t.kind === 'time_stop').length,
  avgHardStopSlippagePct: +avgSlip.toFixed(2),
  endPositions: e.positions.length,
  tradesOut: trades.map((t) => ({ symbol: t.symbol, kind: t.kind, pnlUsd: t.pnlUsd, pnlPct: t.pnlPct, heldSec: t.heldSec })),
};
writeFileSync(join(outdir, 'report.json'), JSON.stringify(report, null, 2));
console.log('[paper-run] done', JSON.stringify({ ...report, tradesOut: undefined }, null, 2));
process.exit(0);
