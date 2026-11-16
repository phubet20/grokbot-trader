import { useEffect, useState } from 'react';
import { api, usd, short } from '../api';
import { BotIcon, PhantomIcon, CheckI, XI } from './Icons';

declare global { interface Window { phantom?: any; solana?: any } }
export const getPhantom = () => (typeof window !== 'undefined' ? window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null) : null);

export function ConnectSheet({ snap, onConnected }: { snap: any; onConnected: () => void }) {
  const phantom = getPhantom();
  const isLive = snap?.mode === 'live';
  const [type, setType] = useState<'paper' | 'phantom'>(phantom && isLive ? 'phantom' : 'paper');
  const [address, setAddress] = useState<string>('');
  const [startUsd, setStartUsd] = useState<number>(snap?.config?.startUsd || 81);
  const [pv, setPv] = useState<any>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState('');

  useEffect(() => {
    const t = setTimeout(() => api('wallet/preview', { type, address: address || undefined, startUsd }).then(setPv).catch((e) => setErr(e.message)), 250);
    return () => clearTimeout(t);
  }, [type, address, startUsd]);

  async function connect() {
    setErr(''); setState('busy');
    try {
      let addr = address;
      if (type === 'phantom') {
        if (!phantom) throw new Error('Phantom not detected in this browser');
        const r = await phantom.connect();
        addr = r.publicKey.toString(); setAddress(addr);
      }
      await api('wallet/connect', { type, address: addr || undefined, startUsd });
      setState('done');
      setTimeout(onConnected, 900);
    } catch (e: any) { setErr(e.message || String(e)); setState('idle'); }
  }

  return (
    <div className="sheet-wrap">
      <div className="sheet">
        <div className="grabber" />
        <div className="sheet-icons"><BotIcon size={46} /><span className="sheet-dot" /><PhantomIcon size={46} /></div>
        <h2>Connect {type === 'phantom' ? 'Phantom' : 'Phantom'}</h2>
        <p className="muted">{snap?.appName || 'Grok Bot'} wants to connect to your wallet</p>
        <div className="seg">
          <button className={type === 'paper' ? 'on' : ''} onClick={() => setType('paper')}>Paper wallet · test</button>
          <button className={type === 'phantom' ? 'on' : ''} onClick={() => setType('phantom')} disabled={!phantom} title={phantom ? '' : 'Install the Phantom extension / open in Phantom browser'}>Phantom{phantom ? '' : ' (not found)'}</button>
        </div>
        <div className="kv-box mono">
          <div><span className="muted">network</span><span>Solana</span></div>
          <div><span className="muted">wallet</span><span>{type === 'phantom' ? 'Phantom · ' + (short(address || pv?.address || '') || 'tap Connect') : 'Paper · simulated'}</span></div>
          <div><span className="muted">balance</span><span>{pv ? `${usd(pv.usd)} · ${pv.sol.toFixed(2)} SOL` : '…'}</span></div>
          <div><span className="muted">mode</span><span className={isLive ? 'neg' : 'warn'}>{isLive ? 'LIVE · real funds' : 'TEST · simulated fills'}</span></div>
        </div>
        {type === 'paper' && (
          <label className="start-usd mono"><span className="muted">test balance (min $10)</span>
            <span className="usd-input">$<input type="number" min={10} step={1} value={startUsd} onChange={(e) => setStartUsd(Math.max(10, Number(e.target.value) || 10))} /></span>
          </label>
        )}
        {type === 'phantom' && !isLive && pv?.realSol != null && <p className="note">Your real balance is {pv.realSol.toFixed(3)} SOL - it is only read. Test mode trades a simulated {usd(startUsd)}.</p>}
        <ul className="checklist">
          <li><CheckI size={15} /> view balance and activity</li>
          <li><CheckI size={15} /> request approval for transactions</li>
          <li className="x"><XI size={15} /> can't move funds without your approval</li>
        </ul>
        {err && <p className="err">{err}</p>}
        <button className={`pill-btn ${state === 'done' ? 'ok' : ''}`} onClick={connect} disabled={state !== 'idle'} data-testid="connect">
          {state === 'done' ? 'Connected ✓' : state === 'busy' ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  );
}
