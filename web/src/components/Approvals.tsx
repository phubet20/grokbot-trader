// LIVE mode only: asks Phantom to sign + send the swap that the server built.
import { api } from '../api';
import { getPhantom, phantomBrowseUrl } from './ConnectSheet';
import { PhantomIcon } from './Icons';

export function Approvals({ items, setItems }: { items: any[]; setItems: (f: (a: any[]) => any[]) => void }) {
  if (!items.length) return null;
  const a = items[0];
  const phantom = getPhantom();
  const done = () => setItems((x) => x.slice(1));
  async function approve() {
    try {
      const ph = getPhantom();
      if (!ph) throw new Error('Phantom not detected');
      const { VersionedTransaction } = await import('@solana/web3.js');
      const bytes = Uint8Array.from(atob(a.tx), (c) => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(bytes);
      const r = await ph.signAndSendTransaction(tx);
      await api('live/signed', { id: a.id, signature: r.signature });
    } catch (e: any) { await api('live/rejected', { id: a.id }).catch(() => {}); alert('Not sent: ' + (e.message || e)); }
    done();
  }
  return (
    <div className="modal-bg"><div className="recap">
      <b style={{ fontSize: 18 }}>Approve in Phantom</b>
      <p className="small">{a.text}</p>
      <p className="note">LIVE mode: this moves real funds. The app never asks for your seed phrase — sign in Phantom only.</p>
      {phantom ? (
        <div className="btn-row"><button className="pill-btn" onClick={approve}>Review in Phantom</button><button className="pill-btn ghost" onClick={async () => { await api('live/rejected', { id: a.id }); done(); }}>Reject</button></div>
      ) : (
        <div className="btn-row">
          <a className="pill-btn sheet-btn phantom-open" href={phantomBrowseUrl()} data-testid="open-in-phantom-approve"><PhantomIcon size={20} /> Open in Phantom</a>
          <button className="pill-btn ghost" onClick={async () => { await api('live/rejected', { id: a.id }); done(); }}>Reject</button>
        </div>
      )}
    </div></div>
  );
}
