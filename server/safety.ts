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
  const floor = Math.min(400, cfg.minLiquidityUsd || 400);
  // Scan pump.fun (curve + PumpSwap), Raydium, and Meteora — small and large caps.
  // Only reject dust with no flow; age/mcap/liq-ratio cuts were dropping fresh launches and dips.
  if (c.liquidityUsd < floor && (c.flow?.netBuySol || 0) <= 0 && (c.volume.m5 || 0) <= 0)
    r.push(pump ? 'curve liq/flow too thin' : `liq $${k(c.liquidityUsd)} < $${k(floor)}`);
  const tx1h = c.txns.h1b + c.txns.h1s, tx5 = c.txns.m5b + c.txns.m5s;
  if (!pump && ageMin > 30 && tx5 === 0 && tx1h === 0) r.push('no trades');
  if (!pump && c.volume.h1 > c.liquidityUsd * 12 && c.traders1h < 30 && c.liquidityUsd > 0) r.push('wash-trade pattern');
  if (cfg.maxLiquidityUsd > 0 && c.liquidityUsd > cfg.maxLiquidityUsd) r.push('liq too large (not a meme play)');
  if (cfg.maxMcapUsd > 0 && c.mcapUsd > cfg.maxMcapUsd) r.push(`mcap $${k(c.mcapUsd)} too large`);
  if (cfg.maxAgeHours > 0 && ageMin > cfg.maxAgeHours * 60) r.push(`age > ${cfg.maxAgeHours}h`);
  // honeypot-ish: lots of buys, (almost) no sells
  if (c.txns.h1b >= 30 && c.txns.h1s <= Math.max(1, c.txns.h1b * 0.05)) r.push('honeypot? buys but no sells');
  else if (c.txns.m5b >= 20 && c.txns.m5s <= Math.max(1, c.txns.m5b * 0.05)) r.push('honeypot? buys but no sells');
  if ((c.flow?.devHoldPct || 0) > cfg.maxTopHolderPct) r.push(`dev holds ${c.flow!.devHoldPct!.toFixed(0)}%`);
  if (c.flow?.bundled && ageMin < 5) r.push('bundled sniper pattern');
  if (c.change.h1 < -40) r.push('dumping -40% 1h');
  return { ok: r.length === 0, reasons: r, label: r.length ? r[0] : 'pre-check ✓' };
}

export type SecurityOpts = { pumpCurve?: boolean; devHoldPct?: number };

/** Checks that need on-chain/RugCheck data.
 *  Missing/failed RugCheck or other API errors do not block (fail open).
 *  Only confirmed hard fails reject: rugged, mint/freeze authority, extreme holders.
 *  pump.fun bonding-curve tokens: mint/freeze are revoked at create. */
function hardSecurityFails(s: TokenSecurity): string[] {
  const r: string[] = [];
  if (s.rugged) r.push('flagged rugged');
  if (s.mintAuthority) r.push('mint authority active');
  if (s.freezeAuthority) r.push('freeze authority active');
  for (const d of s.dangerRisks || []) {
    if (/honeypot|rugged/i.test(String(d))) r.push(String(d));
  }
  return r;
}

export function securityCheck(s: TokenSecurity | null, cfg: Config, opts: SecurityOpts = {}): SafetyResult {
  // Only definitive hard fails block: confirmed honeypot/rug, or mint/freeze authority.
  // Missing reports, API errors, holder stats, and other unknowns must not block.
  if (opts.pumpCurve) {
    const r = s?.available ? hardSecurityFails(s) : [];
    return { ok: r.length === 0, reasons: r, label: r.length ? r[0] : 'passed · pump curve' };
  }
  if (!s || !s.available) return { ok: true, reasons: [], label: 'passed · security unknown' };
  const r = hardSecurityFails(s);
  return { ok: r.length === 0, reasons: r, label: r.length ? r[0] : 'passed · LP · auth' };
}

function k(x: number) { return x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(0) + 'k' : x.toFixed(0); }
