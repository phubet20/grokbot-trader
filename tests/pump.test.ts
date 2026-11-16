import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curveBuy, curveSell, curveProgress, priceSol, PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS, curveQuote } from '../server/pump.ts';
import { matchEntryPatterns, sellPressure, toSnap, STRAT_DEFAULTS } from '../server/strategy.ts';
import { scoreCandidate } from '../server/analyst.ts';
import { persistRenderEnv, canPersistRenderEnv, autoStartEnabled } from '../server/render-env.ts';
import { SOL_MINT } from '../server/market.ts';
import type { Candidate } from '../server/types.ts';

test('bonding-curve buy then sell is conservative and conserves k minus fee', () => {
  const buy = curveBuy(PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS, 0.5);
  assert.ok(buy.tokensOut > 0);
  assert.ok(buy.vSol > PUMP_VIRTUAL_SOL);
  assert.ok(buy.vTokens < PUMP_VIRTUAL_TOKENS);
  const sell = curveSell(buy.vSol, buy.vTokens, buy.tokensOut);
  assert.ok(sell.solOut > 0 && sell.solOut < 0.5, 'round-trip loses the 1% fee each way');
  assert.ok(curveProgress(buy.vTokens, buy.vSol) > 0);
  assert.ok(priceSol(PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS) > 0);
});

test('curveQuote builds unsigned paper sizes and does not send', () => {
  const t = { mint: 'PumpMint11111111111111111111111111111111111', symbol: 'X', name: 'X', dev: '', createdAt: Date.now(), vSol: 30, vTokens: 1_073_000_000, graduated: false, graduatedAt: 0, initialBuy: 0, initialSol: 0.2, pool: 'c', lastEventAt: Date.now() };
  const q = curveQuote(t as any, SOL_MINT, t.mint, 100_000_000n, 70); // 0.1 SOL
  assert.ok(q && q.outAmount > 0 && q.route === 'pump-curve');
});

function cand(over: Partial<Candidate> = {}): Candidate {
  const now = Date.now();
  return {
    mint: 'M', pool: 'P', symbol: 'P', name: 'P', dex: 'pump', priceUsd: 0.00003, mcapUsd: 30_000, liquidityUsd: 4000,
    createdAt: now - 60_000, change: { m5: 8, m15: 10, h1: 12, h6: 0, h24: 0 },
    volume: { m5: 2000, h1: 2000, h6: 0, h24: 0 },
    txns: { m5b: 12, m5s: 5, h1b: 12, h1s: 5, h24b: 12, h24s: 5 },
    traders1h: 10, quoteSymbol: 'SOL', source: 'pumpportal',
    curve: { progress: 0.25, vSol: 45, vTokens: 900_000_000, graduated: false },
    flow: { netBuySol: 1.2, largeBuys: 1, largeSells: 0, uniqueBuyers: 12, uniqueSellers: 3, whaleBuyUsd: 80, bundled: false, devSold: false, devHoldPct: 2, progress: 0.25, progressVel: 0.1 },
    ...over,
  };
}

test('entry patterns cover fresh launch, curve breakout, near-graduation, post-grad, and whale dip', () => {
  const now = Date.now();
  const c = cand({ createdAt: now - 90_000 });
  const h = [toSnap(now, c)];
  const fresh = matchEntryPatterns(c, h, STRAT_DEFAULTS, now);
  assert.equal(fresh.ok, true, fresh.reason);
  assert.match(fresh.reason, /fresh-launch|curve breakout/);

  const near = cand({ curve: { progress: 0.8, vSol: 100, vTokens: 400_000_000, graduated: false }, flow: { ...(cand().flow!), progress: 0.8 } });
  const n = matchEntryPatterns(near, [toSnap(now, near)], STRAT_DEFAULTS, now);
  assert.equal(n.ok, true, n.reason);
  assert.match(n.reason, /near-graduation|fresh-launch|curve breakout/);

  const grad = cand({ dex: 'pumpswap', curve: { progress: 1, vSol: 0, vTokens: 0, graduated: true }, createdAt: now - 10 * 60_000, liquidityUsd: 20_000, txns: { m5b: 20, m5s: 8, h1b: 20, h1s: 8, h24b: 20, h24s: 8 } });
  const g = matchEntryPatterns(grad, [toSnap(now, grad)], STRAT_DEFAULTS, now);
  assert.equal(g.ok, true, g.reason);

  const peak = cand({ priceUsd: 0.00004 });
  const dip = cand({ priceUsd: 0.000037, flow: { ...(cand().flow!), whaleBuyUsd: 200 } });
  const hist = [toSnap(now - 8000, peak), toSnap(now, dip)];
  const d = matchEntryPatterns(dip, hist, STRAT_DEFAULTS, now);
  assert.equal(d.ok, true, d.reason);
});

