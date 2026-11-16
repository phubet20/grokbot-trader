import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import { price as fmtPrice, usd, hhmm } from '../api';

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 360));
    ro.observe(el); setW(el.clientWidth || 360);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Smooth portfolio value line (catmull-rom) with gradient fill and "put in" baseline. */
export function LineChart({ points, baseline, height = 170 }: { points: { ts: number; usd: number }[]; baseline?: number; height?: number }) {
  const [ref, w] = useWidth();
  const g = useMemo(() => {
    const pts = points.length === 1 ? [points[0], { ...points[0], ts: points[0].ts + 1 }] : points;
    if (pts.length < 2) return null;
    const ys = pts.map((p) => p.usd).concat(baseline ? [baseline] : []);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (hi - lo < hi * 0.002) { lo -= hi * 0.002 + 0.01; hi += hi * 0.002 + 0.01; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    const X = (t: number) => 4 + ((t - t0) / Math.max(1, t1 - t0)) * (w - 22);
    const Y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (height - 16);
    const xy = pts.map((p) => [X(p.ts), Y(p.usd)]);
    let d = `M${xy[0][0]},${xy[0][1]}`;
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] || xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
    }
    const last = xy[xy.length - 1];
    const up = pts[pts.length - 1].usd >= (baseline ?? pts[0].usd);
    return { d, area: `${d} L${last[0]},${height} L${xy[0][0]},${height} Z`, last, up, by: baseline ? Y(baseline) : null, t0, t1 };
  }, [points, baseline, w, height]);
  const col = g?.up === false ? 'var(--red)' : 'var(--green)';
  return (
    <div ref={ref} className="linechart">
      <svg width={w} height={height}>
        <defs><linearGradient id="lcfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={col} stopOpacity="0.28" /><stop offset="1" stopColor={col} stopOpacity="0" /></linearGradient></defs>
        {g?.by != null && <line x1="0" x2={w} y1={g.by} y2={g.by} stroke="var(--muted)" strokeDasharray="3 4" strokeWidth="1" opacity="0.6" />}
        {g && <><path d={g.area} fill="url(#lcfill)" /><path d={g.d} fill="none" stroke={col} strokeWidth="2.4" strokeLinejoin="round" />
          <circle cx={g.last[0]} cy={g.last[1]} r="5.5" fill="var(--card)" stroke={col} strokeWidth="2.5"><animate attributeName="r" values="4.5;6.5;4.5" dur="1.6s" repeatCount="indefinite" /></circle></>}
        {!g && <text x={w / 2} y={height / 2} textAnchor="middle" fill="var(--muted)" fontSize="12" fontFamily="var(--mono)">collecting data…</text>}
      </svg>
      {g && <div className="lc-axis mono"><span>{hhmm(g.t0)}</span><span>— value &nbsp;-- put in</span><span>{hhmm(g.t1)}</span></div>}
    </div>
  );
}

type Candle = [number, number, number, number, number, number];
export function CandleChart({ candles, markers, stopLevel, stopLabel = 'Risk trailing stop', height = 260 }: { candles: Candle[]; markers: { ts: number; price: number; kind: string; label: string }[]; stopLevel?: number; stopLabel?: string; height?: number }) {
  const [ref, w] = useWidth();
  const g = useMemo(() => {
    const cs = candles.slice(-70);
    if (cs.length < 2) return null;
    let lo = Math.min(...cs.map((c) => c[3])), hi = Math.max(...cs.map((c) => c[2]));
    if (stopLevel && stopLevel > lo * 0.7) { lo = Math.min(lo, stopLevel); hi = Math.max(hi, stopLevel); }
    const pad = (hi - lo) * 0.08 || hi * 0.01; lo -= pad; hi += pad;
    const right = 8, cw = (w - right) / cs.length;
    const Y = (v: number) => 10 + (1 - (v - lo) / (hi - lo)) * (height - 20);
    const t0 = cs[0][0] * 1000, tEnd = cs[cs.length - 1][0] * 1000, dt = cs.length > 1 ? (cs[1][0] - cs[0][0]) * 1000 : 60000;
    const X = (ts: number) => ((ts - t0) / dt) * cw + cw / 2;
    const ms = markers.filter((m) => m.ts >= t0 - dt && m.ts <= tEnd + dt * 2).map((m) => ({ ...m, x: Math.min(w - 30, Math.max(30, X(m.ts))), y: Y(Math.min(hi, Math.max(lo, m.price))) }));
    return { cs, cw, Y, ms, stopY: stopLevel ? Y(stopLevel) : null };
  }, [candles, markers, stopLevel, w, height]);
  return (
    <div ref={ref} className="candles">
      <svg width={w} height={height}>
        {g ? <>
          {g.stopY != null && g.stopY > 0 && g.stopY < height && <><line x1="0" x2={w} y1={g.stopY} y2={g.stopY} stroke="#f5a623" strokeDasharray="4 4" strokeWidth="1.2" /><rect x="4" y={g.stopY - 15} width={stopLabel.length * 5.6 + 10} height="13" rx="3" fill="#3a2a0a" /><text x="8" y={g.stopY - 5} fill="#f5a623" fontSize="9" fontFamily="var(--mono)">{stopLabel}</text></>}
          {g.cs.map((c, i) => {
            const up = c[4] >= c[1], x = i * g.cw + g.cw / 2, col = up ? '#22c55e' : '#ef4444';
            const y1 = g.Y(Math.max(c[1], c[4])), y2 = g.Y(Math.min(c[1], c[4]));
            return <g key={i}><line x1={x} x2={x} y1={g.Y(c[2])} y2={g.Y(c[3])} stroke={col} strokeWidth="1" /><rect x={x - g.cw * 0.34} y={y1} width={Math.max(1.5, g.cw * 0.68)} height={Math.max(1, y2 - y1)} fill={col} rx="0.5" /></g>;
          })}
          {g.ms.map((m, i) => {
            const buy = m.kind === 'buy', lw = m.label.length * 5.6 + 12, ty = buy ? m.y + 16 : m.y - 26;
            return <g key={i}><circle cx={m.x} cy={m.y} r="3.5" fill={buy ? '#3b82f6' : '#f5a623'} stroke="#fff" strokeWidth="1" />
              <rect x={Math.min(w - lw - 2, Math.max(2, m.x - lw / 2))} y={ty} width={lw} height="16" rx="8" fill={buy ? '#2563eb' : '#b45309'} />
              <text x={Math.min(w - lw - 2, Math.max(2, m.x - lw / 2)) + lw / 2} y={ty + 11.5} textAnchor="middle" fill="#fff" fontSize="9.5" fontWeight="600">{m.label}</text></g>;
          })}
        </> : <text x={w / 2} y={height / 2} textAnchor="middle" fill="#777" fontSize="12">loading candles…</text>}
      </svg>
    </div>
  );
}

export function Sparkline({ values, w = 60, h = 20 }: { values: number[]; w?: number; h?: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values) || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1)) * w},${h - ((v - lo) / (hi - lo || 1)) * h}`).join(' ');
  return <svg width={w} height={h}><path d={d} fill="none" stroke={values[values.length - 1] >= values[0] ? 'var(--green)' : 'var(--red)'} strokeWidth="1.5" /></svg>;
}
export { fmtPrice, usd };
