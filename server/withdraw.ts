// Withdraw destination validation and reliable SOL transfers.
// Never log raw pasted input. Secret-like values are rejected and discarded.
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { botKeypair, botPublicKey, redactSecrets } from './wallet.ts';
import { ATA_RENT_SOL, BASE_FEE_SOL } from './risk.ts';

export const DEFAULT_WITHDRAW_TO = 'CgrPNY2dMhyB8QmfM8hGyBqLwbvrWdE2X58LZZyGSVye';

export const WITHDRAW_ERR = {
  secret: 'อย่าใส่คีย์ลับหรือวลีกู้คืน — ใส่ได้เฉพาะที่อยู่กระเป๋า (public address) เท่านั้น',
  invalid: 'ที่อยู่ไม่ถูกต้อง กรุณาวางที่อยู่ Solana (public address) ที่คัดลอกจากกระเป๋า',
  self: 'ถอนเข้ากระเป๋าบอทเองไม่ได้',
  paper: 'โหมด TEST ถอนจริงไม่ได้ — สลับเป็น LIVE เพื่อถอนจากกระเป๋าบอทบนโซลานา',
  noFunds: 'ยอดหลังหักค่าธรรมเนียมไม่พอสำหรับถอน',
  amount: 'กรุณาใส่จำนวนมากกว่า 0 หรือกด Max',
  asset: 'รองรับเฉพาะ SOL และ USDC',
} as const;

export type WithdrawParse =
  | { ok: true; address: string }
  | { ok: false; error: string; code: 'secret' | 'invalid' };

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function wordCount(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

function looksLikeMnemonic(s: string): boolean {
  const words = wordCount(s);
  if (words.length !== 12 && words.length !== 24) return false;
  return words.every((w) => /^[a-zA-Z]{3,}$/.test(w));
}

function looksLikeJsonSecret(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return false;
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) && (arr.length === 64 || arr.length === 32) && arr.every((n) => Number.isInteger(n));
  } catch {
    return false;
  }
}

function looksLikeHexSecret(s: string): boolean {
  const t = s.trim().replace(/^0x/i, '');
  return /^[0-9a-fA-F]+$/.test(t) && (t.length === 64 || t.length === 128);
}

function decodeBase58(s: string): Uint8Array | null {
  try { return bs58.decode(s.trim()); } catch { return null; }
}

/** True when the paste looks like a private key or seed phrase — never log the value. */
export function isSecretLikeDestination(input: string): boolean {
  const s = String(input || '');
  if (looksLikeMnemonic(s) || looksLikeJsonSecret(s) || looksLikeHexSecret(s)) return true;
  const compact = s.trim();
  if (!BASE58_RE.test(compact) || compact.length < 80) return false;
  const raw = decodeBase58(compact);
  return !!raw && raw.length === 64;
}

/**
 * Accept a Solana wallet public key. Reject private keys and seed phrases
 * with a Thai error. Does not log or retain the raw input on failure.
 */
export function parseWithdrawDestination(input: unknown): WithdrawParse {
  const s = String(input ?? '').trim();
  if (!s) return { ok: false, error: WITHDRAW_ERR.invalid, code: 'invalid' };
  if (isSecretLikeDestination(s)) return { ok: false, error: WITHDRAW_ERR.secret, code: 'secret' };
  const compact = s.replace(/\s+/g, '');
  if (!BASE58_RE.test(compact) || compact.length < 32 || compact.length > 44) {
    return { ok: false, error: WITHDRAW_ERR.invalid, code: 'invalid' };
  }
  const raw = decodeBase58(compact);
  if (!raw) return { ok: false, error: WITHDRAW_ERR.invalid, code: 'invalid' };
  if (raw.length === 64) return { ok: false, error: WITHDRAW_ERR.secret, code: 'secret' };
  if (raw.length !== 32) return { ok: false, error: WITHDRAW_ERR.invalid, code: 'invalid' };
  try {
    const pk = new PublicKey(compact);
    if (pk.toBytes().length !== 32) return { ok: false, error: WITHDRAW_ERR.invalid, code: 'invalid' };
    // Reject truncated / non-canonical encodings so typo addresses cannot silently remap.
    if (pk.toBase58() !== compact) return { ok: false, error: WITHDRAW_ERR.invalid, code: 'invalid' };
    // User wallets are on-curve; PDAs (off-curve) can still receive SOL, so either is valid.
    void PublicKey.isOnCurve(pk.toBytes());
    return { ok: true, address: pk.toBase58() };
  } catch {
    return { ok: false, error: WITHDRAW_ERR.invalid, code: 'invalid' };
  }
}

