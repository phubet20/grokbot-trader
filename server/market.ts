// Market data: GeckoTerminal + DexScreener (discovery), RugCheck (security),
// Jupiter (prices + swap quotes). All public, no API keys.
import type { Candidate, TokenSecurity } from './types.ts';
import { getPumpFeed, mergePumpOnto, curveQuote } from './pump.ts';
import { fetchMintAuthorities } from './reconcile.ts';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type Quote = { inAmount: number; outAmount: number; priceImpactPct: number; route: string; raw?: any };
export type Candle = [number, number, number, number, number, number]; // t(sec), o, h, l, c, v

export interface MarketSource {
  name: string;
  calls: Record<string, number>;
  errors: number;
  lastError: string;
  candidates(): Promise<{ list: Candidate[]; scanned: number }>;
  security(mint: string): Promise<TokenSecurity | null>;
  prices(mints: string[]): Promise<Record<string, number>>;
  quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<Quote | null>;
  decimals(mint: string): Promise<number>;
  ohlcv(pool: string, tf: string): Promise<Candle[]>;
  pair(mint: string): Promise<Candidate | null>;
  pairs(mints: string[]): Promise<Candidate[]>;
}

const UA = { 'user-agent': 'grokbot-trader/1.0', accept: 'application/json' };

class Limiter {
  private q: Promise<void> = Promise.resolve();
  private last = 0;
  baseGap: number;
  gapMs: number;
  constructor(gapMs: number) { this.baseGap = gapMs; this.gapMs = gapMs; }
  on429() { this.gapMs = Math.min(this.gapMs * 2, 15_000); }
  onOk() { this.gapMs = Math.max(this.baseGap, this.gapMs * 0.92); }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.q.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.q = p.catch(() => {});
    return p.then(fn);
  }
}

const num = (x: any) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

export class LiveMarket implements MarketSource {
  name = 'live';
  calls: Record<string, number> = { geckoterminal: 0, dexscreener: 0, rugcheck: 0, jupiter: 0 };
  errors = 0;
  lastError = '';
  private gt = new Limiter(2100);      // GeckoTerminal free tier ~30 req/min
  private ds = new Limiter(800);       // DexScreener; back off hard on 429 (shared IPs)
  private rc = new Limiter(1500);
  private jup = new Limiter(1100);    // Jupiter lite API is ~60 req/min
  private secCache = new Map<string, TokenSecurity>();
  private decCache = new Map<string, number>([[SOL_MINT, 9], [USDC_MINT, 6]]);
  private ohlcvCache = new Map<string, { at: number; data: Candle[] }>();
  private scanTick = 0;
  lastSolPrice = 0;
  private pump = getPumpFeed();
  private pumpStarted = false;

  start() {
    if (this.pumpStarted) return;
    this.pumpStarted = true;
    this.pump.start();
  }
  stop() { this.pump.stop(); this.pumpStarted = false; }
  pumpStatus() { return this.pump.status; }

  private limiterFor(src: string): Limiter | null {
    if (src === 'geckoterminal') return this.gt;
    if (src === 'dexscreener') return this.ds;
    if (src === 'rugcheck') return this.rc;
    if (src === 'jupiter') return this.jup;
    return null;
  }
  private async get(url: string, src: string, timeoutMs = 12000, retry = true): Promise<any> {
    this.calls[src] = (this.calls[src] || 0) + 1;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const lim = this.limiterFor(src);
    try {
      const r = await fetch(url, { headers: UA, signal: ctl.signal });
      if (r.status === 429) {
        lim?.on429();
        if (retry) { clearTimeout(t); await new Promise((res) => setTimeout(res, Math.max(2000, lim?.gapMs || 2000))); return this.get(url, src, timeoutMs, false); }
        throw new Error(`${src} HTTP 429`);
      }
      if (!r.ok) throw new Error(`${src} HTTP ${r.status}`);
      lim?.onOk();
      return await r.json();
    } catch (e: any) {
      this.errors++;
      this.lastError = `${new Date().toISOString()} ${src}: ${e?.message || e}`;
      throw e;
    } finally { clearTimeout(t); }
  }

