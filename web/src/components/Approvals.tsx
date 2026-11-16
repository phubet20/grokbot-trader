// LIVE mode only: asks Phantom to sign + send the swap that the server built.
import { api } from '../api';
import { getPhantom } from './ConnectSheet';

export function Approvals({ items, setItems }: { items: any[]; setItems: (f: (a: any[]) => any[]) => void }) {
  if (!items.length) return null;
  const a = items[0];
  const done = () => setItems((x) => x.slice(1));
  async function approve() {
    try {
      const { VersionedTransaction } = await import('@solana/web3.js');
      const bytes = Uint8Array.from(atob(a.tx), (c) => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(bytes);
      const r = await getPhantom().signAndSendTransaction(tx);
      await api('live/signed', { id: a.id, signature: r.signature });
    } catch (e: any) { await api('live/rejected', { id: a.id }).catch(() => {}); alert('Not sent: ' + (e.message || e)); }
    done();
  }
  return (
    <div className="modal-bg"><div className="recap">
      <b style={{ fontSize: 18 }}>Approve in Phantom</b>
      <p className="small">{a.text}</p>
      <p className="note">LIVE mode: this moves real funds.</p>
      <div className="btn-row"><button className="pill-btn" onClick={approve}>Review in Phantom</button><button className="pill-btn ghost" onClick={async () => { await api('live/rejected', { id: a.id }); done(); }}>Reject</button></div>
    </div></div>
  );
}