export function shortAddr(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

const CU_LIMIT_SOL = 20_000;

export function priorityMicroLamports(priorityFeeSol: number, cuLimit = CU_LIMIT_SOL): number {
  const sol = Math.max(0, priorityFeeSol || 0);
  if (!(sol > 0)) return 10_000;
  const micro = Math.floor(sol * LAMPORTS_PER_SOL * 1e6 / cuLimit);
  return Math.max(1_000, Math.min(1_000_000, micro));
}

export function withdrawFeeLamports(priorityFeeSol: number, cuLimit = CU_LIMIT_SOL): number {
  const micro = priorityMicroLamports(priorityFeeSol, cuLimit);
  const prio = Math.ceil(cuLimit * micro / 1e6);
  return 5_000 + prio + 5_000; // base + priority + one extra tx of buffer
}

/** Lamports to leave in the bot wallet: fees, plus exit reserve when positions are open. */
export function keepLamportsForWithdraw(opts: { priorityFeeSol: number; openLivePositions?: number }): number {
  const fee = withdrawFeeLamports(opts.priorityFeeSol);
  const n = Math.max(0, opts.openLivePositions || 0);
  const exit = n > 0 ? Math.ceil((n * (BASE_FEE_SOL + (opts.priorityFeeSol || 0) * 2) + ATA_RENT_SOL) * LAMPORTS_PER_SOL) : 0;
  return fee + exit;
}

export function spendableLamports(balance: number, keep: number): number {
  return Math.max(0, balance - keep);
}

function rpc(rpcUrl: string) {
  return new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com', { commitment: 'confirmed', disableRetryOnRateLimit: false });
}

function attachBudget(tx: Transaction, priorityFeeSol: number, cuLimit = CU_LIMIT_SOL) {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports(priorityFeeSol, cuLimit) }));
}

async function sendSigned(conn: Connection, build: (blockhash: string) => Transaction, kp: Keypair, attempts = 3): Promise<{ signature: string; attempts: number }> {
  let last: Error | null = null;
  for (let i = 1; i <= attempts; i++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = build(blockhash);
    tx.sign(kp);
    try {
      const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
      const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (conf.value.err) throw new Error('ถอนไม่สำเร็จบนโซลานา');
      return { signature, attempts: i };
    } catch (e: any) {
      last = e instanceof Error ? e : new Error(String(e));
      const msg = last.message || '';
      if (/block height exceeded|blockhash not found|expired|has expired/i.test(msg) && i < attempts) continue;
      if (/already been processed|already processed/i.test(msg)) {
        // Signature may have landed; caller should not retry blindly. Re-throw unless we have a sig — not available here.
        throw last;
      }
      if (i < attempts && /429|timeout|fetch|ECONNRESET|network/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 400 * i));
        continue;
      }
      throw last;
    }
  }
  throw last || new Error('ถอนไม่สำเร็จ');
}

export async function sendSolWithdraw(
  rpcUrl: string,
  to: string,
  lamports: number | undefined,
  opts: { priorityFeeSol?: number; keepLamports?: number } = {},
): Promise<{ signature: string; lamports: number; attempts: number }> {
  const parsed = parseWithdrawDestination(to);
  if (!parsed.ok) throw new Error(parsed.error);
  const self = botPublicKey();
  if (self && parsed.address === self) throw new Error(WITHDRAW_ERR.self);
  const kp = botKeypair();
  const dest = new PublicKey(parsed.address);
  const conn = rpc(rpcUrl);
  const prio = opts.priorityFeeSol ?? 0.0001;
  const keep = opts.keepLamports ?? withdrawFeeLamports(prio);
  const bal = await conn.getBalance(kp.publicKey, 'confirmed');
  const send = lamports != null
    ? Math.min(Math.floor(lamports), spendableLamports(bal, keep))
    : spendableLamports(bal, keep);
  if (send <= 0) throw new Error(WITHDRAW_ERR.noFunds);
  const built = await sendSigned(conn, (blockhash) => {
    const tx = new Transaction();
    attachBudget(tx, prio);
    tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: send }));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = blockhash;
    return tx;
  }, kp, 3);
  return { signature: built.signature, lamports: send, attempts: built.attempts };
}

/** Preview a withdraw without signing or sending. Read-only. */
export async function previewSolWithdraw(
  rpcUrl: string,
  from: string,
  lamports: number | undefined,
  keep: number,
): Promise<{ balance: number; keep: number; send: number }> {
  const conn = rpc(rpcUrl);
  const bal = await conn.getBalance(new PublicKey(from), 'confirmed');
  const send = lamports != null
    ? Math.min(Math.floor(lamports), spendableLamports(bal, keep))
    : spendableLamports(bal, keep);
  return { balance: bal, keep, send };
}

void redactSecrets;
