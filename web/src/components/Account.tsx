import { useState } from 'react';
import { api, usd, short } from '../api';
import { BotWalletPanel } from './BotWallet';
import { NotifyPanel } from './NotifyPanel';

const FIELDS: [string, string, number, number, number][] = [
  ['positionPct', 'Position size (% of free cash)', 1, 50, 1],
  ['takeProfitPct', 'Take profit (% net after fees/slip)', 0.5, 50, 0.5],
  ['hardStopPct', 'Catastrophic stop (% below entry)', 10, 80, 1],
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
        <div className="kv mono small"><span className="muted">cash</span><span>{w.solBalance.toFixed(4)} SOL · {usd(snap.stats.cashUsd)}{snap.mode !== 'paper' && typeof snap.stats.usdc === 'number' ? ` · ${Number(snap.stats.usdc).toFixed(2)} USDC` : ''}</span></div>
        {w.realSol != null && <div className="kv mono small"><span className="muted">on-chain (read only)</span><span>{w.realSol.toFixed(4)} SOL</span></div>}
        <div className="kv mono small"><span className="muted">SOL price</span><span>{usd(snap.stats.solPrice)}</span></div>
        <div className="kv mono small"><span className="muted">data</span><span>{snap.dataSource} · api errors {snap.apiErrors}</span></div>
        <p className="note">{snap.modeReason}</p>
        {snap.lowBalance && <p className="note neg" data-testid="low-balance">{snap.lowBalance}</p>}
        <div className="btn-row">
          <button className="pill-btn small-btn" data-testid="bot-toggle" onClick={() => api('bot/run', { running: !w.running })}>{w.running ? 'Stop bot' : 'Start bot'}</button>
          <button className="pill-btn small-btn ghost" data-testid="restart-bot-account" title="Restart loops and rescan now. Does not wipe positions or the withdraw lock." onClick={() => api('bot/restart', {})}>Restart bot / rescan</button>
          <button className="pill-btn small-btn ghost" onClick={onRecap}>Night recap</button>
        </div>
        <p className="tiny muted" data-testid="background-note">{snap.mode === 'paper'
          ? <>The bot trades on the server — you can close or reload the app without resetting the book. Connect / AUTO_START resume a saved book; they do not overwrite it. Only <b>Reset paper book</b> starts a fresh test balance. {snap.background?.remoteState?.configured ? 'Paper state is also saved off-disk so a redeploy can restore it.' : 'To keep the paper book across redeploys, add STATE_GITHUB_TOKEN on the host.'} On the free host, sleep after ~15 min idle is still possible; keepalive is not guaranteed.</>
          : <>Live mode shows only the bot wallet's on-chain SOL and USDC. Paper history is not used. Withdrawals go only to the locked Phantom address. On the free host, sleep after ~15 min idle is still possible; keepalive is not guaranteed.</>}</p>
      </div>
      <NotifyPanel snap={snap} />
      {snap.botWallet?.publicKey && <div className="section card"><BotWalletPanel snap={snap} /></div>}
      <div className="section card">
        <div className="sec-hd"><b>Risk & strategy</b><span className="pos small">{msg}</span></div>
        {FIELDS.map(([k, label, min, max, step]) => (
          <label key={k} className="field small" data-testid={k === "takeProfitPct" ? "take-profit-field" : undefined}><span>{label}</span><input type="number" min={min} max={max} step={step} value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} data-testid={k === "takeProfitPct" ? "take-profit-input" : undefined} /></label>
        ))}
        <label className="field small"><span>App name</span><input type="text" value={cfg.appName} onChange={(e) => setCfg({ ...cfg, appName: e.target.value })} /></label>
        {snap.mode === 'paper' && <>
        <label className="field small" data-testid="realistic-paper-field">
          <span>Realistic paper (settle TP on the real sell quote)</span>
          <input type="checkbox" checked={cfg.realisticPaper !== false} onChange={(e) => setCfg({ ...cfg, realisticPaper: e.target.checked })} data-testid="realistic-paper-input" />
        </label>
        <p className="tiny muted">On by default. Paper take-profit and sells use the live sell quote so results look like live. Turn off only if you want the optimistic mark fill.</p>
        </>}
        <button className="pill-btn" onClick={save}>Save settings</button>
      </div>
      <div className="section card">
        <div className="sec-hd"><b>{snap.mode === 'paper' ? 'Go live (later)' : 'Live status'}</b></div>
        <p className="small muted">{snap.mode === 'live-auto' ? 'LIVE AUTO is on: the bot wallet signs swaps. Withdrawals go only to the locked Phantom address. The app never shows or asks for a private key.' : snap.mode === 'live' ? 'LIVE (Phantom): every swap still needs your approval in Phantom. No private keys are stored.' : 'Real trading is locked unless the owner sets MODE=live or MODE=live-auto plus LIVE_CONFIRM and restarts.'}</p>
      </div>
      {snap.mode === 'paper' && <div className="section card">
        <div className="sec-hd"><b>Reset paper book</b></div>
        <p className="tiny muted">This is the only way to wipe paper positions, trades, equity, and learning. Leaving the app, reloading, or tapping Connect will not reset.</p>
        <div className="btn-row">
          <button className="pill-btn small-btn ghost" data-testid="reset-paper-book" onClick={async () => { if (confirm('Reset the paper book? This deletes all paper positions, trades, equity and learning. This cannot be undone.')) { await api('paper/reset', {}); onDisconnected(); } }}>Reset paper book</button>
          <button className="pill-btn small-btn ghost" onClick={async () => { await api('wallet/disconnect', {}); onDisconnected(); }}>Disconnect</button>
        </div>
      </div>}
      {snap.mode !== 'paper' && <div className="section card">
        <div className="btn-row">
          <button className="pill-btn small-btn ghost" onClick={async () => { await api('wallet/disconnect', {}); onDisconnected(); }}>Disconnect</button>
        </div>
      </div>}
    </div>
  );
}
