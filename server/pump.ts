// Pump.fun bonding-curve math + PumpPortal live feed (free: new tokens & migrations).
// subscribeTokenTrade is paid (API key + 0.02 SOL) — we do not use it.
export const PUMP_VIRTUAL_SOL = 30;
export const PUMP_VIRTUAL_TOKENS = 1_073_000_000;
export const PUMP_REAL_TOKENS = 793_100_000; // tokens sold at graduation
export const PUMP_FEE = 0.01;
export const PUMP_K = PUMP_VIRTUAL_SOL * PUMP_VIRTUAL_TOKENS;

import type { Candidate } from './types.ts';
import type { Quote } from './market.ts';
import { SOL_MINT } from './market.ts';

export type PumpToken = {
  mint: string;
  symbol: string;
  name: string;
  image?: string;
  dev: string;
  createdAt: number;
  vSol: number;
  vTokens: number;
  graduated: boolean;
  graduatedAt: number;
  initialBuy: number;
  initialSol: number;
  pool: string;
  lastEventAt: number;
};

export function curveProgress(vTokens: number, vSol: number): number {
  const fromTok = (PUMP_VIRTUAL_TOKENS - vTokens) / PUMP_REAL_TOKENS;
  const fromSol = (vSol - PUMP_VIRTUAL_SOL) / 85;
  const p = Math.max(fromTok, fromSol);
  return Math.max(0, Math.min(1, p));
}

export function priceSol(vSol: number, vTokens: number): number {
  if (vTokens <= 0) return 0;
  return vSol / vTokens;
}

/** Buy `solIn` (UI SOL) on the curve. Returns tokens out and new reserves. */
export function curveBuy(vSol: number, vTokens: number, solIn: number): { tokensOut: number; vSol: number; vTokens: number; impactPct: number } {
  const sol = solIn * (1 - PUMP_FEE);
  if (sol <= 0 || vSol <= 0 || vTokens <= 0) return { tokensOut: 0, vSol, vTokens, impactPct: 100 };
  const k = vSol * vTokens;
  const newSol = vSol + sol;
  const newTok = k / newSol;
  const tokensOut = Math.max(0, vTokens - newTok);
  const mid = priceSol(vSol, vTokens);
  const fill = solIn > 0 ? solIn / Math.max(tokensOut, 1e-12) : mid;
  const impactPct = mid > 0 ? Math.max(0, (fill / mid - 1) * 100) : 0;
  return { tokensOut, vSol: newSol, vTokens: newTok, impactPct };
}

/** Sell `tokensIn` (UI tokens) on the curve. Returns SOL out (after fee). */
export function curveSell(vSol: number, vTokens: number, tokensIn: number): { solOut: number; vSol: number; vTokens: number; impactPct: number } {
  if (tokensIn <= 0 || vSol <= 0 || vTokens <= 0) return { solOut: 0, vSol, vTokens, impactPct: 100 };
  const k = vSol * vTokens;
  const newTok = vTokens + tokensIn;
  const newSol = k / newTok;
  const raw = Math.max(0, vSol - newSol);
  const solOut = raw * (1 - PUMP_FEE);
  const mid = priceSol(vSol, vTokens);
  const fill = tokensIn > 0 ? solOut / tokensIn : mid;
  const impactPct = mid > 0 ? Math.max(0, (1 - fill / mid) * 100) : 0;
  return { solOut, vSol: newSol, vTokens: newTok, impactPct };
}

export function curveQuote(t: PumpToken, inputMint: string, outputMint: string, amountRaw: bigint, solPrice: number): Quote | null {
  if (t.graduated) return null;
  const dec = 6;
  if (inputMint === SOL_MINT && outputMint === t.mint) {
    const solIn = Number(amountRaw) / 1e9;
    const r = curveBuy(t.vSol, t.vTokens, solIn);
    if (r.tokensOut <= 0) return null;
    return { inAmount: Number(amountRaw), outAmount: Math.floor(r.tokensOut * 10 ** dec), priceImpactPct: r.impactPct, route: 'pump-curve' };
  }
  if (inputMint === t.mint && outputMint === SOL_MINT) {
    const tokensIn = Number(amountRaw) / 10 ** dec;
    const r = curveSell(t.vSol, t.vTokens, tokensIn);
    if (r.solOut <= 0) return null;
    return { inAmount: Number(amountRaw), outAmount: Math.floor(r.solOut * 1e9), priceImpactPct: r.impactPct, route: 'pump-curve' };
  }
  return null;
}

