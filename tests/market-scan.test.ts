// Scanner universe: all major Solana venues, rotating feeds, source counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GT_DEXES, dsScanJobs, gtCatalog, gtScanPaths, solMintsFromProfiles, solanaPairs, sourceGroup, summarizeSources } from '../server/scan-feeds.ts';
import { DEFAULTS } from '../server/config.ts';
import { preCheck } from '../server/safety.ts';

test('gt rotation covers new, trending, top-volume, and every dex including Orca', () => {
  const paths: string[] = [];
  const srcs: string[] = [];
  for (let t = 1; t <= 80; t++) {
    for (const j of gtScanPaths(t)) {
      paths.push(j.path);
      srcs.push(j.src);
    }
  }
  assert.ok(paths.some((p) => p.startsWith('new_pools?page=')), 'new_pools');
  assert.ok(paths.some((p) => p.includes('trending_pools') && p.includes('duration=5m')));
  assert.ok(paths.some((p) => p.includes('trending_pools') && p.includes('duration=24h')));
  assert.ok(paths.some((p) => p.includes('sort=h24_volume_usd_desc')), 'top volume pages');
  assert.ok(paths.some((p) => /page=[2-8]/.test(p)), 'paginated past page 1');
  for (const dex of GT_DEXES) {
    assert.ok(paths.some((p) => p.includes(`dexes/${dex}/`)), 'missing dex ' + dex);
  }
  assert.ok(srcs.some((s) => s.includes('orca')));
  assert.ok(srcs.some((s) => s.includes('whirlpool')));
  assert.ok(srcs.some((s) => s.includes('pumpswap')));
  assert.ok(srcs.some((s) => s.includes('raydium')));
  assert.ok(srcs.some((s) => s.includes('meteora')));
  assert.equal(gtScanPaths(1).length, 2);
  // Rate-limit friendly: never more than 2 GT paths per tick.
  for (let t = 1; t <= 20; t++) assert.ok(gtScanPaths(t).length <= 2);
  assert.ok(gtCatalog(1).length >= 8);
});

test('dexscreener rotation includes search, latest boosts, and token profiles', () => {
  const urls: string[] = [];
  const srcs: string[] = [];
  const kinds: string[] = [];
  for (let t = 0; t < 12; t++) {
    const jobs = dsScanJobs(t);
    assert.equal(jobs.length, 2);
    for (const j of jobs) {
      urls.push(j.url);
      srcs.push(j.src);
      kinds.push(j.kind);
    }
  }
  assert.ok(urls.some((u) => u.includes('token-boosts/top/v1')));
  assert.ok(urls.some((u) => u.includes('token-boosts/latest/v1')));
  assert.ok(urls.some((u) => u.includes('token-profiles/latest/v1')));
  assert.ok(urls.some((u) => u.includes('latest/dex/search?q=SOL')));
  assert.ok(urls.some((u) => u.includes('q=orca')));
  assert.ok(urls.some((u) => u.includes('q=raydium')));
  assert.ok(urls.some((u) => u.includes('q=meteora')));
  assert.ok(urls.some((u) => u.includes('q=pumpswap')));
  assert.ok(urls.some((u) => u.includes('q=pump')));
  assert.ok(kinds.includes('search') && kinds.includes('tokens'));
});

test('search payloads and low-volume pairs are kept (small caps included)', () => {
  const wrapped = {
    pairs: [
      { chainId: 'solana', baseToken: { address: 'SoLmint1111111111111111111111111111111112' }, liquidity: { usd: 400 }, volume: { m5: 10, h1: 20, h24: 50 } },
      { chainId: 'ethereum', baseToken: { address: '0xabc' }, liquidity: { usd: 1_000_000 } },
    ],
  };
  const sol = solanaPairs(wrapped);
  assert.equal(sol.length, 1);
  assert.equal(sol[0].liquidity.usd, 400);
  const mints = solMintsFromProfiles([
    { chainId: 'solana', tokenAddress: 'PumpMint111111111111111111111111111111111' },
    { chainId: 'bsc', tokenAddress: '0xdead' },
  ]);
  assert.deepEqual(mints, ['PumpMint111111111111111111111111111111111']);
});

test('summarizeSources groups DexScreener, GeckoTerminal and PumpPortal counts', () => {
  const last = {
    'geckoterminal-new': { ok: true, n: 20 },
    'geckoterminal-orca': { ok: true, n: 8 },
    'dexscreener-search': { ok: true, n: 15 },
    'pumpportal-new': { ok: true, n: 4 },
  };
  const totals = { 'geckoterminal-new': 200, 'geckoterminal-orca': 40, 'dexscreener-search': 90, 'pumpportal-new': 30 };
  const s = summarizeSources(last, totals);
  assert.equal(sourceGroup('geckoterminal-volume'), 'GeckoTerminal');
  assert.equal(s.GeckoTerminal.total, 240);
  assert.equal(s.GeckoTerminal.last, 28);
  assert.equal(s.DexScreener.total, 90);
  assert.equal(s.PumpPortal.total, 30);
  assert.equal(s.PumpPortal.last, 4);
  assert.equal(s.GeckoTerminal.ok, true);
});

test('pre-check does not drop older or large-cap coins when caps are unlimited', () => {
  const now = Date.now();
  const c: any = {
    mint: 'M', pool: 'P', symbol: 'OLD', name: 'OLD', dex: 'orca', source: 'geckoterminal',
    priceUsd: 1, mcapUsd: 80_000_000, liquidityUsd: 2_000_000, createdAt: now - 200 * 24 * 3600_000,
    change: { m5: 1, m15: 2, h1: 3, h6: 4, h24: 5 }, volume: { m5: 1000, h1: 8000, h6: 20_000, h24: 50_000 },
    txns: { m5b: 10, m5s: 8, h1b: 40, h1s: 30, h24b: 100, h24s: 80 }, traders1h: 50, quoteSymbol: 'SOL',
  };
  const r = preCheck(c, { ...DEFAULTS, maxAgeHours: 0, maxMcapUsd: 500_000_000, maxLiquidityUsd: 50_000_000 }, now);
  assert.equal(r.ok, true, r.reasons.join(','));
  assert.ok(!r.reasons.some((x) => x.startsWith('age')));
  const capped = preCheck(c, { ...DEFAULTS, maxAgeHours: 24 }, now);
  assert.equal(capped.ok, true, 'age is a penalty, not a block');
  assert.ok(capped.adj < 0 && capped.reasons.some((x) => x.startsWith('age')));
});
