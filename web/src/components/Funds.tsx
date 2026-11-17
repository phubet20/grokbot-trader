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
  const [destAddr, setDestAddr] = useState('');
  const [asset, setAsset] = useState<'SOL' | 'USDC'>('SOL');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [solscan, setSolscan] = useState('');
  const [depAmt, setDepAmt] = useState('0.05');
  const [msg, setMsg] = useState('');
  const [msgKind, setMsgKind] = useState<'ok' | 'err' | ''>('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const phantom = getPhantom();

  async function refresh() {
    try {
      const f = await api('funds');
      setFunds(f);
      setDestAddr((d) => d || f.defaultTo || f.withdrawTo || locked || 'CgrPNY2dMhyB8QmfM8hGyBqLwbvrWdE2X58LZZyGSVye');
    } catch { /* keep last */ }
  }
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 12_000); return () => clearInterval(t); }, []);

  const onchainSol = funds?.onchainSol;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(solanaPay(addr))}`;
  const maxSol = typeof funds?.maxSol === 'number' ? Math.max(0, funds.maxSol) : (typeof onchainSol === 'number' ? Math.max(0, onchainSol - (funds?.reserveSol || 0.00002)) : 0);
  const maxUsdc = typeof funds?.maxUsdc === 'number' ? Math.max(0, funds.maxUsdc) : 0;
  const defaultTo = funds?.defaultTo || locked || 'CgrPNY2dMhyB8QmfM8hGyBqLwbvrWdE2X58LZZyGSVye';

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

  function withdrawAmount(): { amt: number; max: boolean } {
    const cap = asset === 'USDC' ? maxUsdc : maxSol;
    const raw = solAmt.trim();
    if (!raw) return { amt: cap, max: true };
    const n = Number(raw);
    return { amt: n, max: false };
  }

  function openConfirm() {
    if (paper) return;
    setMsg(''); setMsgKind('');
    const to = (destAddr || defaultTo).trim();
    if (!to) { setMsg('กรุณาวางที่อยู่กระเป๋าปลายทาง'); setMsgKind('err'); return; }
    const { amt, max } = withdrawAmount();
    if (!max && (!Number.isFinite(amt) || amt <= 0)) { setMsg('กรุณาใส่จำนวนมากกว่า 0 หรือกด Max'); setMsgKind('err'); return; }
    setConfirmOpen(true);
  }

  async function confirmWithdraw() {
    if (paper) return;
    const to = (destAddr || defaultTo).trim();
    const { amt, max } = withdrawAmount();
    setConfirmOpen(false);
    setMsg(''); setMsgKind(''); setSolscan(''); setBusy(true);
    try {
      const body: any = { to, asset, max };
      if (!max && asset === 'SOL') body.sol = amt;
      if (!max && asset === 'USDC') body.usdc = amt;
      const r = await api('withdraw', body, { timeoutMs: 90000 });
      const qty = asset === 'USDC' ? `${Number(r.usdc).toFixed(2)} USDC` : `${Number(r.sol).toFixed(6)} SOL`;
      setMsg(`ถอนสำเร็จ ${qty}`);
      setMsgKind('ok');
      setSolscan(r.solscan || (r.signature ? `https://solscan.io/tx/${r.signature}` : ''));
      setSolAmt('');
      await refresh();
    } catch (e: any) {
      setMsg(`ถอนไม่สำเร็จ: ${e.message || String(e)}`);
      setMsgKind('err');
    }
    setBusy(false);
  }

  const history = funds?.history || [];

  return (
    <div className="page funds-page" data-testid="funds-page">
      <div className="page-title"><WalletI size={28} /> Funds</div>

      <div className="section card">
        {paper && <p className="note">TEST book is virtual and separate from the on-chain bot wallet below. Live positions, if any, stay on-chain and are still managed.</p>}
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
          : <p className="tiny muted">In live-auto, USDC received here is automatically swapped to SOL via Jupiter (gasless when available). Withdraw SOL or USDC to any Solana address you paste below.</p>}
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
        <div className="sec-hd"><b>ถอนเงิน</b><span className="chip mono">{paper ? 'TEST' : 'LIVE'}</span></div>
        {paper && (
          <p className="note" data-testid="funds-paper-disabled">โหมด TEST ถอนจริงไม่ได้ — สลับเป็น LIVE เพื่อถอน SOL หรือ USDC จากกระเป๋าบอทบนโซลานา</p>
        )}
        {!paper && (
          <p className="tiny muted">วางที่อยู่ Solana ของกระเป๋าที่ต้องการรับเงิน (คัดลอกจากแอปกระเป๋า) แล้วใส่จำนวน กดถอน และยืนยัน ระบบจะโอนจากกระเป๋าบอททันที ค่าเริ่มต้นคือที่อยู่ที่ล็อกไว้ แต่ถอนไปที่อื่นได้ อย่าใส่คีย์ลับหรือวลีกู้คืน</p>
        )}
        <label className="field small">
          <span>ที่อยู่ปลายทาง</span>
          <input type="text" inputMode="text" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="Solana address" value={destAddr} onChange={(e) => setDestAddr(e.target.value)} disabled={paper || busy} aria-label="Withdraw destination" data-testid="funds-withdraw-to" className="withdraw-addr" />
        </label>
        <div className="deposit-row">
          <select value={asset} onChange={(e) => setAsset(e.target.value === 'USDC' ? 'USDC' : 'SOL')} disabled={paper || busy} aria-label="Withdraw asset" data-testid="funds-withdraw-asset">
            <option value="SOL">SOL</option>
            <option value="USDC">USDC</option>
          </select>
          <input type="number" min="0" step="0.001" placeholder={asset === 'USDC' ? 'จำนวน (USDC)' : 'จำนวน (SOL)'} value={solAmt} onChange={(e) => setSolAmt(e.target.value)} disabled={paper || busy} aria-label="Withdraw amount" data-testid="funds-withdraw-sol" />
          <button type="button" className="pill-btn small-btn ghost" disabled={paper || busy} onClick={() => setSolAmt(asset === 'USDC' ? String(Number(maxUsdc.toFixed(6))) : (maxSol ? String(Number(maxSol.toFixed(6))) : ''))} data-testid="funds-withdraw-max">Max</button>
        </div>
        {!paper && asset === 'SOL' && typeof funds?.reserveSol === 'number' && (
          <p className="tiny muted">Max จะเหลือประมาณ {Number(funds.reserveSol).toFixed(4)} SOL สำหรับค่าธรรมเนียม{((funds.livePositionsOpen || 0) > 0) ? ' และการปิดโพสิชันที่ยังเปิดอยู่' : ''}</p>
        )}
        {msg && <p className={`tiny ${msgKind === 'ok' ? 'pos' : msgKind === 'err' ? 'neg' : ''}`} data-testid="funds-msg">{msg}{msgKind === 'ok' && solscan ? <> · <a href={solscan} target="_blank" rel="noreferrer" data-testid="funds-withdraw-solscan">ดูบน Solscan</a></> : null}</p>}
        <div className="btn-row">
          <button className="pill-btn small-btn" disabled={paper || busy} onClick={openConfirm} data-testid="funds-withdraw">ถอน</button>
        </div>
        {locked
          ? <p className="tiny muted mono" data-testid="locked-withdraw-to">ค่าเริ่มต้น: {locked} {bw.lockedBy === 'env' ? '(env)' : '(signed)'}</p>
          : (!paper && (phantom
            ? <button className="pill-btn small-btn ghost" disabled={busy} onClick={lock} data-testid="lock-withdraw">ล็อกที่อยู่ Phantom เป็นค่าเริ่มต้น</button>
            : <a className="pill-btn small-btn ghost sheet-btn phantom-open" href={phantomBrowseUrl()} data-testid="open-in-phantom-lock"><PhantomIcon size={18} /> Open in Phantom to lock default</a>))}
        {confirmOpen && (
          <div className="mode-confirm" data-testid="funds-withdraw-confirm" onClick={() => !busy && setConfirmOpen(false)}>
            <div className="mode-confirm-card" onClick={(e) => e.stopPropagation()}>
              <b>ยืนยันการถอน</b>
              <p className="small">จำนวน <b className="mono">{withdrawAmount().max ? 'ทั้งหมดที่ถอนได้' : withdrawAmount().amt} {asset}</b></p>
              <p className="small">ไปที่</p>
              <code className="addr" data-testid="funds-withdraw-confirm-to">{(destAddr || defaultTo).trim()}</code>
              <p className="tiny muted">ไม่สามารถยกเลิกได้หลังกดยืนยัน ระบบจะโอนจากกระเป๋าบอททันที</p>
              <div className="btn-row">
                <button type="button" className="pill-btn small-btn ghost" disabled={busy} onClick={() => setConfirmOpen(false)}>ยกเลิก</button>
                <button type="button" className="pill-btn small-btn" disabled={busy} onClick={confirmWithdraw} data-testid="funds-withdraw-confirm-go">ยืนยันถอน</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="section card">
        <div className="sec-hd"><b>Withdraw history</b></div>
        {history.length === 0 ? (
          <p className="tiny muted">No withdrawals yet.</p>
        ) : history.map((h: any) => (
          <div key={h.signature || h.ts} className="kv mono small" style={{ marginBottom: 8 }}>
            <span className="muted">{new Date(h.ts).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })}</span>
            <span>{h.asset === 'USDC' || h.usdc ? `${h.usdc} USDC` : `${h.sol} SOL`} → {short(h.to)}</span>
            {h.signature && <a href={h.solscan || `https://solscan.io/tx/${h.signature}`} target="_blank" rel="noreferrer">{short(h.signature)}</a>}
          </div>
        ))}
      </div>
    </div>
  );
}
