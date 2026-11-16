import { useState } from 'react';
import { api, usd, short } from '../api';
import { BotWalletPanel } from './BotWallet';
import { NotifyPanel } from './NotifyPanel';

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
        {snap.lowBalance && <p className="note neg" data-testid="low-balance">{snap.lowBalance}</p>}
        <div className="btn-row">
          <button className="pill-btn small-btn" data-testid="bot-toggle" onClick={() => api('bot/run', { running: !w.running })}>{w.running ? 'Stop bot' : 'Start bot'}</button>
          <button className="pill-btn small-btn ghost" onClick={onRecap}>Night recap</button>
        </div>
        <p className="tiny muted" data-testid="background-note">The bot trades on the server — you can close the app. Start/Stop is saved and comes back after a restart. On the free host, sleep after ~15 min idle is still possible; a keepalive ping tries to prevent it but is not guaranteed, and without a persistent disk a sleep or redeploy can reset the saved state.</p>
      </div>
      <NotifyPanel snap={snap} />
      {snap.botWallet?.publicKey && <div className="section card"><BotWalletPanel snap={snap} /></div>}
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
        <p className="small muted">{snap.mode === 'live-auto' ? 'LIVE AUTO is on: the bot wallet signs swaps. Withdrawals go only to the locked Phantom address. The app never shows or asks for a private key.' : snap.mode === 'live' ? 'LIVE (Phantom): every swap still needs your approval in Phantom. No private keys are stored.' : 'Real trading is locked unless the owner sets MODE=live or MODE=live-auto plus LIVE_CONFIRM and restarts.'}</p>
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