  private ingestGt(d: any, out: Map<string, Candidate>): number {
    let scanned = 0;
    const inc = new Map<string, any>((d.included || []).map((x: any) => [x.id, x]));
    for (const pool of d.data || []) {
      scanned++;
      const c = mapGt(pool, inc);
      if (c && !out.has(c.mint)) out.set(c.mint, c);
    }
    return scanned;
  }

  async candidates() {
    const out = new Map<string, Candidate>();
    let scanned = 0;
    this.scanTick++;
    const dexes = ['pumpswap', 'pump-fun', 'raydium', 'meteora'];
    const dex = dexes[this.scanTick % dexes.length];
    const rot = [
      `dexes/${dex}/new_pools?page=1`,
      'trending_pools?page=1&duration=5m',
      'new_pools?page=2',
      'trending_pools?page=1&duration=1h',
    ];
    const gtPages = ['new_pools?page=1', rot[this.scanTick % rot.length]];
    const addGt = (d: any) => { if (d) scanned += this.ingestGt(d, out); };
    const addDsPairs = (pairs: any) => {
      const best = new Map<string, any>();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        scanned++;
        const m = p.baseToken?.address;
        if (!m) continue;
        if (!best.has(m) || num(p.liquidity?.usd) > num(best.get(m).liquidity?.usd)) best.set(m, p);
      }
      for (const p of best.values()) {
        const c = mapDs(p);
        if (c && !out.has(c.mint)) out.set(c.mint, c);
      }
    };
    // Each source has its own limiter/backoff. They run in parallel so a slow
    // or 429'd API does not hold up the others.
    const gtJobs = gtPages.map((p) => {
      const sep = p.includes('?') ? '&' : '?';
      return this.gt.run(() => this.get(`https://api.geckoterminal.com/api/v2/networks/solana/${p}${sep}include=base_token,quote_token,dex`, 'geckoterminal', 5000))
        .then(addGt).catch(() => {});
    });
    const dsJob = (async () => {
      try {
        const feed = this.scanTick % 2 ? 'token-profiles/latest/v1' : 'token-boosts/latest/v1';
        const prof = await this.ds.run(() => this.get(`https://api.dexscreener.com/${feed}`, 'dexscreener', 5000));
        const mints = [...new Set<string>((Array.isArray(prof) ? prof : []).filter((x: any) => x.chainId === 'solana').map((x: any) => x.tokenAddress))].slice(0, 30);
        if (mints.length) {
          const pairs = await this.ds.run(() => this.get(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, 'dexscreener', 5000));
          addDsPairs(pairs);
        }
      } catch {}
    })();
    const jupJob = (async () => {
      if (this.scanTick % 3 !== 0) return;
      try {
        const d = await this.jup.run(() => this.get('https://lite-api.jup.ag/tokens/v2/recent', 'jupiter', 5000, false));
        const addrs = (Array.isArray(d) ? d : d?.tokens || []).map((x: any) => x.id || x.address).filter(Boolean).slice(0, 20);
        if (addrs.length) {
          const pairs = await this.ds.run(() => this.get(`https://api.dexscreener.com/tokens/v1/solana/${addrs.join(',')}`, 'dexscreener', 5000));
          addDsPairs(pairs);
        }
      } catch {}
    })();
    // Hard deadline: a slow second hop on one source must not hold the scan loop.
    this.start();
    await Promise.race([
      Promise.all([...gtJobs, dsJob, jupJob]),
      new Promise((r) => setTimeout(r, 4500)),
    ]);
    const pumpList = this.pump.toCandidates(this.lastSolPrice || 70);
    scanned += pumpList.length;
    for (const p of pumpList) {
      const prev = out.get(p.mint);
      out.set(p.mint, prev ? mergePumpOnto(prev, p) : p);
    }
    return { list: [...out.values()], scanned };
  }

  async pair(mint: string): Promise<Candidate | null> {
    try {
      const pairs = await this.ds.run(() => this.get(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, 'dexscreener'));
      let best: any = null;
      for (const p of Array.isArray(pairs) ? pairs : []) {
        if (!best || num(p.liquidity?.usd) > num(best.liquidity?.usd)) best = p;
      }
      return best ? mapDs(best) : null;
    } catch { return null; }
  }

  async pairs(mints: string[]): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const uniq = [...new Set(mints.filter(Boolean))].slice(0, 30);
    if (!uniq.length) return out;
    try {
      const pairs = await this.ds.run(() => this.get(`https://api.dexscreener.com/tokens/v1/solana/${uniq.join(',')}`, 'dexscreener'));
      const best = new Map<string, any>();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const m = p.baseToken?.address;
        if (!m) continue;
        if (!best.has(m) || num(p.liquidity?.usd) > num(best.get(m).liquidity?.usd)) best.set(m, p);
      }
      for (const p of best.values()) {
        const c = mapDs(p);
        if (c) out.push(c);
      }
    } catch {}
    return out;
  }

  async security(mint: string): Promise<TokenSecurity | null> {
    const hit = this.secCache.get(mint);
    if (hit && Date.now() - hit.fetchedAt < 15 * 60_000) return hit;
    try {
      const d = await this.rc.run(() => this.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, 'rugcheck', 20000));
      const known = d.knownAccounts || {};
      const holders = (d.topHolders || []).filter((h: any) => !known[h.owner] && !known[h.address]);
      const s: TokenSecurity = {
        mintAuthority: d.token?.mintAuthority ?? d.mintAuthority ?? null,
        freezeAuthority: d.token?.freezeAuthority ?? d.freezeAuthority ?? null,
        holders: typeof d.totalHolders === 'number' ? d.totalHolders : null,
        topHolderPct: holders.length ? num(holders[0].pct) : null,
        top10Pct: holders.length ? holders.slice(0, 10).reduce((a: number, h: any) => a + num(h.pct), 0) : null,
        dangerRisks: (d.risks || []).filter((r: any) => r.level === 'danger').map((r: any) => String(r.name)),
        rugged: !!d.rugged,
        fetchedAt: Date.now(),
        available: true,
      };
      if (d.token?.decimals !== undefined) this.decCache.set(mint, num(d.token.decimals));
      this.secCache.set(mint, s);
      return s;
    } catch {
      const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
      const auth = await fetchMintAuthorities(rpc, mint);
      if (!auth) return null;
      const s: TokenSecurity = {
        mintAuthority: auth.mintAuthority, freezeAuthority: auth.freezeAuthority,
        holders: null, topHolderPct: null, top10Pct: null, dangerRisks: [], rugged: false,
        fetchedAt: Date.now(), available: true,
      };
      (s as any).freshPump = !!this.pump.get(mint);
      this.secCache.set(mint, s);
      if (auth.decimals) this.decCache.set(mint, auth.decimals);
      return s;
    }
  }

  async prices(mints: string[]) {
    const out: Record<string, number> = {};
    const uniq = [...new Set(mints)];
    for (let i = 0; i < uniq.length; i += 50) {
      const ids = uniq.slice(i, i + 50).join(',');
      try {
        const d = await this.jup.run(() => this.get(`https://lite-api.jup.ag/price/v3?ids=${ids}`, 'jupiter'));
        for (const [m, v] of Object.entries<any>(d || {})) {
          if (v?.usdPrice) out[m] = num(v.usdPrice);
          if (v?.decimals !== undefined) this.decCache.set(m, num(v.decimals));
        }
        if (out[SOL_MINT]) this.lastSolPrice = out[SOL_MINT];
      } catch {}
    }
    return out;
  }

  async decimals(mint: string) {
    if (this.decCache.has(mint)) return this.decCache.get(mint)!;
    await this.prices([mint]);
    return this.decCache.get(mint) ?? 6;
  }

  async quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<Quote | null> {
    try {
      const d = await this.jup.run(() => this.get(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`, 'jupiter'));
      if (!d?.outAmount) {
        const t = this.pump.get(outputMint === SOL_MINT ? inputMint : outputMint);
        if (t && !t.graduated) return curveQuote(t, inputMint, outputMint, amountRaw, this.lastSolPrice || 0);
        return null;
      }
      return {
        inAmount: num(d.inAmount), outAmount: num(d.outAmount), priceImpactPct: num(d.priceImpactPct) * 100,
        route: (d.routePlan || []).map((r: any) => r.swapInfo?.label).filter(Boolean).join(' → ') || 'Jupiter', raw: d,
      };
    } catch {
      const t = this.pump.get(outputMint === SOL_MINT ? inputMint : outputMint);
      if (t && !t.graduated) return curveQuote(t, inputMint, outputMint, amountRaw, this.lastSolPrice || 0);
      return null;
    }
  }

  async ohlcv(pool: string, tf: string): Promise<Candle[]> {
    const map: Record<string, [string, number]> = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1] };
    const [unit, agg] = map[tf] || map['1m'];
    const key = `${pool}:${tf}`;
    const hit = this.ohlcvCache.get(key);
    if (hit && Date.now() - hit.at < 45_000) return hit.data;
    try {
      const d = await this.gt.run(() => this.get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=120&currency=usd`, 'geckoterminal'));
      const list: Candle[] = (d?.data?.attributes?.ohlcv_list || []).map((r: any[]) => r.map(num)).reverse();
      this.ohlcvCache.set(key, { at: Date.now(), data: list });
      return list;
    } catch { return hit?.data || []; }
  }
}

