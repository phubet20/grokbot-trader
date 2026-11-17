import { useEffect, useRef, useState } from 'react';
import { api, usd, short } from '../api';
import { BotIcon, PhantomIcon, CheckI, XI } from './Icons';

export { getPhantom, phantomBrowseUrl } from '../phantom';
import { getPhantom, phantomBrowseUrl } from '../phantom';
function LinkDots({ state }: { state: 'idle' | 'busy' | 'done' }) {
  if (state === 'idle') return <span className="sheet-dot" />;
  if (state === 'done') return <span className="sheet-link done" aria-hidden>——</span>;
  return (
    <span className="sheet-link busy" aria-hidden>
      <i /><i /><i /><i />
    </span>
  );
}

export function ConnectSheet({ snap, onStart }: { snap: any; onStart: () => void }) {
  const phantom = getPhantom();
  const isAuto = snap?.mode === 'live-auto';
  const isLive = snap?.mode === 'live' || isAuto;
  const needPhantomApp = snap?.mode === 'live' && !phantom;
  const [address, setAddress] = useState<string>(snap?.wallet?.address || '');
  const initialUsd = Math.max(2, Number(snap?.stats?.equity || snap?.wallet?.depositUsd || snap?.config?.startUsd || 81) || 81);
  const [startUsd, setStartUsd] = useState<number>(initialUsd);
  const editedUsd = useRef(false);
  const [pv, setPv] = useState<any>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  const [browse, setBrowse] = useState('');

  useEffect(() => { setBrowse(phantomBrowseUrl()); }, []);

  useEffect(() => {
    if (editedUsd.current || isLive) return;
    const cur = Number(snap?.stats?.equity || snap?.wallet?.depositUsd || 0);
    if (cur >= 2) setStartUsd(Math.max(2, Math.round(cur)));
  }, [isLive, snap?.stats?.equity, snap?.wallet?.depositUsd]);

  useEffect(() => {
    const type = isLive ? 'phantom' : 'paper';
    const t = setTimeout(() => api('wallet/preview', { type, address: address || undefined, startUsd }, { timeoutMs: 2500, retries: 1 }).then(setPv).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [isLive, address, startUsd]);

  const hasBook = !isLive && !!(snap?.wallet?.depositUsd || snap?.wallet?.solBalance || (snap?.positions || []).length || snap?.stats?.closed);

  async function connect() {
    if (state !== 'idle') return;
    setErr(''); setState('busy');
    try {
      let addr = address;
      if (isAuto) {
        await api('wallet/connect', { type: 'bot' }, { timeoutMs: 4000, retries: 1 });
      } else if (isLive) {
        if (!phantom) throw new Error('Phantom not detected — tap Open in Phantom, or install the Phantom extension');
        const r = await phantom.connect();
        addr = r.publicKey.toString(); setAddress(addr);
        await api('wallet/connect', { type: 'phantom', address: addr }, { timeoutMs: 8000, retries: 1 });
      } else {
        const amt = Math.max(2, startUsd);
        const cur = hasBook ? (snap?.stats?.equity || snap?.wallet?.depositUsd || 0) : 0;
        const changed = hasBook && Math.abs(cur - amt) >= 0.5;
        await api('wallet/connect', { type: 'paper', address: addr || pv?.address || undefined, startUsd: amt, setBalance: !hasBook || changed }, { timeoutMs: 4000, retries: 1 });
      }
      setState('done');
      setTimeout(() => setReady(true), 150);
    } catch (e: any) { setErr(e.message || String(e)); setState('idle'); }
  }

  const shownAddr = address || pv?.address || '';
  const alreadyOn = !!snap?.wallet?.connected;
  const solPx = pv?.solPrice || snap?.solPrice || snap?.stats?.solPrice || 0;
  const btnLabel = ready || alreadyOn ? 'เริ่มใช้งาน' : state === 'done' ? 'Connected ✓' : state === 'busy' ? 'Approving…' : 'Approve';
  const btnTestId = (ready || alreadyOn) ? 'start' : 'connect';
  const paperUsd = Math.max(2, startUsd);
  const paperSol = solPx ? paperUsd / solPx : 0;
  const bal = isLive
    ? (pv && (pv.address || address) ? `${usd(pv.usd)} · ${pv.sol.toFixed(2)} SOL` : (pv ? 'open Phantom to read balance' : '…'))
    : (solPx ? `${usd(paperUsd)} · ${paperSol.toFixed(2)} SOL` : `${usd(paperUsd)}`);

  return (
    <div className="sheet-wrap" data-testid="connect-sheet">
      <div className="sheet">
        <div className="grabber" />
        <div className="sheet-icons"><BotIcon size={46} /><LinkDots state={state} /><PhantomIcon size={46} /></div>
        <h2>Connect Phantom</h2>
        <p className="muted">{`${snap?.appName || 'Grok Bot'} wants to connect to your wallet`}</p>
        <div className="kv-box mono">
          <div><span className="muted">network</span><span>Solana</span></div>
          <div><span className="muted">wallet</span><span>Phantom{shownAddr ? ' · ' + short(shownAddr) : ''}</span></div>
          <div><span className="muted">balance</span><span data-testid="connect-balance">{bal}</span></div>
          <div><span className="muted">mode</span><span className={isLive ? 'neg' : 'warn'}>{isLive ? 'LIVE · real funds' : 'TEST · simulated fills'}</span></div>
        </div>
        {!isLive && (
          <label className="start-usd mono"><span className="muted">test balance (min $2)</span>
            <span className="usd-input">$<input type="number" min={2} step={1} value={startUsd} onChange={(e) => { editedUsd.current = true; setStartUsd(Math.max(2, Number(e.target.value) || 2)); }} data-testid="test-balance-input" /></span>
          </label>
        )}
        {!isLive && hasBook && (
          <p className="note" data-testid="resume-book-note">Test balance is prefilled with the current TEST book. Leave it unchanged to resume, or type a new amount and Approve to start a fresh TEST book at that balance. Live is not touched.</p>
        )}
        {needPhantomApp && (
          <p className="note">Tap <b>Open in Phantom</b> to continue in the Phantom app, then Approve. Never enter a seed phrase here.</p>
        )}
        <ul className="checklist">
          <li><CheckI size={15} /> view balance and activity</li>
          <li><CheckI size={15} /> request approval for transactions</li>
          <li className="x"><XI size={15} /> can&apos;t move funds without your approval</li>
        </ul>
        {err && <p className="err" data-testid="connect-error">{err}</p>}
        <div className="sheet-actions">
          {needPhantomApp && !ready && (
            <a className="pill-btn sheet-btn phantom-open" href={browse || '#'} data-testid="open-in-phantom">
              <PhantomIcon size={22} /> Open in Phantom
            </a>
          )}
          {(!needPhantomApp || ready) && (
            <button
              className={`pill-btn sheet-btn ${state === 'busy' ? 'approving' : ''} ${state === 'done' && !ready ? 'ok' : ''} ${ready ? 'go' : ''}`}
              onClick={(ready || alreadyOn) ? onStart : connect}
              disabled={state === 'busy' || (state === 'done' && !ready)}
              data-testid={btnTestId}
            >
              {btnLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
