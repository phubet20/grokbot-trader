import { useState } from 'react';
import { api } from '../api';

export function ModeBadge({ snap, className = '' }: { snap: any; className?: string }) {
  const live = snap.mode !== 'paper';
  const paused = !snap.wallet?.running;
  return (
    <span
      className={`live-pill ${paused ? 'off' : ''} ${live ? 'live' : 'test'} ${className}`}
      title={snap.modeReason}
      data-testid="mode-badge"
    >
      <i />
      {paused ? 'Paused · ' : ''}{live ? 'LIVE' : 'TEST'}
    </span>
  );
}

export function ModeToggle({ snap, compact }: { snap: any; compact?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const live = snap.mode !== 'paper';
  const canLive = !!snap.canSwitchLive || !!snap.liveArmed;

  async function goTest() {
    setBusy(true); setErr('');
    try {
      await api('mode', { mode: 'paper' }, { timeoutMs: 20000 });
    } catch (e: any) { setErr(e?.message || 'switch failed'); }
    setBusy(false);
  }
  async function goLive() {
    setBusy(true); setErr('');
    try {
      await api('mode', { mode: 'live-auto' }, { timeoutMs: 20000 });
      setConfirm(false);
    } catch (e: any) { setErr(e?.message || 'switch failed'); }
    setBusy(false);
  }

  return (
    <>
      <button
        className={`pill-btn small-btn ${live ? 'ghost' : ''}`}
        data-testid="mode-toggle"
        disabled={busy || (!live && !canLive)}
        title={live ? 'Switch to TEST (paper). Live positions stay open and still exit on-chain.' : (canLive ? 'Switch to LIVE (real funds).' : 'LIVE is not armed on this host')}
        onClick={() => { if (live) void goTest(); else setConfirm(true); }}
      >
        {busy ? 'Switching…' : live ? (compact ? 'TEST' : 'Switch to TEST') : (compact ? 'LIVE' : 'Switch to LIVE')}
      </button>
      {err && <span className="tiny neg">{err}</span>}
      {confirm && (
        <div className="mode-confirm" data-testid="mode-live-confirm" role="dialog" aria-modal="true">
          <div className="mode-confirm-card">
            <b>Switch to LIVE?</b>
            <p className="small">The bot will trade real SOL in the bot wallet. This uses real money. Paper and live history stay fully separate. Learning from TEST carries over.</p>
            <div className="btn-row">
              <button className="pill-btn small-btn" data-testid="confirm-live" disabled={busy} onClick={() => void goLive()}>Yes, go LIVE</button>
              <button className="pill-btn small-btn ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
