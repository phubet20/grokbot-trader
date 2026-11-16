// ANALYST agent — score 0-100 from big-money flow, not EMA/RSI.
// Weights: whale/large buys, net-buy acceleration, unique-buyer growth,
// bonding-curve progress velocity, and anti-bundle / dev-not-selling quality.
import type { Candidate } from './types.ts';

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export type Score = { score: number; parts: Record<string, number>; bull: number; bear: number; note: string };

export function scoreCandidate(c: Candidate): Score {
  const parts: Record<string, number> = {};
  const b5 = c.txns.m5b, s5 = c.txns.m5s, b1 = c.txns.h1b, s1 = c.txns.h1s;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0.5;
  const r1 = b1 + s1 > 0 ? b1 / (b1 + s1) : 0.5;
  const flow = c.flow;
  const netUsd = flow?.netBuyUsd ?? ((c.volume.m5 || 0) * (r5 - (1 - r5)));
  const unique = flow?.uniqueBuyers || c.traders1h || 0;
  const whale = flow?.whaleBuyUsd || 0;
  const avgBuy = b5 > 0 ? (c.volume.m5 || 0) / b5 : 0;
  const largeBuys = flow?.largeBuys ?? (avgBuy >= 40 ? Math.min(5, Math.round(avgBuy / 40)) : 0);
  const progress = c.curve?.progress ?? flow?.progress ?? 0;
  const vel = flow?.progressVel ?? 0;
  const ageMin = Math.max(0.05, (Date.now() - (c.createdAt || Date.now())) / 60_000);

  // 1. large / whale buys (22)
  const whaleScore = clamp((whale || avgBuy) / 80) * 14 + clamp(largeBuys / 3) * 8;
  parts.whale = whaleScore * (flow?.bundled ? 0.35 : 1);

  // 2. net buy volume acceleration (22)
  const net5 = r5 - 0.5;
  const net1 = r1 - 0.5;
  const accel = net5 - net1 * 0.5;
  parts.accel = clamp((netUsd > 0 ? 1 : 0.3) * (0.5 + net5 * 2)) * 12 + clamp(accel / 0.25) * 10;
  if (s5 > b5 * 1.15) parts.accel *= 0.25;
  if (netUsd < 0) parts.accel *= 0.5;

  // 3. unique buyer growth (16)
  const buyerRate = unique / Math.max(ageMin, 0.5);
  parts.buyers = clamp(unique / 40) * 9 + clamp(buyerRate / 8) * 7;
  if (unique <= 2 && (c.volume.m5 || 0) > 200) parts.buyers *= 0.3; // bundled / sniper

  // 4. bonding-curve progress velocity (16) — for graduated AMM, use volume burst instead
  if (c.curve && !c.curve.graduated) {
    parts.curve = clamp(progress / 0.85) * 7 + clamp(vel / 0.15) * 9;
  } else {
    const burst = c.liquidityUsd > 0 ? (c.volume.m5 || 0) / c.liquidityUsd : 0;
    parts.curve = clamp(burst / 0.4) * 16;
  }

  // 5. quality: dev not selling, no bundle dump, not a vertical blow-off with no buyers (14)
  let qual = 14;
  if (flow?.devSold) qual -= 10;
  if (flow?.bundled) qual -= 8;
  if ((flow?.devHoldPct || 0) > 12) qual -= 6;
  if ((flow?.largeSells || 0) > (largeBuys || 0) + 1) qual -= 6;
  if (c.change.m5 > 50) qual -= unique < 15 ? 8 : 5;
  if (r5 < 0.45) qual -= 6;
  if ((c.change.m5 || 0) < -5) { parts.accel *= 0.4; parts.whale *= 0.5; parts.curve *= 0.6; qual -= 5; }
  parts.quality = Math.max(0, qual);

  // 6. exit room / liquidity (10)
  const liq = c.liquidityUsd || 0;
  parts.liquidity = clamp((Math.log10(Math.max(1, liq)) - 2.5) / 2.5) * 10;

  // 7. SMC timing (8) + daily narrative alignment (8) — additive, existing weights kept
  parts.smc = c.smc?.ok ? 8 : 0;
  parts.narrative = Math.max(0, Math.min(8, c.narrativeBoost || 0));

  const raw = Object.values(parts).reduce((a, b) => a + b, 0);
  const score = Math.round(clamp(raw, 0, 100));
  const signals = [net5 > 0, r5 > 0.55, unique >= 8, whale > 20 || largeBuys > 0, !flow?.devSold, !flow?.bundled, (c.change.m5 || 0) > -3];
  const bull = signals.filter(Boolean).length;
  const bear = signals.length - bull;
  const note = `whale ${parts.whale.toFixed(0)} · accel ${parts.accel.toFixed(0)} · buyers ${parts.buyers.toFixed(0)} · curve ${parts.curve.toFixed(0)} · qual ${parts.quality.toFixed(0)}` + (parts.smc ? ' · smc' : '') + (parts.narrative ? ' · meta' : '');
  return { score, parts, bull, bear, note };
}
