import { useEffect, useState } from 'react';
import { api, usd, pct, compact, price, age, sUsd } from '../api';
import { CandleChart } from './Charts';
import { TokenAvatar, BackI, StarI } from './Icons';

export function TokenDetail({ mint, onClose }: { mint: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [tf, setTf] = useState('1m');
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    const load = () => api(`token/${encodeURIComponent(mint)}?tf=${tf}`).then((x) => on && setD(x)).catch((e) => setErr(e.message));
    load();
    const iv = setInterval(load, 15000);
    return () => { on = false; clearInterval(iv); };
  }, [mint, tf]);
  const pos = d?.position;
  const last = d?.trades?.[0];
  const sinceEntry = pos ? (pos.lastPrice / pos.entryPrice - 1) * 100 : null;
  return (
    <div className="token dark-fixed">
      <div className="tk-top"><button className="link-btn" onClick={onClose}><BackI size={18} /> Home</button><StarI size={20} /></div>
      {!d && <div className="muted" style={{ padding: 20 }}>{err || 'loading…'}</div>}
      {d && <>
        <div className="tk-hd"><TokenAvatar src={d.image} symbol={d.symbol} size={40} /><div><b>{d.name || d.symbol}</b><div className="muted small">{d.symbol} · Solana · {age(d.createdAt)}</div></div></div>
        <div className="tk-price">{price(d.priceUsd)}</div>
        <div className={`small ${((sinceEntry ?? d.change?.h1) || 0) >= 0 ? 'pos' : 'neg'}`}>{sinceEntry !== null ? `▲ ${pct(sinceEntry)} since entry` : `${pct(d.change?.h1)} 1h`}</div>
        <CandleChart candles={d.candles} markers={d.markers} stopLevel={pos?.stop?.level} stopLabel={pos?.stop?.kind === 'trailing' ? 'Risk trailing stop' : `Risk stop -${d.hardStopPct}%`} />
        <div className="ranges dark">{['1m', '5m', '15m', '1h'].map((t) => <button key={t} className={t === tf ? 'on' : ''} onClick={() => setTf(t)}>{t}</button>)}</div>
        <div className="stats-grid">
          <div><span className="muted tiny">Market cap</span><b>${compact(d.mcapUsd)}</b></div>
          <div><span className="muted tiny">Liquidity</span><b>${compact(d.liquidityUsd)}</b></div>
          <div><span className="muted tiny">Holders</span><b>{d.holders != null ? d.holders.toLocaleString() : '—'}</b></div>
          <div><span className="muted tiny">24h volume</span><b>${compact(d.volume24h)}</b></div>
        </div>
        {pos ? (
          <div className="tk-card"><span className="ag-ico" style={{ background: '#8b5cf6' }}>💼</span><div className="grow"><b>Your position</b><div className="muted tiny">{usd(pos.costUsd)} in · Executor</div></div>
            <div className="act-right"><b>{usd(pos.valueUsd)}</b><div className={`tiny ${pos.valueUsd >= pos.costUsd ? 'pos' : 'neg'}`}>{sUsd(pos.valueUsd - pos.costUsd)}</div></div></div>
        ) : last ? (
          <div className="tk-card"><span className="ag-ico" style={{ background: '#8b5cf6' }}>💼</span><div className="grow"><b>Last trade</b><div className="muted tiny">{usd(last.costUsd)} in · {last.reason}</div></div>
            <div className="act-right"><b>{usd(last.proceedsUsd)}</b><div className={`tiny ${last.pnlUsd >= 0 ? 'pos' : 'neg'}`}>{sUsd(last.pnlUsd)}</div></div></div>
        ) : <div className="tk-card"><div className="grow muted small">Not held · analyst score {d.score ?? '—'} · safety: {d.safety || '—'}</div></div>}
        <div className="tk-card"><span className="ag-ico" style={{ background: '#f97316' }}>⚖️</span><div className="grow"><b>Risk · trailing stop</b><div className="muted tiny">exit if it drops {d.trailingStopPct}% from top · hard stop -{d.hardStopPct}%</div></div>
          {pos && <div className="act-right"><b className="warn">{price(pos.stop.level)}</b><div className="muted tiny">{pos.stop.kind}</div></div>}</div>
        <a className="muted tiny ext" href={`https://dexscreener.com/solana/${d.pool || d.mint}`} target="_blank" rel="noreferrer">view on DexScreener ↗</a>
      </>}
    </div>
  );
}
