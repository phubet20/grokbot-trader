// SAFETY agent - rejects anything that looks unsafe. Pure checks + RugCheck data.
import type { Candidate, TokenSecurity } from './types.ts';
import type { Config } from './config.ts';

export type SafetyResult = { ok: boolean; reasons: string[]; label: string };

/** Fast checks on market data only (no extra API calls). */
export function isPumpCurve(c: Candidate): boolean {
  return (!!c.curve && !c.curve.graduated) || c.dex === 'pump' || c.source === 'pumpportal';
}

export function preCheck(c: Candidate, cfg: Config, now = Date.now()): SafetyResult {
  const r: string[] = [];
  const ageMin = (now - c.createdAt) / 60_000;
  const pump = isPumpCurve(c);
  if (!['SOL', 'WSOL', 'USDC', 'USDT'].includes((c.quoteSymbol || 'SOL').toUpperCase())) r.push(`quote ${c.quoteSymbol}`);
  if (pump) {
    // Bonding-curve tokens start thin; require a modest virtual-liq floor, not the AMM $12k cut.
    if (c.liquidityUsd < 400 && (c.flow?.netBuySol || 0) <= 0 && (c.volume.m5 || 0) <= 0) r.push('curve liq/flow too thin');
  } else {
    if (c.liquidityUsd < cfg.minLiquidityUsd) r.push(`liq $${k(c.liquidityUsd)} < $${k(cfg.minLiquidityUsd)}`);
    if (ageMin < cfg.minAgeMin) r.push(`age ${ageMin.toFixed(0)}m < ${cfg.minAgeMin}m`);
    if (c.mcapUsd && c.mcapUsd < cfg.minMcapUsd) r.push(`mcap $${k(c.mcapUsd)} too small`);
    if (c.mcapUsd > 0 && c.liquidityUsd / c.mcapUsd < 0.03) r.push('liq/mcap < 3%');
    const tx1h = c.txns.h1b + c.txns.h1s, tx5 = c.txns.m5b + c.txns.m5s;
    if (ageMin < 60) { if (tx5 < 6 && tx1h < 12) r.push('too few trades (new pool)'); }
    else if (tx1h < 15) r.push('too few trades 1h');
    if (c.volume.h1 > c.liquidityUsd * 8 && c.traders1h < 80) r.push('wash-trade pattern');
  }
  if (c.liquidityUsd > cfg.maxLiquidityUsd) r.push('liq too large (not a meme play)');
  if (c.mcapUsd > cfg.maxMcapUsd) r.push(`mcap $${k(c.mcapUsd)} too large`);
  if (ageMin > cfg.maxAgeHours * 60) r.push(`age > ${cfg.maxAgeHours}h`);
  // honeypot-ish: lots of buys, (almost) no sells
  if (c.txns.h1b >= 30 && c.txns.h1s <= Math.max(1, c.txns.h1b * 0.05)) r.push('honeypot? buys but no sells');
  else if (c.txns.m5b >= 20 && c.txns.m5s <= Math.max(1, c.txns.m5b * 0.05)) r.push('honeypot? buys but no sells');
  if ((c.flow?.devHoldPct || 0) > cfg.maxTopHolderPct) r.push(`dev holds ${c.flow!.devHoldPct!.toFixed(0)}%`);
  if (c.flow?.bundled && ageMin < 5) r.push('bundled sniper pattern');
  if (c.change.h1 < -40) r.push('dumping -40% 1h');
  return { ok: r.length === 0, reasons: r, label: r.length ? r[0] : 'pre-check ✓' };
}

/** Checks that need on-chain/RugCheck data. Missing data = reject (fail closed). */
export function securityCheck(s: TokenSecurity | null, cfg: Config): SafetyResult {
  const r: string[] = [];
  if (!s || !s.available) return { ok: false, reasons: ['security data unavailable'], label: 'no security data' };
  if (s.rugged) r.push('flagged rugged');
  if (s.mintAuthority) r.push('mint authority active');
  if (s.freezeAuthority) r.push('freeze authority active');
  const minHolders = s.holders !== null && s.holders < 40 && (s as any).freshPump ? Math.min(8, cfg.minHolders) : cfg.minHolders;
  if (s.holders !== null && s.holders < minHolders) r.push(`holders ${s.holders} < ${minHolders}`);
  if (s.topHolderPct !== null && s.topHolderPct > cfg.maxTopHolderPct) r.push(`top holder ${s.topHolderPct.toFixed(0)}%`);
  if (s.top10Pct !== null && s.top10Pct > 60) r.push(`top10 hold ${s.top10Pct.toFixed(0)}%`);
  for (const d of s.dangerRisks.slice(0, 3)) r.push(d);
  return { ok: r.length === 0, reasons: r, label: r.length ? r[0] : 'honeypot ✓ · LP ✓ · auth ✓' };
}

function k(x: number) { return x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(0) + 'k' : x.toFixed(0); }
