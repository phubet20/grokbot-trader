#!/usr/bin/env node
// Walk-forward tape backtester. One position at a time. No live orders.
// Usage: node --disable-warning=ExperimentalWarning scripts/backtest-tape.mjs [tape.jsonl] [opts]
// opts: --train-min=45 --valid-min=45 --start-usd=81 --params=path.json --grid
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { STRAT_DEFAULTS, entryReason, exitReason, momentumFadeStrict, toSnap } from '../server/strategy.ts';

const args = process.argv.slice(2);
const tapePath = args.find((a) => !a.startsWith('--')) || '/tmp/market-tape/tape.jsonl';
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const trainMin = Number(opt['train-min'] || 0);
const validMin = Number(opt['valid-min'] || 0);
const startUsd = Number(opt['start-usd'] || 81);
const sizePct = Number(opt['size-pct'] || 8);
const secPath = opt.security || '/tmp/market-tape/security.jsonl';
const requireSec = !!opt['require-security'];
const outPath = opt.out || '/tmp/market-tape/backtest.json';

function loadTape(path) {
  if (!existsSync(path)) return [];
  const ticks = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { ticks.push(JSON.parse(line)); } catch {}
  }
  return ticks;
}

function loadSec(path) {
  const m = new Map();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const s = r.sec || r;
      if (r.m) m.set(r.m, s);
    } catch {}
  }
  return m;
}

function securityOk(sec) {
  if (!sec) return !requireSec;
  if (sec.available === false) return false;
  if (sec.rugged) return false;
  if (sec.mintAuthority) return false;
  if (sec.freezeAuthority) return false;
  if (sec.topHolderPct != null && sec.topHolderPct > 25) return false;
  if (sec.top10Pct != null && sec.top10Pct > 60) return false;
  if (sec.holders != null && sec.holders < 40) return false;
  if (Array.isArray(sec.dangerRisks) && sec.dangerRisks.length) return false;
  return true;
}

function fillBuy(px, slip) { return px * (1 + slip / 100); }
function fillSell(px, slip) { return px * (1 - slip / 100); }

function slotN(equity, cash, reserve, minTrade, open, maxSlots = 10) {
  for (let n = maxSlots; n >= 1; n--) {
    if (open >= n) continue;
    const reserved = n * reserve;
    const tradable = equity - reserved;
    if (tradable < n * minTrade) continue;
    const size = tradable / n;
    if (cash < size + reserve) continue;
    return { n, size };
  }
  return { n: 0, size: 0 };
}