export type PumpFeedStatus = {
  reachable: boolean;
  connected: boolean;
  lastEventAt: number;
  creates: number;
  migrations: number;
  tracked: number;
  lastError: string;
  tradeStream: 'paid-skipped';
};

export class PumpFeed {
  status: PumpFeedStatus = { reachable: false, connected: false, lastEventAt: 0, creates: 0, migrations: 0, tracked: 0, lastError: '', tradeStream: 'paid-skipped' };
  tokens = new Map<string, PumpToken>();
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 2000;
  private timer: ReturnType<typeof setTimeout> | null = null;

  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private connect() {
    if (this.stopped) return;
    try {
      const ws = new WebSocket('wss://pumpportal.fun/api/data');
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.status.connected = true;
        this.status.reachable = true;
        this.status.lastError = '';
        this.backoff = 2000;
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      });
      ws.addEventListener('message', (ev) => this.onMsg(String((ev as MessageEvent).data)));
      ws.addEventListener('error', () => { this.status.lastError = 'ws error'; });
      ws.addEventListener('close', () => {
        this.status.connected = false;
        this.ws = null;
        if (this.stopped) return;
        const wait = this.backoff;
        this.backoff = Math.min(30_000, this.backoff * 1.6);
        this.timer = setTimeout(() => this.connect(), wait);
      });
    } catch (e: any) {
      this.status.lastError = e?.message || String(e);
      this.timer = setTimeout(() => this.connect(), this.backoff);
    }
  }

  private onMsg(raw: string) {
    let j: any;
    try { j = JSON.parse(raw); } catch { return; }
    if (j?.message) {
      if (/successfully subscribed|subscribed to/i.test(j.message)) this.status.reachable = true;
      if (/api key/i.test(j.message)) this.status.lastError = 'trade stream requires a paid PumpPortal key (skipped)';
      return;
    }
    const mint = j.mint || j.token || '';
    if (!mint) return;
    this.status.lastEventAt = Date.now();
    const tx = String(j.txType || j.type || '');
    if (tx === 'create' || (j.vTokensInBondingCurve && !this.tokens.has(mint))) {
      this.status.creates++;
      const t: PumpToken = {
        mint, symbol: j.symbol || '?', name: j.name || j.symbol || '?',
        dev: j.traderPublicKey || j.dev || '',
        createdAt: Date.now(),
        vSol: num(j.vSolInBondingCurve) || PUMP_VIRTUAL_SOL,
        vTokens: num(j.vTokensInBondingCurve) || PUMP_VIRTUAL_TOKENS,
        graduated: false, graduatedAt: 0,
        initialBuy: num(j.initialBuy), initialSol: num(j.solAmount),
        pool: j.bondingCurveKey || j.pool || mint,
        lastEventAt: Date.now(),
      };
      this.tokens.set(mint, t);
    } else if (tx === 'migration' || tx === 'migrate' || j.pool === 'pump-amm' || j.pool === 'pumpswap' || j.pool === 'raydium') {
      this.status.migrations++;
      const t = this.tokens.get(mint) || {
        mint, symbol: j.symbol || '?', name: j.name || j.symbol || '?', dev: j.traderPublicKey || '',
        createdAt: Date.now(), vSol: 0, vTokens: 0, graduated: true, graduatedAt: Date.now(),
        initialBuy: 0, initialSol: 0, pool: j.pool || mint, lastEventAt: Date.now(),
      };
      t.graduated = true;
      t.graduatedAt = t.graduatedAt || Date.now();
      t.lastEventAt = Date.now();
      if (j.symbol) t.symbol = j.symbol;
      this.tokens.set(mint, t);
    } else if (this.tokens.has(mint) && (j.vSolInBondingCurve || j.vTokensInBondingCurve)) {
      const t = this.tokens.get(mint)!;
      if (j.vSolInBondingCurve) t.vSol = num(j.vSolInBondingCurve);
      if (j.vTokensInBondingCurve) t.vTokens = num(j.vTokensInBondingCurve);
      t.lastEventAt = Date.now();
    }
    this.gc();
    this.status.tracked = this.tokens.size;
  }

  private gc() {
    const now = Date.now();
    for (const [m, t] of this.tokens) {
      if (now - t.lastEventAt > 6 * 3600_000) this.tokens.delete(m);
    }
    if (this.tokens.size > 400) {
      const oldest = [...this.tokens.values()].sort((a, b) => a.lastEventAt - b.lastEventAt);
      for (const t of oldest.slice(0, this.tokens.size - 400)) this.tokens.delete(t.mint);
    }
  }

  get(mint: string) { return this.tokens.get(mint); }

  toCandidates(solPrice: number, now = Date.now()): Candidate[] {
    const out: Candidate[] = [];
    for (const t of this.tokens.values()) {
      if (now - t.lastEventAt > 90 * 60_000 && !t.graduated) continue;
      const pxSol = t.graduated ? 0 : priceSol(t.vSol, t.vTokens);
      const priceUsd = pxSol * solPrice;
      const progress = t.graduated ? 1 : curveProgress(t.vTokens, t.vSol);
      const supply = 1_000_000_000;
      const mcap = priceUsd * supply;
      const liq = t.graduated ? 0 : t.vSol * 2 * solPrice;
      const devHoldPct = t.initialBuy > 0 ? (t.initialBuy / supply) * 100 : 0;
      const ageMin = (now - t.createdAt) / 60_000;
      // Fresh create has little history; expose initial buy as a 5m print so flow scoring can run.
      const b5 = t.initialSol > 0 || t.initialBuy > 0 ? 1 : 0;
      out.push({
        mint: t.mint, pool: t.pool, symbol: t.symbol, name: t.name, image: t.image,
        dex: t.graduated ? 'pumpswap' : 'pump',
        priceUsd, mcapUsd: mcap, liquidityUsd: liq, createdAt: t.createdAt,
        change: { m5: 0, m15: 0, h1: 0, h6: 0, h24: 0 },
        volume: { m5: t.initialSol * solPrice, h1: t.initialSol * solPrice, h6: 0, h24: 0 },
        txns: { m5b: b5, m5s: 0, h1b: b5, h1s: 0, h24b: b5, h24s: 0 },
        traders1h: b5, quoteSymbol: 'SOL', source: 'pumpportal',
        curve: { progress, vSol: t.vSol, vTokens: t.vTokens, graduated: t.graduated },
        flow: {
          netBuySol: t.initialSol, largeBuys: t.initialSol >= 0.5 ? 1 : 0, largeSells: 0,
          uniqueBuyers: b5, uniqueSellers: 0,
          whaleBuyUsd: t.initialSol * solPrice,
          bundled: t.initialSol >= 2.5 && ageMin < 3,
          devPubkey: t.dev, devHoldPct, devSold: false,
          progress, progressVel: ageMin > 0 ? progress / Math.max(ageMin, 0.05) : progress / 0.05,
        },
      });
    }
    return out;
  }
}

