import { useEffect, useRef, useState } from 'react';
import { api, usd, sUsd, hhmm, pct } from '../api';
import { BotIcon, TokenAvatar } from './Icons';
import type { Toast } from '../api';

export function Confetti({ fire }: { fire: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!fire || !ref.current) return;
    const cv = ref.current, ctx = cv.getContext('2d')!;
    cv.width = cv.clientWidth * 2; cv.height = cv.clientHeight * 2;
    const cols = ['#22c55e', '#facc15', '#3b82f6', '#ec4899', '#a855f7', '#f97316'];
    const ps = Array.from({ length: 140 }, () => ({ x: cv.width / 2, y: cv.height * 0.18, vx: (Math.random() - 0.5) * 26, vy: -Math.random() * 22 - 6, r: Math.random() * 6 + 4, c: cols[Math.floor(Math.random() * cols.length)], a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4 }));
    let f = 0, raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const p of ps) { p.vy += 0.7; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.a += p.va; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore(); }
      if (++f < 150) raf = requestAnimationFrame(draw); else ctx.clearRect(0, 0, cv.width, cv.height);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [fire]);
  return <canvas ref={ref} className="confetti" />;
}

export function Toasts({ toasts, appName }: { toasts: Toast[]; appName: string }) {
  return (
    <div className="toasts">
      {toasts.slice(-2).map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <BotIcon size={34} />
          <div className="grow">
            <div className="tiny muted">{appName} · now</div>
            <b>{t.title}</b>
            {t.kind === 'profit' ? <div className="pos small">{sUsd(t.usd || 0)} ({pct(t.pct)}) · paper</div> : <div className="muted small">{t.text}</div>}
          </div>
          {t.symbol && <TokenAvatar src={t.image} symbol={t.symbol} size={28} />}
        </div>
      ))}
    </div>
  );
}

export function Recap({ appName, stopPct, onClose }: { appName: string; stopPct: number; onClose: () => void }) {
  const [r, setR] = useState<any>(null);
  useEffect(() => { api('recap').then(setR).catch(() => {}); }, []);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="recap" onClick={(e) => e.stopPropagation()}>
        <div className="row"><BotIcon size={40} /><div><b style={{ fontSize: 20 }}>Night recap</b><div className="muted tiny mono">{r?.since ? `${hhmm(r.since)} → ${hhmm(Date.now())}` : ''} · 3 repos · {r ? Math.round(r.runtimeMin) : 0} min · {r?.mode && r.mode !== 'paper' ? 'LIVE' : 'TEST'}</div></div></div>
        {r && <>
          <div className="muted small mt">put in</div><div className="recap-in">{usd(r.deposit)}</div>
          <div className="muted small">now worth</div>
          <div className="row between"><div className={`recap-now ${r.equity >= r.deposit ? 'pos' : 'neg'}`}>{usd(r.equity)}</div><span className="mult mono">{r.multiplier.toFixed(2)}×</span></div>
          <div className="recap-grid">
            <div><span className="muted tiny">trades</span><b>{r.trades}</b></div><div><span className="muted tiny">coins</span><b>{r.coins}</b></div>
            <div><span className="muted tiny">repos</span><b>3</b></div><div><span className="muted tiny">agents</span><b>5</b></div>
          </div>
          <div className="mono tiny recap-lines">
            <div>best <b className="pos">{r.best ? `$${r.best.symbol} ${sUsd(r.best.usd)}` : '—'}</b></div>
            <div>worst <b className="neg">{r.worst ? `$${r.worst.symbol} ${sUsd(r.worst.usd)}` : '—'}</b></div>
            <div>win rate {r.winRate.toFixed(0)}% ({r.wins}W/{r.losses}L) · stop -{stopPct}% on every trade</div>
          </div>
        </>}
        <button className="dark-btn" onClick={onClose}>trade with {appName} × Phantom</button>
      </div>
    </div>
  );
}
