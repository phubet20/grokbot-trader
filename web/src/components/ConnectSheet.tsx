import { useEffect, useState } from 'react';
import { api, usd, short } from '../api';
import { BotIcon, PhantomIcon, CheckI, XI } from './Icons';

declare global { interface Window { phantom?: any; solana?: any } }
export const getPhantom = () => (typeof window !== 'undefined' ? window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null) : null);

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
  const isLive = snap?.mode === 'live';
  const [address, setAddress] = useState<string>(snap?.wallet?.address || '');
  const startUsd = snap?.config?.startUsd || 81;
  const [pv, setPv] = useState<any>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const type = isLive ? 'phantom' : 'paper';
    const t = setTimeout(() => api('wallet/preview', { type, address: address || undefined, startUsd }).then(setPv).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [isLive, address, startUsd]);

  async function connect() {
    if (state !== 'idle') return;
    setErr(''); setState('busy');
    const started = Date.now();
    try {
      let addr = address;
      if (isLive) {
        if (!phantom) throw new Error('Phantom not detected — open this app in the Phantom browser or install the Phantom extension');
        const r = await phantom.connect();
        addr = r.publicKey.toString(); setAddress(addr);
        await api('wallet/connect', { type: 'phantom', address: addr });
      } else {
        // Paper / test mode: simulated Phantom connect, no real wallet is touched.
        await api('wallet/connect', { type: 'paper', address: addr || pv?.address || undefined, startUsd });
      }
      const wait = 900 - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      setState('done');
      setTimeout(() => setReady(true), 700);
    } catch (e: any) { setErr(e.message || String(e)); setState('idle'); }
  }

  const shownAddr = address || pv?.address || '';
  const btnLabel = ready ? 'เริ่มใช้งาน' : state === 'done' ? 'Connected ✓' : state === 'busy' ? 'Approving…' : 'Connect';
  const btnTestId = ready ? 'start' : 'connect';

  return (
    <div className="sheet-wrap" data-testid="connect-sheet">
      <div className="sheet">
        <div className="grabber" />
        <div className="sheet-icons"><BotIcon size={46} /><LinkDots state={state} /><PhantomIcon size={46} /></div>
        <h2>Connect Phantom</h2>
        <p className="muted">{snap?.appName || 'Grok Bot'} wants to connect to your wallet</p>
        <div className="kv-box mono">
          <div><span className="muted">network</span><span>Solana</span></div>
          <div><span className="muted">wallet</span><span>Phantom{shownAddr ? ' · ' + short(shownAddr) : ''}</span></div>
          <div><span className="muted">balance</span><span>{pv ? `${usd(pv.usd)} · ${pv.sol.toFixed(2)} SOL` : '…'}</span></div>
        </div>
        {isLive && !phantom && <p className="note">Install the Phantom extension or open this link in the Phantom in-app browser to connect a real wallet.</p>}
        <ul className="checklist">
          <li><CheckI size={15} /> view balance and activity</li>
          <li><CheckI size={15} /> request approval for transactions</li>
          <li className="x"><XI size={15} /> can&apos;t move funds without your approval</li>
        </ul>
        {err && <p className="err">{err}</p>}
        <button
          className={`pill-btn sheet-btn ${state === 'busy' ? 'approving' : ''} ${state === 'done' && !ready ? 'ok' : ''} ${ready ? 'go' : ''}`}
          onClick={ready ? onStart : connect}
          disabled={state === 'busy' || (state === 'done' && !ready) || (isLive && !phantom && !ready)}
          data-testid={btnTestId}
        >
          {btnLabel}
        </button>
      </div>
    </div>
  );
}