function simulate(ticks, params, t0, t1) {
  const hist = new Map();
  const meta = new Map();
  let cash = startUsd;
  const cooldown = new Map();
  const positions = []; // up to 10
  const trades = [];
  const equityCurve = [];
  let peakEq = startUsd, maxDd = 0;
  const reserve = 0.40; // ~ATA rent + fees in USD, locked per open slot, refunded on close
  const minTrade = 0.25;
  const maxSlots = 10;
  const dailyLossPct = 15;

  const equityNow = () => {
    let eq = cash;
    for (const pos of positions) {
      const last = (hist.get(pos.mint) || []).at(-1);
      eq += last ? pos.qty * last.px : pos.costUsd;
      eq += pos.remainRent || 0;
    }
    return eq;
  };

  const markEq = (t) => {
    const eq = equityNow();
    peakEq = Math.max(peakEq, eq);
    if (peakEq > 0) maxDd = Math.max(maxDd, (peakEq - eq) / peakEq * 100);
    equityCurve.push({ t, eq });
    return eq;
  };

  const close = (pos, px, t, kind, reason, fraction = 1) => {
    const fill = fillSell(px, params.exitSlipPct);
    const sellQty = pos.qty * fraction;
    const proceeds = sellQty * fill;
    cash += proceeds;
    pos.qty -= sellQty;
    const costCut = pos.costUsd * fraction;
    pos.costUsd -= costCut;
    if (fraction >= 0.999 || pos.qty <= 1e-9) {
      cash += pos.remainRent || 0;
      const totalPnl = ((pos.partialCash || 0) + proceeds) - pos.origCost;
      const pnlPct = pos.origCost ? (totalPnl / pos.origCost) * 100 : 0;
      cooldown.set(pos.mint, t + 3 * 60_000);
      trades.push({
        symbol: pos.symbol, mint: pos.mint, kind, reason,
        openedAt: pos.openedAt, closedAt: t,
        heldSec: (t - pos.openedAt) / 1000,
        pnlUsd: totalPnl, pnlPct,
        entry: pos.entryPrice, exit: fill,
        fromEntry: (fill / pos.entryPrice - 1) * 100,
      });
      const i = positions.indexOf(pos);
      if (i >= 0) positions.splice(i, 1);
    } else {
      pos.partialCash = (pos.partialCash || 0) + proceeds;
      pos.partialTaken = true;
      pos.breakeven = true;
      pos.costUsd = Math.max(0, pos.costUsd);
    }
  };

  const window = ticks.filter((x) => x.t >= t0 && x.t <= t1);
  for (const tick of window) {
    for (const c of tick.c || []) {
      const s = toSnap(tick.t, c);
      if (!s.px) continue;
      if (!hist.has(c.m)) hist.set(c.m, []);
      hist.get(c.m).push(s);
      if (!meta.has(c.m)) meta.set(c.m, { symbol: c.s, mint: c.m, quote: c.q });
    }
    for (const pos of [...positions]) {
      const h = hist.get(pos.mint) || [];
      const last = h.at(-1);
      if (!last) continue;
      pos.peakPrice = Math.max(pos.peakPrice, last.px);
      const fade = momentumFadeStrict(last);
      const ex = exitReason(pos, last.px, params, tick.t, fade.exit, fade.reason);
      pos.peakPrice = ex.peak;
      if (ex.exit) close(pos, last.px, tick.t, ex.kind, ex.reason, ex.partial ? params.partialPct / 100 : 1);
    }
    const eq = equityNow();
    const dayDd = startUsd > 0 ? ((startUsd - eq) / startUsd) * 100 : 0;
    const held = new Set(positions.map((p) => p.mint));
    if (dayDd < dailyLossPct && positions.length < maxSlots) {
      const cands = [];
      for (const [mint, h] of hist) {
        if (held.has(mint)) continue;
        const last = h.at(-1);
        if (!last || last.t !== tick.t) continue;
        const info = meta.get(mint);
        if (info?.quote && !['SOL', 'WSOL', 'USDC', 'USDT'].includes(String(info.quote).toUpperCase())) continue;
        if (params._sec && !securityOk(params._sec.get(mint))) continue;
        if ((cooldown.get(mint) || 0) > tick.t) continue;
        const e = entryReason(h, params, tick.t);
        if (!e.ok) continue;
        const score = last.m15 + last.m5 * 0.5 + buyR(last) * 10;
        cands.push({ mint, last, reason: e.reason, score });
      }
      cands.sort((a, b) => b.score - a.score);
      for (const best of cands) {
        if (positions.length >= maxSlots) break;
        const { n, size } = slotN(equityNow(), cash, reserve, minTrade, positions.length, maxSlots);
        if (!n || size < minTrade) break;
        const fill = fillBuy(best.last.px, params.entrySlipPct);
        const qty = size / fill;
        cash -= size + reserve;
        if (cash < 0) { cash += size + reserve; break; }
        held.add(best.mint);
        positions.push({
          mint: best.mint, symbol: meta.get(best.mint)?.symbol || best.mint.slice(0, 6),
          entryPrice: fill, peakPrice: fill, openedAt: tick.t, qty,
          costUsd: size, origCost: size, remainRent: reserve,
          partialTaken: false, breakeven: false, partialCash: 0,
        });
      }
    }
    markEq(tick.t);
  }
  for (const pos of [...positions]) {
    const last = (hist.get(pos.mint) || []).at(-1);
    if (last) close(pos, last.px, last.t, 'time_stop', 'end of window', 1);
  }
  const pnl = (equityCurve.at(-1)?.eq ?? startUsd) - startUsd;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
  const wr = trades.length ? (wins.length / trades.length) * 100 : 0;
  const exp = trades.length ? (wr / 100) * avgWin + (1 - wr / 100) * avgLoss : 0;
  const hard = trades.filter((t) => t.kind === 'hard_stop');
  const slip = hard.map((t) => Math.max(0, Math.abs(t.pnlPct) - params.hardStopPct));
  const worstSlip = slip.length ? Math.max(...slip) : 0;
  const avgSlip = slip.length ? slip.reduce((a, b) => a + b, 0) / slip.length : 0;
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: wr, avgWinPct: avgWin, avgLossPct: avgLoss, expectancyPct: exp,
    pnlUsd: pnl, pnlPct: startUsd ? (pnl / startUsd) * 100 : 0,
    maxDd, worstStopSlip: worstSlip, avgHardSlip: avgSlip,
    kinds: tally(trades.map((t) => t.kind)),
    tradeList: trades,
    startUsd, endUsd: startUsd + pnl,
  };
}

function buyR(s) { const t = s.b5 + s.s5; return t ? s.b5 / t : 0; }
function tally(xs) { const m = {}; for (const x of xs) m[x] = (m[x] || 0) + 1; return m; }

function applyPatch(base, patch) { return { ...base, ...patch }; }

const ticks = loadTape(tapePath);
if (!ticks.length) { console.log('no tape yet'); process.exit(2); }
const tFirst = ticks[0].t, tLast = ticks.at(-1).t;
const spanMin = (tLast - tFirst) / 60_000;
const sec = loadSec(secPath);
let params = { ...STRAT_DEFAULTS, _sec: sec };
if (opt.params && existsSync(opt.params)) params = { ...params, ...JSON.parse(readFileSync(opt.params, 'utf8')), _sec: sec };

