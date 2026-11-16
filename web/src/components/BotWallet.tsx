import { useState } from 'react';
import { api, usd, short } from '../api';
import { getPhantom, phantomBrowseUrl } from '../phantom';
import { PhantomIcon } from './Icons';

export const LOCK_MESSAGE = (address: string) =>
  `I am ${address} and I lock Grok Bot withdrawals exclusively to this Solana address.`;

export function copyText(s: string) {
  return navigator.clipboard?.writeText(s).catch(() => {
    const a = document.createElement('textarea'); a.value = s; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove();
  });
}

export function BotWalletPanel({ snap, compact = false }: { snap: any; compact?: boolean }) {
  const bw = snap.botWallet;
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const phantom = getPhantom();
  if (!bw?.publicKey) return <p className="note">Bot wallet is not configured on the server.</p>;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=8&data=${encodeURIComponent(bw.publicKey)}`;
  const tooLow = snap.lowBalance;

  async function lock() {
    setMsg(''); setBusy(true);
    try {
      const ph = getPhantom();
      if (!ph) throw new Error('Open this page in Phantom first');
      const r = await ph.connect();
      const address = r.publicKey.toString();
      const message = LOCK_MESSAGE(address);
      const signed = await ph.signMessage(new TextEncoder().encode(message), 'utf8');
      const sigBytes: Uint8Array = signed.signature || signed;
      const signature = btoa(String.fromCharCode(...sigBytes));
      await api('withdraw/lock', { address, message, signature });
      setMsg('Withdraw address locked ✓');
    } catch (e: any) { setMsg(e.message || String(e)); }
    setBusy(false);
  }

  async function withdraw() {
    if (!confirm('Send all SOL in the bot wallet to your locked Phantom address? This cannot be undone.')) return;
    setMsg(''); setBusy(true);
    try {
      const r = await api('withdraw', {});
      setMsg(`Sent ${usd(r.sol * (snap.stats?.solPrice || 0))} · closed ${r.closedAccounts} empty accounts`);
    } catch (e: any) { setMsg(e.message || String(e)); }
    setBusy(false);
  }

  return (
    <div className="bot-wallet" data-testid="bot-wallet">
      {!compact && <div className="sec-hd"><b>Bot wallet</b><span className="chip-live chip mono">LIVE AUTO</span></div>}
      <div className="bot-wallet-row">
        <img className="qr" src={qr} alt="Deposit QR" width={140} height={140} />
        <div className="bot-wallet-meta">
          <div className="muted tiny">deposit address (send SOL here)</div>
          <code className="addr" data-testid="bot-address">{bw.publicKey}</code>
          <button type="button" className="pill-btn small-btn ghost" onClick={() => copyText(bw.publicKey).then(() => setMsg('Address copied'))}>Copy address</button>
          <div className="mono small" style={{ marginTop: 8 }}>
            {usd(snap.stats?.cashUsd)} · {(snap.wallet?.solBalance || 0).toFixed(4)} SOL
          </div>
        </div>
      </div>
      {tooLow && <p className="note neg" data-testid="low-balance">{tooLow}</p>}
      {bw.withdrawLocked ? (
        <p className="tiny mono">Withdrawals locked to {short(bw.withdrawTo)} {bw.lockedBy === 'env' ? '(env)' : '(signed)'} — cannot be changed in the app.</p>
      ) : (
        <p className="note">Connect Phantom once and sign to lock withdrawals to <b>your</b> address. After that, nobody with the link can send funds elsewhere.</p>
      )}
      {msg && <p className="tiny">{msg}</p>}
      <div className="btn-row">
        {!bw.withdrawLocked && (
          phantom
            ? <button className="pill-btn small-btn" disabled={busy} onClick={lock} data-testid="lock-withdraw">Lock withdraw address</button>
            : <a className="pill-btn small-btn sheet-btn phantom-open" href={phantomBrowseUrl()} data-testid="open-in-phantom-lock"><PhantomIcon size={18} /> Open in Phantom to lock</a>
        )}
        {bw.withdrawLocked && <button className="pill-btn small-btn ghost" disabled={busy} onClick={withdraw} data-testid="withdraw">Withdraw to my Phantom</button>}
      </div>
    </div>
  );
}
