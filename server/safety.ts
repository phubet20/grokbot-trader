// SAFETY agent — every rule is a score bonus or penalty. Nothing is a hard
// reject except a trade that cannot execute (no route / no quote), which the
// engine skips and retries later.
import type { Candidate, TokenSecurity } from './types.ts';
import type { Config } from './config.ts';

export type SafetyPenalty = { reason: string; adj: number };
export type SafetyResult = { ok: true; reasons: string[]; label: string; adj: number; penalties: SafetyPenalty[] };

/** Fast checks on market data only (no extra API calls). */
export function isPumpCurve(c: Candidate): boolean {
  return (!!c.curve && !c.curve.graduated) || c.dex === 'pump' || c.source === 'pumpportal';
}

function pack(penalties: SafetyPenalty[]): SafetyResult {
  const adj = penalties.reduce((a, p) => a + p.adj, 0);
  const reasons = penalties.map((p) => p.reason);
  const label = penalties.length
    ? penalties.map((p) => `${p.reason} ${p.adj}`).join(' · ')
    : 'no penalties';
  return { ok: true, reasons, label, adj, penalties };
}

/** Market/safety flags as score adjustments. Never blocks an entry. */
export function preCheck(c: Candidate, cfg: Config, now = Date.now()): SafetyResult {
  const p: SafetyPenalty[] = [];
  const ageMin = (now - c.createdAt) / 60_000;
  const pump = isPumpCurve(c);
  const quote = (c.quoteSymbol || 'SOL').toUpperCase();
  if (!['SOL', 'WSOL', 'USDC', 'USDT'].includes(quote)) p.push({ reason: `quote ${c.quoteSymbol}`, adj: -4 });
  const floor = Math.min(400, cfg.minLiquidityUsd || 400);
  if (c.liquidityUsd < floor && (c.flow?.netBuySol || 0) <= 0 && (c.volume.m5 || 0) <= 0)
    p.push({ reason: pump ? 'thin curve' : `thin liq $${k(c.liquidityUsd)}`, adj: -8 });
  const tx1h = c.txns.h1b + c.txns.h1s, tx5 = c.txns.m5b + c.txns.m5s;
  if (!pump && ageMin > 30 && tx5 === 0 && tx1h === 0) p.push({ reason: 'no trades', adj: -6 });
  if (!pump && c.volume.h1 > c.liquidityUsd * 12 && c.traders1h < 30 && c.liquidityUsd > 0)
    p.push({ reason: 'wash-trade pattern', adj: -8 });
  if (cfg.maxLiquidityUsd > 0 && c.liquidityUsd > cfg.maxLiquidityUsd) p.push({ reason: 'liq large', adj: -3 });
  if (cfg.maxMcapUsd > 0 && c.mcapUsd > cfg.maxMcapUsd) p.push({ reason: `mcap $${k(c.mcapUsd)} large`, adj: -3 });
  if (cfg.maxAgeHours > 0 && ageMin > cfg.maxAgeHours * 60) p.push({ reason: `age > ${cfg.maxAgeHours}h`, adj: -2 });
  if (c.txns.h1b >= 30 && c.txns.h1s <= Math.max(1, c.txns.h1b * 0.05))
    p.push({ reason: 'honeypot pattern', adj: -20 });
  else if (c.txns.m5b >= 20 && c.txns.m5s <= Math.max(1, c.txns.m5b * 0.05))
    p.push({ reason: 'honeypot pattern', adj: -20 });
  if ((c.flow?.devHoldPct || 0) > cfg.maxTopHolderPct)
    p.push({ reason: `dev holds ${c.flow!.devHoldPct!.toFixed(0)}%`, adj: -10 });
  if (c.flow?.bundled && ageMin < 5) p.push({ reason: 'bundled sniper pattern', adj: -10 });
  if (c.change.h1 < -40) p.push({ reason: 'dumping -40% 1h', adj: -12 });
  return pack(p);
}

export type SecurityOpts = { pumpCurve?: boolean; devHoldPct?: number };

/** On-chain/RugCheck flags as heavy penalties. Never blocks. Unknowns are 0. */
function securityPenalties(s: TokenSecurity): SafetyPenalty[] {
  const p: SafetyPenalty[] = [];
  if (s.rugged) p.push({ reason: 'flagged rugged', adj: -40 });
  if (s.mintAuthority) p.push({ reason: 'mint authority active', adj: -35 });
  if (s.freezeAuthority) p.push({ reason: 'freeze authority active', adj: -35 });
  for (const d of s.dangerRisks || []) {
    if (/honeypot|rugged/i.test(String(d))) p.push({ reason: String(d), adj: -35 });
  }
  return p;
}

export function securityCheck(s: TokenSecurity | null, _cfg: Config, opts: SecurityOpts = {}): SafetyResult {
  if (opts.pumpCurve) {
    const p = s?.available ? securityPenalties(s) : [];
    const r = pack(p);
    if (!p.length) r.label = 'no penalties · pump curve';
    return r;
  }
  if (!s || !s.available) return { ok: true, reasons: [], label: 'no penalties · security unknown', adj: 0, penalties: [] };
  const p = securityPenalties(s);
  const r = pack(p);
  if (!p.length) r.label = 'no penalties · LP · auth';
  return r;
}

export function clampScore(n: number) { return Math.max(0, Math.min(100, Math.round(n))); }

function k(x: number) { return x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(0) + 'k' : x.toFixed(0); }