test('sell pressure exits on net sells, large sells, or dev selling', () => {
  const now = Date.now();
  const dev = cand({ flow: { ...(cand().flow!), devSold: true } });
  const s = toSnap(now, dev);
  assert.equal(sellPressure(dev, s).exit, true);
  const sells = cand({ txns: { m5b: 4, m5s: 16, h1b: 4, h1s: 16, h24b: 4, h24s: 16 }, flow: { ...(cand().flow!), largeSells: 3, largeBuys: 0 } });
  assert.equal(sellPressure(sells, toSnap(now, sells)).exit, true);
});

test('flow score prefers whale + buyer growth over a dump', () => {
  const hi = scoreCandidate(cand());
  const lo = scoreCandidate(cand({
    change: { m5: -8, m15: -12, h1: -20, h6: 0, h24: 0 },
    txns: { m5b: 3, m5s: 20, h1b: 10, h1s: 40, h24b: 10, h24s: 40 },
    traders1h: 4,
    flow: { netBuySol: -2, largeBuys: 0, largeSells: 4, uniqueBuyers: 3, uniqueSellers: 20, whaleBuyUsd: 0, devSold: true, bundled: true, progress: 0.02, progressVel: 0 },
  }));
  assert.ok(hi.score > lo.score, `hi=${hi.score} lo=${lo.score}`);
  assert.ok(lo.score < 50, 'lo=' + lo.score);
});

test('persistRenderEnv refuses unknown keys and no-ops without an API key', async () => {
  delete process.env.RENDER_API_KEY;
  assert.equal(canPersistRenderEnv(), false);
  const denied = await persistRenderEnv({ BOT_WALLET_SECRET: 'nope', WITHDRAW_TO: 'Abc' } as any);
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.written, []);
  process.env.AUTO_START = '1';
  assert.equal(autoStartEnabled(), true);
  delete process.env.AUTO_START;
});

test('buildLiveSwapTx falls back to PumpPortal when the quote has no Jupiter raw route', async () => {
  const { DEFAULTS, LIVE_CONFIRM_PHRASE } = await import('../server/config.ts');
  const { buildLiveSwapTx } = await import('../server/executor.ts');
  const cfg = { ...DEFAULTS, mode: 'live-auto' as const, liveConfirm: LIVE_CONFIRM_PHRASE };
  const mint = '2P6yDTNLgHyub5CgpM2hn3wWG4dVakhfpkHAFBQJpump';
  const user = '2VscQ33yZudTXXNjCpfB5X4jsJVL4ZoZxGDzS5xCtLYo';
  const m = {
    async quote() { return { inAmount: 1_000_000, outAmount: 50_000_000, priceImpactPct: 2, route: 'pump-curve' }; },
    async decimals() { return 6; },
  } as any;
  const original = globalThis.fetch;
  let seen: { url: string; body: any } | null = null;
  globalThis.fetch = (async (url: any, init?: any) => {
    seen = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    return new Response(Buffer.from([1, 2, 3, 4, 5, 16]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  }) as any;
  try {
    const built = await buildLiveSwapTx(cfg, m, { inputMint: SOL_MINT, outputMint: mint, amountRaw: 2_000_000n, userPublicKey: user });
    assert.ok(seen && seen.url.includes('pumpportal.fun/api/trade-local'), 'called trade-local, url=' + seen?.url);
    assert.equal(seen!.body.action, 'buy');
    assert.equal(seen!.body.pool, 'pump');
    assert.equal(seen!.body.denominatedInSol, 'true');
    assert.ok(built.swapTransaction);
    assert.equal(built.quote.route, 'pump-curve');
  } finally {
    globalThis.fetch = original;
  }
});

test('buildPumpPortalTx surfaces HTTP/JSON errors', async () => {
  const { buildPumpPortalTx } = await import('../server/executor.ts');
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'insufficient sol' }), { status: 400 })) as any;
  try {
    await assert.rejects(() => buildPumpPortalTx({
      userPublicKey: '2VscQ33yZudTXXNjCpfB5X4jsJVL4ZoZxGDzS5xCtLYo',
      action: 'buy', mint: 'M', amount: 0.02, denominatedInSol: true, slippagePct: 15, priorityFeeSol: 0.0002, pool: 'pump',
    }), /insufficient sol|trade-local HTTP 400/);
  } finally {
    globalThis.fetch = original;
  }
});
