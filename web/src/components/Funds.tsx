import { useEffect, useState } from 'react';
import { api, usd, short } from '../api';
import { PhantomIcon, WalletI } from './Icons';
import { copyText, LOCK_MESSAGE } from './BotWallet';
import { getPhantom, phantomBrowseUrl } from '../phantom';

const BOT_FALLBACK = '2VscQ33yZudTXXNjCpfB5X4jsJVL4ZoZxGDzS5xCtLYo';

function solanaPay(addr: string, sol?: number) {
  return `solana:${addr}${sol && sol > 0 ? `?amount=${sol}&label=${encodeURIComponent('Grok Bot')}` : ''}`;
}
function phantomPay(addr: string, sol?: number) {
  return `https://phantom.app/ul/browse/${encodeURIComponent(solanaPay(addr, sol))}?ref=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`;
}

export function Funds({ snap }: { snap: any }) {
  const paper = snap.mode === 'paper';
  const bw = snap.botWallet || {};
  const addr = bw.publicKey || BOT_FALLBACK;
  const locked = bw.withdrawTo || null;
  const [funds, setFunds] = useState<any>(null);
  const [solAmt, setSolAmt] = useState('');
  const [depAmt, setDepAmt] = useState('0.05');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const phantom = getPhantom();

  async function refresh() {
    try { setFunds(await api('funds')); } catch { /* keep last */ }
  }
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 12_000); return () => clearInterval(t); }, []);

  const onchainSol = funds?.onchainSol;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(solanaPay(addr))}`;
  const maxSol = typeof onchainSol === 'number' ? Math.max(0, onchainSol - 0.00001) : 0;

  async function copyAddr() {
    await copyText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function depositFromPhantom() {
    setMsg(''); setBusy(true);
    try {
      const amount = Number(depAmt);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount of SOL greater than 0');
      const ph = getPhantom();
      if (!ph) {
        window.location.href = phantomPay(addr, amount);
        setBusy(false);
        return;
      }
      const r = await ph.connect();
      const from = r.publicKey.toString();
      const built = await api('deposit/prepare', { from, sol: amount });
      if (paper) {
        setMsg(`Paper mode: would send ${built.sol} SOL from ${short(from)} to the bot wallet. Not sent.`);
        setBusy(false);
        return;
      }
      if (!confirm(`Send ${built.sol} SOL from your Phantom wallet to the bot wallet?`)) { setBusy(false); return; }
      const { Transaction } = await import('@solana/web3.js');
      const raw = Uint8Array.from(atob(built.txBase64), (c) => c.charCodeAt(0));
      const tx = Transaction.from(raw);
      const sig = await ph.signAndSendTransaction(tx);
      const signature = sig.signature || sig;
      setMsg('Deposit sent ' + signature);
    } catch (e: any) { setMsg(e.message || String(e)); }
    setBusy(false);
  }

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
      await refresh();
    } catch (e: any) { setMsg(e.message || String(e)); }
    setBusy(false);
  }

  async function withdraw() {
    if (paper) return;
    const useMax = !solAmt;
    const amt = useMax ? maxSol : Number(solAmt);
    if (!Number.isFinite(amt) || amt <= 0) { setMsg('Enter an amount or use Max'); return; }
    const to = locked || funds?.withdrawTo;
    if (!to) { setMsg('Lock a Phantom address before withdrawing'); return; }
    if (!confirm(`Withdraw ${useMax ? 'all spendable' : amt} SOL to the locked Phantom address ${to}? This cannot be undone.`)) return;
    setMsg(''); setBusy(true);
    try {
      const r = await api('withdraw', useMax ? { max: true } : { sol: amt }, { timeoutMs: 60000 });
      setMsg(`Sent ${r.sol} SOL · ${r.signature}`);
      setSolAmt('');
      await refresh();
    } catch (e: any) { setMsg(e.message || String(e)); }
    setBusy(false);
  }

  const history = funds?.history || [];

  return (
    <div className="page funds-page" data-testid="funds-page">
      <div className="page-title"><WalletI size={28} /> Funds</div>

      <div className="section card">
        <div className="sec-hd"><b>Deposit</b><span className="chip mono">{paper ? 'PAPER' : snap.mode.toUpperCase()}</span></div>
        <p className="tiny muted">Send SOL or USDC (SPL) to the bot wallet on the <b>Solana</b> network only. ERC-20 / Tron / other-chain USDC will not arrive. FOMO withdrawals as Solana USDC are supported.</p>
        <div className="bot-wallet-row">
          <img className="qr" src={qr} alt="Deposit QR" width={140} height={140} />
          <div className="bot-wallet-meta">
            <div className="muted tiny">bot wallet address</div>
            <code className="addr" data-testid="funds-bot-address">{addr}</code>
            <button type="button" className="pill-btn small-btn ghost" onClick={copyAddr} data-testid="copy-bot-address">{copied ? 'Copied ✓' : 'Copy address'}</button>
            <div className="mono small" style={{ marginTop: 8 }} data-testid="onchain-sol">
              On-chain: {onchainSol == null ? '…' : `${Number(onchainSol).toFixed(4)} SOL`}
              {funds?.onchainUsd != null && <> · {usd(funds.onchainUsd)}</>}
            </div>
            <div className="mono small" data-testid="onchain-usdc">
              USDC: {funds?.onchainUsdc == null ? '…' : `${Number(funds.onchainUsdc).toFixed(2)} USDC`}
              {funds?.onchainUsdcUsd != null && Number(funds.onchainUsdc) > 0 && <> · {usd(funds.onchainUsdcUsd)}</>}
            </div>
          </div>
        </div>
        {paper
          ? <p className="tiny muted">Paper mode: USDC is shown only. Auto-swap to SOL is disabled until you go live-auto.</p>
          : <p className="tiny muted">In live-auto, USDC received here is automatically swapped to SOL via Jupiter (gasless when available). Withdrawals are SOL to your locked Phantom address; leftover USDC is sent there too.</p>}
        {!paper && Number(funds?.onchainUsdc || 0) > 0 && Number(funds?.onchainSol || 0) < 0.01 && (
          <p className="note" data-testid="need-sol-fees">Need ~0.01 SOL for fees</p>
        )}
        <div className="deposit-box">
          <div className="muted tiny">Deposit from Phantom</div>
          <div className="deposit-row">
            <input type="number" min="0.001" step="0.001" value={depAmt} onChange={(e) => setDepAmt(e.target.value)} aria-label="Deposit SOL" data-testid="funds-deposit-sol" />
            {phantom
              ? <button type="button" className="pill-btn small-btn" disabled={busy} onClick={depositFromPhantom} data-testid="deposit-from-phantom">Deposit from Phantom</button>
              : <a className="pill-btn small-btn sheet-btn phantom-open" href={phantomPay(addr, Number(depAmt) || undefined)} data-testid="open-in-phantom-deposit"><PhantomIcon size={18} /> Open Phantom to send SOL</a>}
          </div>
          <p className="tiny muted">Or scan the QR / paste the address in Phantom. {!phantom && <a href={phantomBrowseUrl()}>Open this page in Phantom</a>}.</p>
        </div>
      </div>

      <div className="section card">
        <div className="sec-hd"><b>Withdraw</b></div>
        {locked ? (
          <p className="tiny mono" data-testid="locked-withdraw-to">Locked to {locked} {bw.lockedBy === 'env' ? '(env)' : '(signed)'} — withdrawals can only go here.</p>
        ) : (
          <p className="note">Connect Phantom once and sign to lock withdrawals to <b>your</b> address. After a successful lock it is saved on the host. It cannot be changed in the app.</p>
        )}
        {paper && (
          <p className="note" data-testid="funds-paper-disabled">Withdraw is disabled in paper mode. It only sends real SOL from the bot wallet to the locked Phantom address after you go live-auto. Deposit and the lock are shown so you can prepare.</p>
        )}
        {msg && <p className="tiny" data-testid="funds-msg">{msg}</p>}
        <div className="deposit-row">
          <input type="number" min="0" step="0.001" placeholder="Amount (SOL)" value={solAmt} onChange={(e) => setSolAmt(e.target.value)} disabled={paper || !locked} aria-label="Withdraw SOL" data-testid="funds-withdraw-sol" />
          <button type="button" className="pill-btn small-btn ghost" disabled={paper || !locked || busy} onClick={() => setSolAmt(maxSol ? String(Number(maxSol.toFixed(6))) : '')} data-testid="funds-withdraw-max">Max</button>
        </div>
        <div className="btn-row">
          {!locked && (
            phantom
              ? <button className="pill-btn small-btn" disabled={busy || paper} onClick={lock} data-testid="lock-withdraw">Lock withdraw address</button>
              : <a className="pill-btn small-btn sheet-btn phantom-open" href={phantomBrowseUrl()} data-testid="open-in-phantom-lock"><PhantomIcon size={18} /> Open in Phantom to lock</a>
          )}
          <button className="pill-btn small-btn" disabled={paper || !locked || busy} onClick={withdraw} data-testid="funds-withdraw">Withdraw to Phantom</button>
        </div>
      </div>

      <div className="section card">
        <div className="sec-hd"><b>Withdraw history</b></div>
        {history.length === 0 ? (
          <p className="tiny muted">No withdrawals yet.</p>
        ) : history.map((h: any) => (
          <div key={h.signature || h.ts} className="kv mono small" style={{ marginBottom: 8 }}>
            <span className="muted">{new Date(h.ts).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })}</span>
            <span>{h.sol} SOL → {short(h.to)}</span>
            {h.signature && <a href={h.solscan || `https://solscan.io/tx/${h.signature}`} target="_blank" rel="noreferrer">{short(h.signature)}</a>}
          </div>
        ))}
      </div>
    </div>
  );
}
