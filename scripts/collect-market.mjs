#!/usr/bin/env node
// Live market tape collector. Public APIs only, no swaps, no funds.
// Usage: node --disable-warning=ExperimentalWarning scripts/collect-market.mjs [outdir] [sec]
import { mkdirSync, createWriteStream, appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const outdir = process.argv[2] || '/tmp/market-tape';
const intervalSec = Number(process.argv[3] || 8);
mkdirSync(outdir, { recursive: true });
process.env.DATA_DIR = join(outdir, 'tmp-data');

const { LiveMarket } = await import('../server/market.ts');
const market = new LiveMarket();
const file = join(outdir, 'tape.jsonl');
const metaFile = join(outdir, 'meta.json');
const seenSec = new Set();
let ticks = 0, written = 0, errors = 0;

function compact(c) {
  return {
    m: c.mint, s: c.symbol, p: c.pool, d: c.dex, px: +c.priceUsd.toFixed(10),
    mc: Math.round(c.mcapUsd), liq: Math.round(c.liquidityUsd),
    age: c.createdAt, src: c.source, q: c.quoteSymbol,
    ch: [+c.change.m5.toFixed(2), +c.change.m15.toFixed(2), +c.change.h1.toFixed(2), +c.change.h6.toFixed(2)],
    vo: [Math.round(c.volume.m5), Math.round(c.volume.h1)],
    tx: [c.txns.m5b, c.txns.m5s, c.txns.h1b, c.txns.h1s],
    tr: c.traders1h || 0,
  };
}

function writeMeta() {
  writeFileSync(metaFile, JSON.stringify({ ticks, written, errors, calls: market.calls, apiErrors: market.errors, lastError: market.lastError, started: started, updated: Date.now(), file }, null, 2));
}

const started = Date.now();
console.log(`[collect] -> ${file} every ${intervalSec}s`);
writeMeta();

async function tick() {
  const t = Date.now();
  try {
    const { list, scanned } = await market.candidates();
    // denser paths for reasonably liquid mints already seen
    const watch = [...new Set(list.filter((c) => c.liquidityUsd >= 8000).map((c) => c.mint))].slice(0, 25);
    if (watch.length && ticks % 2 === 1) {
      try {
        const extra = await market.pairs(watch);
        const have = new Set(list.map((c) => c.mint));
        for (const c of extra) if (!have.has(c.mint)) list.push(c);
      } catch {}
    }
    const row = { t, n: list.length, sc: scanned, c: list.map(compact) };
    appendFileSync(file, JSON.stringify(row) + '\n');
    written += list.length;
    ticks++;
    // light security sample for unseen mints (max 2 per tick to stay under RugCheck limits)
    const fresh = list.filter((c) => !seenSec.has(c.mint)).slice(0, 2);
    for (const c of fresh) {
      seenSec.add(c.mint);
      try {
        const sec = await market.security(c.mint);
        appendFileSync(join(outdir, 'security.jsonl'), JSON.stringify({ t, m: c.mint, sec }) + '\n');
      } catch {}
    }
    if (ticks % 5 === 0) {
      writeMeta();
      console.log(`[collect] ${new Date(t).toISOString()} ticks=${ticks} last=${list.length} totalRows=${written} apiErrors=${market.errors}`);
    }
  } catch (e) {
    errors++;
    console.error('[collect] tick fail', e.message || e);
    writeMeta();
  }
}

await tick();
const id = setInterval(tick, intervalSec * 1000);
const stop = () => { clearInterval(id); writeMeta(); console.log('[collect] stopped', ticks, 'ticks'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
