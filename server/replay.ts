// REPLAY / MOCK market: deterministic synthetic Solana meme market used when
// live APIs are unreachable (DATA_SOURCE=replay) and by tests. Same interface
// as LiveMarket. Prices follow a random walk with occasional pumps and rugs.
import type { Candidate, TokenSecurity } from './types.ts';
import type { MarketSource, Quote, Candle } from './market.ts';
import { SOL_MINT } from './market.ts';

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const NAMES = ['CAT3', 'TRASHCAN', 'STONEFACE', 'FROINK', 'LMAO', 'HOUSECOIN', 'BEER', 'CPU', 'DUBBLE', 'INVERSE', 'FLOAT', 'DOGTHINK', 'GROKBOT', 'SUNSETJET', 'TRENCH', 'CHILLOWEEN', 'CATBOT', 'GATO', 'SLINGFOLIO', 'Alice', 'HODL', 'ARNOLD', 'scamsem', 'COGE', 'SI276'];

type Sim = { mint: string; pool: string; symbol: string; createdAt: number; price: number; liq: number; supply: number; hist: { t: number; p: number; v: number; b: number; s: number }[]; drift: number; bad: boolean };

export class ReplayMarket implements MarketSource {
  name = 'replay';
  calls: Record<string, number> = { replay: 0 };
  errors = 0;
  lastError = '';
  private r = rng(42);
  private sims: Sim[] = [];
  private solPrice = 170;
  private lastStep = Date.now();
  private speed: number;

  constructor(speed = 1) {
    this.speed = speed;
    const now = Date.now();
    NAMES.forEach((n, i) => {
      const mint = `Rep${i.toString().padStart(2, '0')}${'x'.repeat(30)}${i}`.slice(0, 44);
      const s: Sim = { mint, pool: 'pool' + mint.slice(3), symbol: n, createdAt: now - (20 + this.r() * 600) * 60_000, price: 0.00001 + this.r() * 0.002, liq: 25_000 + this.r() * 300_000, supply: 1e9, hist: [], drift: (this.r() - 0.45) * 0.004, bad: this.r() < 0.25 };
      // 2h of 1-min backfill
      let p = s.price;
      for (let k = 120; k > 0; k--) { p *= 1 + (this.r() - 0.5) * 0.04 + s.drift; s.hist.push({ t: now - k * 60_000, p, v: 500 + this.r() * 5000, b: 5 + Math.floor(this.r() * 30), s: 5 + Math.floor(this.r() * 25) }); }
      s.price = p;
      this.sims.push(s);
    });
  }

  /** advance the simulation to "now" in 1-minute (scaled) steps */
  step() {
    const now = Date.now();
    const stepMs = 60_000 / this.speed;
    while (now - this.lastStep >= stepMs) {
      this.lastStep += stepMs;
      const t = this.sims[0].hist[this.sims[0].hist.length - 1].t + 60_000;
      for (const s of this.sims) {
        let ch = (this.r() - 0.5) * 0.05 + s.drift;
        if (this.r() < 0.02) ch += 0.15 + this.r() * 0.4;  // pump
        if (s.bad && this.r() < 0.01) ch -= 0.6;           // rug
        if (this.r() < 0.05) s.drift = (this.r() - 0.45) * 0.006;
        s.price = Math.max(1e-9, s.price * (1 + ch));
        const b = 5 + Math.floor(this.r() * 40 * (ch > 0 ? 1.5 : 0.8)), sl = 5 + Math.floor(this.r() * 35 * (ch < 0 ? 1.5 : 0.8));
        s.hist.push({ t, p: s.price, v: (b + sl) * (50 + this.r() * 200), b, s: sl });
        if (s.hist.length > 600) s.hist.shift();
      }
      this.solPrice *= 1 + (this.r() - 0.5) * 0.002;
    }
  }

  private stats(s: Sim) {
    const h = s.hist, n = h.length, P = s.price;
    const back = (m: number) => h[Math.max(0, n - 1 - m)].p;
    const sum = (m: number, f: (x: any) => number) => h.slice(-m).reduce((a, x) => a + f(x), 0);
    return { P, ch: (m: number) => (P / back(m) - 1) * 100, sum };
  }

