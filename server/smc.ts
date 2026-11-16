// Smart-money concepts from OHLCV: BOS, CHoCH, order blocks, FVG.
// Entries fire on a pullback into an OB or FVG after a bullish BOS or CHoCH.
import type { Candle } from './market.ts';

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Zone = { lo: number; hi: number; t: number; kind: 'ob' | 'fvg'; after: 'bos' | 'choch' };
export type SmcEvent = { t: number; kind: 'bos' | 'choch'; dir: 'bull' | 'bear'; level: number; i: number };
export type SmcSignal = { ok: boolean; reason: string; kind: string; tf?: string };

export function toBars(cs: Candle[]): Bar[] {
  return (cs || []).filter((r) => r && r.length >= 6 && r[2] > 0).map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] || 0 }));
}

/** Swing high/low using a 2-bar pivot. */
export function swings(bars: Bar[], left = 1, right = 1): { i: number; px: number; type: 'h' | 'l' }[] {
  const out: { i: number; px: number; type: 'h' | 'l' }[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const hi = bars[i].h, lo = bars[i].l;
    let isH = true, isL = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (bars[k].h >= hi) isH = false;
      if (bars[k].l <= lo) isL = false;
    }
    if (isH) out.push({ i, px: hi, type: 'h' });
    else if (isL) out.push({ i, px: lo, type: 'l' });
  }
  return out;
}

export function detectBosChoch(bars: Bar[]): SmcEvent[] {
  const ev: SmcEvent[] = [];
  const sw = swings(bars);
  if (sw.length < 3 || bars.length < 8) return ev;
  let trend: 'bull' | 'bear' | null = null;
  let lastH = sw.find((s) => s.type === 'h');
  let lastL = sw.find((s) => s.type === 'l');
  for (const s of sw) {
    if (s.type === 'h') lastH = s;
    else lastL = s;
  }
  // Walk bars after the first few swings and flag breaks.
  for (let i = 4; i < bars.length; i++) {
    const prior = sw.filter((s) => s.i < i);
    const highs = prior.filter((s) => s.type === 'h');
    const lows = prior.filter((s) => s.type === 'l');
    const sh = highs[highs.length - 1];
    const sl = lows[lows.length - 1];
    const close = bars[i].c;
    if (sh && close > sh.px) {
      const kind = trend === 'bear' ? 'choch' : 'bos';
      if (!ev.length || ev[ev.length - 1].i !== i || ev[ev.length - 1].dir !== 'bull')
        ev.push({ t: bars[i].t, kind, dir: 'bull', level: sh.px, i });
      trend = 'bull';
    } else if (sl && close < sl.px) {
      const kind = trend === 'bull' ? 'choch' : 'bos';
      if (!ev.length || ev[ev.length - 1].i !== i || ev[ev.length - 1].dir !== 'bear')
        ev.push({ t: bars[i].t, kind, dir: 'bear', level: sl.px, i });
      trend = 'bear';
    }
  }
  return ev;
}

/** Last opposite (bearish) candle before a bullish break becomes an order block. */
export function orderBlocks(bars: Bar[], events: SmcEvent[]): Zone[] {
  const zs: Zone[] = [];
  for (const e of events) {
    if (e.dir !== 'bull') continue;
    for (let i = e.i - 1; i >= Math.max(0, e.i - 8); i--) {
      if (bars[i].c < bars[i].o) {
        const lo = Math.min(bars[i].l, bars[i].c);
        const hi = Math.max(bars[i].o, bars[i].c);
        if (hi > lo) zs.push({ lo, hi, t: bars[i].t, kind: 'ob', after: e.kind });
        break;
      }
    }
  }
  return zs;
}

/** 3-candle bullish fair-value gap: candle[i-2].h < candle[i].l. */
export function fairValueGaps(bars: Bar[], events: SmcEvent[]): Zone[] {
  const lastBull = [...events].reverse().find((e) => e.dir === 'bull');
  const zs: Zone[] = [];
  const from = lastBull ? Math.max(2, lastBull.i - 12) : 2;
  for (let i = Math.max(2, from); i < bars.length; i++) {
    const left = bars[i - 2].h, right = bars[i].l;
    if (right > left && (right - left) / Math.max(left, 1e-12) >= 0.0015) {
      const after = lastBull && i >= lastBull.i - 1 ? lastBull.kind : 'bos';
      zs.push({ lo: left, hi: right, t: bars[i].t, kind: 'fvg', after });
    }
  }
  return zs;
}

function inZone(px: number, z: Zone, pad = 0.001) {
  return px <= z.hi * (1 + pad) && px >= z.lo * (1 - pad);
}

/** Pullback into an unfilled bullish OB/FVG after a BOS or CHoCH, with the close holding. */
export function smcEntry(candles: Candle[], tf = '1m'): SmcSignal {
  const bars = toBars(candles);
  if (bars.length < 12) return { ok: false, reason: '', kind: '' };
  const ev = detectBosChoch(bars);
  const lastBull = [...ev].reverse().find((e) => e.dir === 'bull');
  if (!lastBull) return { ok: false, reason: '', kind: '' };
  // Break should be recent enough to still be the active structure (last 18 bars).
  if (bars.length - 1 - lastBull.i > 18) return { ok: false, reason: '', kind: '' };
  const lastBear = ev.filter((e) => e.i > lastBull.i && e.dir === 'bear');
  if (lastBear.length) return { ok: false, reason: '', kind: '' }; // structure already flipped
  const zs = [...orderBlocks(bars, [lastBull]), ...fairValueGaps(bars, [lastBull])];
  if (!zs.length) return { ok: false, reason: '', kind: '' };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  // Wait for a pullback (not a breakout chase): wick or close into a zone, close holds above zone low, not still falling through it.
  const hit = [...zs].reverse().find((z) => inZone(last.l, z) || inZone(last.c, z) || inZone(prev.l, z));
  if (!hit) return { ok: false, reason: '', kind: '' };
  if (last.c < hit.lo * 0.998) return { ok: false, reason: '', kind: '' };
  if (last.c < prev.c && last.c < hit.lo * 1.002) return { ok: false, reason: 'still falling through zone', kind: '' };
  const tag = hit.after === 'choch' ? 'CHoCH' : 'BOS';
  const zone = hit.kind === 'fvg' ? 'FVG' : 'OB';
  return { ok: true, reason: `${zone} pullback after ${tag}`, kind: `${hit.kind}-pullback`, tf };
}

export function smcFromTimeframes(one: Candle[], five: Candle[] = []): SmcSignal {
  const a = smcEntry(one, '1m');
  if (a.ok) return a;
  const b = smcEntry(five, '5m');
  if (b.ok) return b;
  return a.ok ? a : b;
}
