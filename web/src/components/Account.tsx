import { useState } from 'react';
import { api, usd, short } from '../api';

const FIELDS: [string, string, number, number, number][] = [
  ['positionPct', 'Position size (% of portfolio)', 1, 50, 1],
  ['maxPositions', 'Max open positions', 1, 20, 1],
  ['hardStopPct', 'Hard stop (% below entry)', 1, 50, 0.5],
  ['trailingStopPct', 'Trailing stop (% from top)', 2, 60, 0.5],
  ['dailyLossLimitPct', 'Daily loss limit (%)', 1, 100, 1],
  ['maxHoldMin', 'Max hold (minutes)', 5, 1440, 5],
  ['minScore', 'Analyst min score', 0, 100, 1],
  ['minLiquidityUsd', 'Min liquidity ($)', 1000, 1e7, 1000],
  ['minHolders', 'Min holders', 0, 1e6, 10],
  ['slippageBps', 'Slippage tolerance (bps)', 10, 2000, 10],
];

export function Account({ snap, onRecap, onDisconnected }: { snap: any; onRecap: () => void; onDisconnected: () => void }) {
  const [cfg, setCfg] = useState<any>({ ...snap.config });
  const [msg, setMsg] = useState('');
  const save = async () => { try { await api('config', cfg); setMsg('Saved ✓'); } catch (e: any) { setMsg(e.message); } setTimeout(() => setMsg(''), 2000); };
  const w = snap.wallet;
  return (
    <div className="page">
      <div className="section card">
        <div className="sec-hd"><b>Wallet</b><span className={`chip mono ${snap.mode === 'live' ? 'chip-live' : 'chip-test'}`}>{snap.mode === 'live' ? 'LIVE' : 'TEST MODE'}</span></div>
        <div className="kv mono small"><span className="muted">type</span><span>{w.type}</span></div>
        <div className="kv mono small"><span className="muted">address</span><span>{short(w.address)}</span></div>
        <div className="kv mono small"><span className="muted">cash</span><span>{w.solBalance.toFixed(4)} SOL · {usd(snap.stats.cashUsd)}</span></div>
        {w.realSol != null && <div className="kv mono small"><span className="muted">on-chain (read only)</span><span>{w.realSol.toFixed(4)} SOL</span></div>}
        <div className="kv mono small"><span className="muted">SOL price</span><span>{usd(snap.stats.solPrice)}</span></div>
        <div className="kv mono small"><span className="muted">data</span><span>{snap.dataSource} · api errors {snap.apiErrors}</span></div>
        <p className="note">{snap.modeReason}</p>
        <div className="btn-row">
          <button className="pill-btn small-btn" onClick={() => api('bot/run', { running: !w.running })}>{w.running ? 'Pause bot' : 'Resume bot'}</button>
          <button className="pill-btn small-btn ghost" onClick={onRecap}>Night recap</button>
        </div>
      </div>
      <div className="section card">
        <div className="sec-hd"><b>Risk & strategy</b><span className="pos small">{msg}</span></div>
        {FIELDS.map(([k, label, min, max, step]) => (
          <label key={k} className="field small"><span>{label}</span><input type="number" min={min} max={max} step={step} value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} /></label>
        ))}
        <label className="field small"><span>App name</span><input type="text" value={cfg.appName} onChange={(e) => setCfg({ ...cfg, appName: e.target.value })} /></label>
        <button className="pill-btn" onClick={save}>Save settings</button>
      </div>
      <div className="section card">
        <div className="sec-hd"><b>Go live (later)</b></div>
        <p className="small muted">Real trading is locked. It can only be enabled by the owner editing <code>data/config.json</code> (<code>"mode": "live"</code> + the exact confirmation phrase in <code>"liveConfirm"</code>) and restarting. Every live swap must then be approved in Phantom.</p>
      </div>
      {snap.mode !== 'live' && <div className="section card">
        <div className="btn-row">
          <button className="pill-btn small-btn ghost" onClick={async () => { if (confirm('Reset the paper account? All test trades are deleted.')) { await api('reset', {}); onDisconnected(); } }}>Reset test account</button>
          <button className="pill-btn small-btn ghost" onClick={async () => { await api('wallet/disconnect', {}); onDisconnected(); }}>Disconnect</button>
        </div>
      </div>}
    </div>
  );
}