  async candidates() {
    this.step(); this.calls.replay++;
    const list: Candidate[] = this.sims.map((s) => {
      const { P, ch, sum } = this.stats(s);
      return {
        mint: s.mint, pool: s.pool, symbol: s.symbol, name: s.symbol + ' (replay)', dex: 'replay', priceUsd: P, mcapUsd: P * s.supply, liquidityUsd: s.liq,
        createdAt: s.createdAt, change: { m5: ch(5), m15: ch(15), h1: ch(60), h6: ch(360), h24: ch(1440) },
        volume: { m5: sum(5, (x) => x.v), h1: sum(60, (x) => x.v), h6: sum(360, (x) => x.v), h24: sum(1440, (x) => x.v) },
        txns: { m5b: sum(5, (x) => x.b), m5s: sum(5, (x) => x.s), h1b: sum(60, (x) => x.b), h1s: sum(60, (x) => x.s), h24b: sum(600, (x) => x.b), h24s: sum(600, (x) => x.s) },
        traders1h: Math.round(sum(60, (x) => x.b + x.s) * 0.5), quoteSymbol: 'SOL', source: 'replay',
      };
    });
    return { list, scanned: list.length };
  }

  async security(mint: string): Promise<TokenSecurity | null> {
    const s = this.sims.find((x) => x.mint === mint);
    if (!s) return null;
    return { mintAuthority: s.bad && s.symbol.length % 2 ? 'Auth111' : null, freezeAuthority: null, holders: s.bad ? 120 : 800 + Math.round(s.liq / 100), topHolderPct: s.bad ? 35 : 6, top10Pct: s.bad ? 70 : 28, dangerRisks: [], rugged: false, fetchedAt: Date.now(), available: true };
  }

  async prices(mints: string[]) {
    this.step(); this.calls.replay++;
    const out: Record<string, number> = {};
    for (const m of mints) {
      if (m === SOL_MINT) out[m] = this.solPrice;
      const s = this.sims.find((x) => x.mint === m);
      if (s) out[m] = s.price;
    }
    return out;
  }

  async decimals(mint: string) { return mint === SOL_MINT ? 9 : 6; }

  async quote(inputMint: string, outputMint: string, amountRaw: bigint, _slip: number): Promise<Quote | null> {
    this.step(); this.calls.replay++;
    const amt = Number(amountRaw);
    if (inputMint === SOL_MINT) {
      const s = this.sims.find((x) => x.mint === outputMint); if (!s) return null;
      const usd = (amt / 1e9) * this.solPrice, impact = usd / s.liq * 100 * 2;
      const tokens = (usd / s.price) * (1 - impact / 100) * (1 - 0.0025);
      return { inAmount: amt, outAmount: Math.floor(tokens * 1e6), priceImpactPct: impact, route: 'Replay AMM' };
    }
    const s = this.sims.find((x) => x.mint === inputMint); if (!s) return null;
    const usd = (amt / 1e6) * s.price, impact = usd / s.liq * 100 * 2;
    const sol = (usd / this.solPrice) * (1 - impact / 100) * (1 - 0.0025);
    return { inAmount: amt, outAmount: Math.floor(sol * 1e9), priceImpactPct: impact, route: 'Replay AMM' };
  }

  async ohlcv(pool: string, tf: string): Promise<Candle[]> {
    const s = this.sims.find((x) => x.pool === pool); if (!s) return [];
    const agg = ({ '1m': 1, '5m': 5, '15m': 15, '1h': 60 } as Record<string, number>)[tf] || 1;
    const out: Candle[] = [];
    let prev = s.hist[0].p;
    for (let i = 0; i < s.hist.length; i += agg) {
      const ch = s.hist.slice(i, i + agg);
      const ps = ch.map((x) => x.p);
      out.push([Math.floor(ch[0].t / 1000), prev, Math.max(prev, ...ps), Math.min(prev, ...ps), ps[ps.length - 1], ch.reduce((a, x) => a + x.v, 0)]);
      prev = ps[ps.length - 1];
    }
    return out.slice(-120);
  }
}