const num = (x: any) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

let singleton: PumpFeed | null = null;
export function getPumpFeed(): PumpFeed {
  if (!singleton) singleton = new PumpFeed();
  return singleton;
}

/** Merge richer Dex/GT prints onto a pump candidate (keep curve + flow). */
export function mergePumpOnto(base: Candidate, pump: Candidate): Candidate {
  const flow = { ...(pump.flow || {}), ...(base.flow || {}) };
  if ((base.txns.m5b + base.txns.h1b) > (pump.txns.m5b + pump.txns.h1b)) {
    flow.uniqueBuyers = Math.max(flow.uniqueBuyers || 0, base.traders1h || 0);
    const net = (base.volume.m5 || 0) * ((base.txns.m5b - base.txns.m5s) / Math.max(1, base.txns.m5b + base.txns.m5s));
    flow.netBuySol = Math.max(flow.netBuySol || 0, 0);
    flow.netBuyUsd = net;
  }
  return {
    ...pump, ...base,
    source: base.source,
    dex: pump.curve?.graduated ? (base.dex || 'pumpswap') : (pump.dex || base.dex),
    createdAt: Math.min(base.createdAt || pump.createdAt, pump.createdAt || base.createdAt),
    curve: pump.curve || base.curve,
    flow,
    priceUsd: base.priceUsd || pump.priceUsd,
    liquidityUsd: base.liquidityUsd || pump.liquidityUsd,
    mcapUsd: base.mcapUsd || pump.mcapUsd,
  };
}
