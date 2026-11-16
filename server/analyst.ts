// ANALYST agent - deterministic 0-100 score from momentum, flow, volume and liquidity.
import type { Candidate } from './types.ts';

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export type Score = { score: number; parts: Record<string, number>; bull: number; bear: number; note: string };

export function scoreCandidate(c: Candidate): Score {
  const parts: Record<string, number> = {};
  // 1. short-term momentum (25): want positive m5/m15/h1 but not a vertical blow-off
  const m = c.change;
  let mom = 0;
  mom += clamp(m.m5 / 6) * 8;           // +6% in 5m = full
  mom += clamp(m.m15 / 12) * 7;
  mom += clamp(m.h1 / 25) * 10;
  if (m.m5 > 40 || m.h1 > 250) mom *= 0.4; // chasing a blow-off top
  else if (m.h1 > 120) mom *= 0.6;
  if (m.m5 < -5) mom -= 6;
  parts.momentum = mom;
  // 2. buy pressure (25)
  const b5 = c.txns.m5b, s5 = c.txns.m5s, b1 = c.txns.h1b, s1 = c.txns.h1s;
  const r5 = b5 + s5 > 0 ? b5 / (b5 + s5) : 0.5;
  const r1 = b1 + s1 > 0 ? b1 / (b1 + s1) : 0.5;
  parts.flow = clamp((r5 - 0.45) / 0.25) * 13 + clamp((r1 - 0.45) / 0.2) * 12;
  // 3. activity: volume relative to liquidity (20)
  const turn1h = c.liquidityUsd > 0 ? c.volume.h1 / c.liquidityUsd : 0;
  parts.volume = clamp(turn1h / 1.0) * 12 + clamp(Math.log10(Math.max(1, c.volume.h1)) / 5.5) * 8;
  // 4. liquidity depth (15): deeper = safer exits
  parts.liquidity = clamp((Math.log10(Math.max(1, c.liquidityUsd)) - 4) / 2) * 15;
  // 5. participation (15)
  parts.traders = clamp(c.traders1h / 400) * 15;
  const raw = Object.values(parts).reduce((a, b) => a + b, 0);
  const score = Math.round(clamp(raw, 0, 100));
  // bull/bear "votes" like a debate panel (cosmetic summary of signals)
  const signals = [m.m5 > 0, m.h1 > 0, r5 > 0.55, r1 > 0.52, turn1h > 0.5, c.liquidityUsd > 50_000];
  const bull = signals.filter(Boolean).length;
  const bear = signals.length - bull;
  const note = `mom ${parts.momentum.toFixed(0)} · flow ${parts.flow.toFixed(0)} · vol ${parts.volume.toFixed(0)} · liq ${parts.liquidity.toFixed(0)} · traders ${parts.traders.toFixed(0)}`;
  return { score, parts, bull, bear, note };
}