function mapGt(pool: any, inc: Map<string, any>): Candidate | null {
  const a = pool.attributes || {};
  const base = inc.get(pool.relationships?.base_token?.data?.id)?.attributes;
  const quote = inc.get(pool.relationships?.quote_token?.data?.id)?.attributes;
  if (!base?.address) return null;
  if ([SOL_MINT, USDC_MINT].includes(base.address)) return null;
  const pc = a.price_change_percentage || {}, v = a.volume_usd || {}, t = a.transactions || {};
  return {
    mint: base.address, pool: a.address, symbol: base.symbol || '?', name: base.name || base.symbol || '?',
    image: base.image_url && base.image_url !== 'missing.png' ? base.image_url : undefined,
    dex: pool.relationships?.dex?.data?.id || 'dex',
    priceUsd: num(a.base_token_price_usd), mcapUsd: num(a.market_cap_usd) || num(a.fdv_usd),
    liquidityUsd: num(a.reserve_in_usd), createdAt: Date.parse(a.pool_created_at) || Date.now(),
    change: { m5: num(pc.m5), m15: num(pc.m15), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
    volume: { m5: num(v.m5), h1: num(v.h1), h6: num(v.h6), h24: num(v.h24) },
    txns: { m5b: num(t.m5?.buys), m5s: num(t.m5?.sells), h1b: num(t.h1?.buys), h1s: num(t.h1?.sells), h24b: num(t.h24?.buys), h24s: num(t.h24?.sells) },
    traders1h: num(t.h1?.unique_traders) || Math.round((num(t.h1?.buyers) + num(t.h1?.sellers)) * 0.8),
    quoteSymbol: quote?.symbol || '?', source: 'geckoterminal',
  };
}

function mapDs(p: any): Candidate | null {
  const m = p.baseToken?.address;
  if (!m || [SOL_MINT, USDC_MINT].includes(m)) return null;
  const pc = p.priceChange || {}, v = p.volume || {}, t = p.txns || {};
  return {
    mint: m, pool: p.pairAddress, symbol: p.baseToken.symbol || '?', name: p.baseToken.name || '?',
    image: p.info?.imageUrl, dex: p.dexId || 'dex', priceUsd: num(p.priceUsd), mcapUsd: num(p.marketCap) || num(p.fdv),
    liquidityUsd: num(p.liquidity?.usd), createdAt: num(p.pairCreatedAt) || Date.now(),
    change: { m5: num(pc.m5), m15: (num(pc.m5) + num(pc.h1)) / 2, h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
    volume: { m5: num(v.m5), h1: num(v.h1), h6: num(v.h6), h24: num(v.h24) },
    txns: { m5b: num(t.m5?.buys), m5s: num(t.m5?.sells), h1b: num(t.h1?.buys), h1s: num(t.h1?.sells), h24b: num(t.h24?.buys), h24s: num(t.h24?.sells) },
    traders1h: Math.round((num(t.h1?.buys) + num(t.h1?.sells)) * 0.55),
    quoteSymbol: p.quoteToken?.symbol || '?', source: 'dexscreener',
  };
}