// default split: first half train, rest valid, unless specified
let trainEnd, validStart, validEnd;
if (trainMin > 0) {
  trainEnd = tFirst + trainMin * 60_000;
  validStart = trainEnd;
  validEnd = validMin > 0 ? validStart + validMin * 60_000 : tLast;
} else if (spanMin >= 30) {
  const mid = tFirst + (tLast - tFirst) * 0.45;
  trainEnd = mid; validStart = mid; validEnd = tLast;
} else {
  trainEnd = tLast; validStart = tFirst; validEnd = tLast; // too short; report as in-sample only
}

const grid = !!opt.grid;
let best = null;
const tried = [];
const gridPatches = grid ? buildGrid() : [{}];

function buildGrid() {
  // Tightness profiles from "fill slots immediately" to "more selective".
  // Pullback/impulse stays off on the faster profiles so entries do not wait.
  const profiles = [
    { name: 'fast', minHistTicks: 1, minImpulsePct: 0, pullbackMinPct: 0, pullbackMaxPct: 100, minAgeMin: 1, maxAgeHours: 72, minLiq: 8000, minTraders: 12, minBuyRatio5: 0.52, maxBuyRatio5: 0.95, minTx5: 6, minM15: 0, minM5: -3, maxM5: 28, maxH1: 90, maxTickVolPct: 20, minLiqGrowthPct: -50 },
    { name: 'balanced', minHistTicks: 1, minImpulsePct: 0, pullbackMinPct: 0, pullbackMaxPct: 100, minAgeMin: 3, maxAgeHours: 48, minLiq: 12000, minTraders: 20, minBuyRatio5: 0.55, maxBuyRatio5: 0.93, minTx5: 8, minM15: 1, minM5: -2, maxM5: 18, maxH1: 70, maxTickVolPct: 12, minLiqGrowthPct: -25 },
    { name: 'selective', minHistTicks: 2, minImpulsePct: 2, pullbackMinPct: 0.8, pullbackMaxPct: 9, minAgeMin: 8, maxAgeHours: 36, minLiq: 18000, minTraders: 30, minBuyRatio5: 0.58, maxBuyRatio5: 0.92, minTx5: 10, minM15: 2, minM5: -1, maxM5: 12, maxH1: 50, maxTickVolPct: 8, minLiqGrowthPct: -10 },
  ];
  const out = [];
  for (const prof of profiles) for (const tp of [3, 4.5, 6]) for (const st of [3, 4, 5]) {
    out.push({
      ...prof,
      takeProfitPct: tp, hardStopPct: st, breakevenAtPct: Math.min(2, tp - 1.2),
    });
  }
  return out;
}

function score(r) {
  if (r.trades < 5) return -999 + r.trades;
  // Prefer WR>80 with positive expectancy; never reward negative expectancy.
  const wr = r.winRate, exp = r.expectancyPct;
  if (exp <= 0) return wr * 0.05 + exp * 2;
  const wrBonus = wr > 80 ? 25 : 0;
  return wr + exp * 8 + Math.min(r.trades, 40) * 0.15 + wrBonus;
}
for (const patch of gridPatches) {
  const p = applyPatch(params, patch);
  const train = simulate(ticks, p, tFirst, trainEnd);
  const valid = simulate(ticks, p, validStart, validEnd);
  const s = score(train);
  tried.push({ name: patch.name, patch, train: slim(train), validation: slim(valid), score: s });
  if (!best || s > best.score) best = { patch, train, score: s, params: p };
}

function slim(r) {
  const { tradeList, ...rest } = r;
  return rest;
}

const chosen = best.params;
const validation = simulate(ticks, chosen, validStart, validEnd);
const all = simulate(ticks, chosen, tFirst, tLast);
const report = {
  tape: { ticks: ticks.length, spanMin: +spanMin.toFixed(1), tFirst, tLast },
  split: { trainMin: +((trainEnd - tFirst) / 60_000).toFixed(1), validMin: +((validEnd - validStart) / 60_000).toFixed(1), inSampleOnly: spanMin < 30 && !(trainMin > 0) },
  params: Object.fromEntries(Object.entries(chosen).filter(([k]) => k !== '_sec')),
  train: slim(best.train),
  validation: { ...slim(validation), tradeList: validation.tradeList },
  all: slim(all),
  gridTried: grid ? tried.length : 0,
  tradeoff: tried.map((x) => ({
    name: x.name, tp: x.patch.takeProfitPct, stop: x.patch.hardStopPct,
    train: x.train, validation: x.validation, score: x.score,
  })),
};
writeFileSync(outPath, JSON.stringify(report, null, 2));
const v = report.validation;
console.log(JSON.stringify({
  spanMin: report.tape.spanMin, ticks: report.tape.ticks,
  inSampleOnly: report.split.inSampleOnly,
  train: report.train,
  validation: slim(v),
  params: report.params,
}, null, 2));
