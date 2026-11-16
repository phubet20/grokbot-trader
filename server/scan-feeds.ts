// Rotating discovery feeds for the Scanner: GeckoTerminal, DexScreener, PumpPortal.
// Two GT + two DS requests per tick stay inside free-tier rate limits; the
// catalog is wide so every dex, page, and feed is visited continuously.
export const GT_DEXES = [
  'pumpswap',
  'pump-fun',
  'raydium',
  'raydium-clmm',
  'meteora',
  'meteora-dlmm',
  'orca',
  'whirlpool',
] as const;

export type ScanUniverse = 'new' | 'trending';
export type ScanPath = { path: string; universe: ScanUniverse; src: string };
export type DsJob = { kind: 'tokens' | 'search'; url: string; src: string; universe: ScanUniverse };

const page = (tick: number, max: number) => ((tick % max) + max) % max + 1;

/** GeckoTerminal paths covering new pools, trending, top-volume, and every major dex. */
export function gtCatalog(tick: number): ScanPath[] {
  const dex = GT_DEXES[((tick % GT_DEXES.length) + GT_DEXES.length) % GT_DEXES.length];
  return [
    { path: `new_pools?page=${page(tick, 8)}`, universe: 'new', src: 'geckoterminal-new' },
    { path: `trending_pools?page=${page(tick, 4)}&duration=5m`, universe: 'trending', src: 'geckoterminal-trending' },
    { path: `trending_pools?page=${page(tick, 3)}&duration=1h`, universe: 'trending', src: 'geckoterminal-trending' },
    { path: `trending_pools?page=${page(tick, 3)}&duration=6h`, universe: 'trending', src: 'geckoterminal-trending' },
    { path: `trending_pools?page=${page(tick, 3)}&duration=24h`, universe: 'trending', src: 'geckoterminal-trending' },
    { path: `pools?page=${page(tick, 8)}&sort=h24_volume_usd_desc`, universe: 'trending', src: 'geckoterminal-volume' },
    { path: `pools?page=${page(tick, 4)}&sort=h24_tx_count_desc`, universe: 'trending', src: 'geckoterminal-volume' },
    { path: `dexes/${dex}/new_pools?page=${page(tick, 3)}`, universe: 'new', src: `geckoterminal-${dex}` },
    { path: `dexes/${dex}/pools?page=${page(tick, 4)}`, universe: 'trending', src: `geckoterminal-${dex}` },
  ];
}

/** Two complementary GT endpoints per scan tick. */
export function gtScanPaths(tick: number): ScanPath[] {
  const catalog = gtCatalog(tick);
  const a = catalog[tick % catalog.length];
  let b = catalog[(tick + Math.ceil(catalog.length / 2)) % catalog.length];
  if (b.path === a.path) b = catalog[(tick + 1) % catalog.length];
  return b.path === a.path ? [a] : [a, b];
}

const DS_FEEDS: DsJob[] = [
  { kind: 'tokens', url: 'https://api.dexscreener.com/token-boosts/top/v1', src: 'dexscreener-boosts', universe: 'trending' },
  { kind: 'tokens', url: 'https://api.dexscreener.com/token-boosts/latest/v1', src: 'dexscreener-boosts', universe: 'trending' },
  { kind: 'tokens', url: 'https://api.dexscreener.com/token-profiles/latest/v1', src: 'dexscreener-profiles', universe: 'new' },
];

const DS_SEARCHES: DsJob[] = [
  { kind: 'search', url: 'https://api.dexscreener.com/latest/dex/search?q=SOL', src: 'dexscreener-search', universe: 'trending' },
  { kind: 'search', url: 'https://api.dexscreener.com/latest/dex/search?q=pump', src: 'dexscreener-search', universe: 'new' },
  { kind: 'search', url: 'https://api.dexscreener.com/latest/dex/search?q=raydium', src: 'dexscreener-raydium', universe: 'trending' },
  { kind: 'search', url: 'https://api.dexscreener.com/latest/dex/search?q=meteora', src: 'dexscreener-meteora', universe: 'trending' },
  { kind: 'search', url: 'https://api.dexscreener.com/latest/dex/search?q=orca', src: 'dexscreener-orca', universe: 'trending' },
  { kind: 'search', url: 'https://api.dexscreener.com/latest/dex/search?q=pumpswap', src: 'dexscreener-pumpswap', universe: 'trending' },
];

/** One boosts/profiles feed + one search query per tick (latest/search/boosts/profiles). */
export function dsScanJobs(tick: number): DsJob[] {
  return [DS_FEEDS[tick % DS_FEEDS.length], DS_SEARCHES[tick % DS_SEARCHES.length]];
}

export function asPairs(d: any): any[] {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.pairs)) return d.pairs;
  if (Array.isArray(d?.data)) return d.data;
  return [];
}

export function solanaPairs(d: any): any[] {
  return asPairs(d).filter((p) => {
    const chain = String(p.chainId || p.chain || '').toLowerCase();
    return !chain || chain === 'solana';
  });
}

export function solMintsFromProfiles(d: any, limit = 30): string[] {
  const rows = asPairs(d);
  const mints: string[] = [];
  for (const x of rows) {
    const chain = String(x?.chainId || x?.chain || '').toLowerCase();
    if (chain && chain !== 'solana') continue;
    const m = x?.tokenAddress || x?.address;
    if (typeof m === 'string' && m.length >= 32) mints.push(m);
  }
  return [...new Set(mints)].slice(0, limit);
}

export function sourceGroup(name: string): string {
  const k = name.toLowerCase();
  if (k.startsWith('geckoterminal')) return 'GeckoTerminal';
  if (k.startsWith('dexscreener')) return 'DexScreener';
  if (k.startsWith('pumpportal')) return 'PumpPortal';
  if (k.startsWith('pumpfun') || k.startsWith('pump-fun') || k === 'pump') return 'pump.fun';
  if (k.startsWith('jupiter')) return 'Jupiter';
  if (k.startsWith('gmgn')) return 'GMGN';
  if (k === 'replay') return 'Replay';
  return name;
}

export type SourceSummary = { total: number; last: number; ok: boolean; error?: string };

export function summarizeSources(
  last: Record<string, { ok: boolean; n: number; error?: string }>,
  totals: Record<string, number> = {},
): Record<string, SourceSummary> {
  const out: Record<string, SourceSummary> = {};
  const keys = new Set([...Object.keys(last), ...Object.keys(totals)]);
  for (const k of keys) {
    const g = sourceGroup(k);
    const hit = last[k];
    const row = out[g] || (out[g] = { total: 0, last: 0, ok: true });
    row.total += totals[k] || 0;
    if (hit) {
      row.last += hit.n || 0;
      if (!hit.ok) { row.ok = false; if (hit.error) row.error = hit.error; }
    }
  }
  return out;
}
