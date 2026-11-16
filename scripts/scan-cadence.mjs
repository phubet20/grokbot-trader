#!/usr/bin/env node
// Local live-data paper run that measures scan cadence (~10 min default).
// Never sends transactions. Usage: node --disable-warning=ExperimentalWarning scripts/scan-cadence.mjs [minutes] [usd] [outdir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const minutes = Number(process.argv[2] || 10);
const usd = Number(process.argv[3] || 10);
const outdir = process.argv[4] || join(tmpdir(), 'gb-scan-cadence');
mkdirSync(outdir, { recursive: true });
process.env.DATA_DIR = join(outdir, 'data');
process.env.MODE = 'paper';

const { DEFAULTS } = await import('../server/config.ts');
const { Engine } = await import('../server/engine.ts');
const { Store } = await import('../server/store.ts');
const { LiveMarket } = await import('../server/market.ts');

const cfg = { ...DEFAULTS, startUsd: usd, minTradeUsd: 0.25, scanIntervalSec: 6, monitorIntervalSec: 1 };
const e = new Engine(cfg, new LiveMarket(), new Store(join(outdir, 't.db')));
await e.connect({ type: 'paper', startUsd: usd });
await e.start();

const started = Date.now();
const end = started + minutes * 60_000;
const samples = [];
console.log(`[cadence] paper live-data $${usd} for ${minutes} min → ${outdir}`);

while (Date.now() < end) {
  const st = e.scanStatus();
  const s = e.stats();
  samples.push({ t: Date.now(), ...st, trades: s.trades, wins: s.wins, losses: s.losses, equity: s.equity, positions: e.positions.length, inFlightBuys: st.inFlightBuys, inFlightSells: st.inFlightSells });
  if (samples.length % 10 === 0) {
    console.log(`[${new Date().toISOString()}] lastAgo=${st.lastScanAgoSec?.toFixed?.(1)} cadenceMs=${st.cadenceMs} cpm=${st.candidatesPerMin} inflight=${st.inFlightChecks} trades=${s.trades} wr=${s.winRate} eq=$${s.equity.toFixed(2)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
e.stop();

const scans = samples.filter((x) => x.lastScanAt).map((x) => x.lastScanAt);
const unique = [...new Set(scans)].sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < unique.length; i++) gaps.push(unique[i] - unique[i - 1]);
gaps.sort((a, b) => a - b);
const pctile = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * (gaps.length - 1)))] : 0);
const stalled = gaps.filter((g) => g > 12_000); // > 2x the 6s interval, plus fetch slack
const s = e.stats();
const report = {
  minutes, startUsd: usd, expectedIntervalMs: 6000,
  scans: unique.length,
  cadenceMs: { p50: pctile(0.5), p95: pctile(0.95), max: gaps[gaps.length - 1] || 0, mean: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0 },
  stalledGapsOver12s: stalled.length,
  maxGapMs: gaps[gaps.length - 1] || 0,
  neverStalled: stalled.length === 0,
  trades: s.trades, wins: s.wins, losses: s.losses, winRate: s.winRate,
  equity: s.equity, pnlUsd: s.pnlUsd, pnlPct: s.pnlPct,
  endPositions: e.positions.length,
  startedAt: started, endedAt: Date.now(),
};
writeFileSync(join(outdir, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(outdir, 'samples.json'), JSON.stringify(samples));
console.log('[cadence] done', JSON.stringify(report, null, 2));
