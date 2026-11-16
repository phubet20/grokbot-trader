// EXECUTOR agent.
//  - paper mode (default): fills are simulated at the REAL Jupiter quote
//    (price impact included) + extra pessimistic slippage + network/priority fees
//    + token-account rent (locked while the position is open, reclaimed on close).
//  - live mode: builds an UNSIGNED Jupiter swap transaction that must be signed
//    in the user's Phantom wallet. No private keys are ever stored or used here.
//  - live-auto: the bot wallet signs and sends the same unsigned swap. The secret
//    never leaves wallet.ts / this module and is never logged.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  VersionedTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { MarketSource } from './market.ts';
import { SOL_MINT } from './market.ts';
import type { Config } from './config.ts';
import { liveGate } from './config.ts';
import { botKeypair, redactSecrets } from './wallet.ts';
import { BASE_FEE_SOL, ATA_RENT_SOL } from './risk.ts';

export { BASE_FEE_SOL, ATA_RENT_SOL };

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export type BuyFill = { ok: true; tokens: number; decimals: number; solSpent: number; feesSol: number; rentSol: number; fillPrice: number; impactPct: number; route: string } | { ok: false; error: string };
export type SellFill = { ok: true; solReceived: number; feesSol: number; fillPrice: number; impactPct: number; route: string; closedAta?: boolean } | { ok: false; error: string };

export function dynamicSlippageBps(baseBps: number, priceImpactPct: number): number {
  const bump = Math.round(Math.max(0, priceImpactPct) * 100); // 1% impact -> +100 bps
  return Math.max(baseBps, Math.min(900, baseBps + bump));
}

export class PaperExecutor {
  m: MarketSource;
  cfg: Config;
  constructor(m: MarketSource, cfg: Config) { this.m = m; this.cfg = cfg; }

  async buy(mint: string, solAmount: number, solPrice: number): Promise<BuyFill> {
    const lamports = BigInt(Math.floor(solAmount * 1e9));
    if (lamports <= 0n) return { ok: false, error: 'size 0' };
    const slip = this.cfg.slippageBps;
    const q = await this.m.quote(SOL_MINT, mint, lamports, slip);
    if (!q || q.outAmount <= 0) return { ok: false, error: 'no Jupiter route' };
    const impactCap = q.route === 'pump-curve' ? 15 : 6;
    if (q.priceImpactPct > impactCap) return { ok: false, error: `price impact ${q.priceImpactPct.toFixed(1)}%` };
    const decimals = await this.m.decimals(mint);
    const tokens = (q.outAmount / 10 ** decimals) * (1 - this.cfg.extraSlippageBps / 1e4);
    const feesSol = BASE_FEE_SOL + this.cfg.priorityFeeSol;
    const fillPrice = (solAmount * solPrice) / tokens;
    return { ok: true, tokens, decimals, solSpent: solAmount, feesSol, rentSol: ATA_RENT_SOL, fillPrice, impactPct: q.priceImpactPct, route: q.route };
  }

  async sell(mint: string, tokens: number, decimals: number, solPrice: number): Promise<SellFill> {
    const raw = BigInt(Math.floor(tokens * 10 ** decimals));
    if (raw <= 0n) return { ok: false, error: 'qty 0' };
    const q = await this.m.quote(mint, SOL_MINT, raw, this.cfg.slippageBps);
    if (!q || q.outAmount <= 0) return { ok: false, error: 'no Jupiter route' };
    const solReceived = (q.outAmount / 1e9) * (1 - this.cfg.extraSlippageBps / 1e4);
    const feesSol = BASE_FEE_SOL + this.cfg.priorityFeeSol;
    // Paper: closing the token account reclaims rent (applied by the engine).
    return { ok: true, solReceived, feesSol, fillPrice: (solReceived * solPrice) / tokens, impactPct: q.priceImpactPct, route: q.route, closedAta: true };
  }
}

function rpcConnection(rpcUrl: string) {
  return new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com', { commitment: 'confirmed', disableRetryOnRateLimit: false });
}

export async function buildLiveSwapTx(cfg: Config, m: MarketSource, args: { inputMint: string; outputMint: string; amountRaw: bigint; userPublicKey: string; closeOutputAta?: boolean }) {
  const gate = liveGate(cfg);
  if (!gate.live) throw new Error('LIVE trading is disabled: ' + gate.reason);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(args.userPublicKey)) throw new Error('invalid wallet address');
  const q = await m.quote(args.inputMint, args.outputMint, args.amountRaw, cfg.slippageBps);
  if (!q?.raw) throw new Error('no Jupiter route');
  const slip = dynamicSlippageBps(cfg.slippageBps, q.priceImpactPct);
  const body: any = {
    quoteResponse: q.raw,
    userPublicKey: args.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: { maxBps: slip },
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: Math.max(200_000, Math.round(cfg.priorityFeeSol * 1e9 * 8)),
        priorityLevel: 'veryHigh',
      },
    },
  };
  const r = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Jupiter swap build failed HTTP ' + r.status);
  const d: any = await r.json();
  if (!d.swapTransaction) throw new Error('Jupiter swap build returned no transaction');
  return { swapTransaction: d.swapTransaction as string, lastValidBlockHeight: d.lastValidBlockHeight as number, quote: q, slippageBps: slip };
}

/** Sign a Jupiter (or any) versioned transaction. Does not send. For tests and live-auto. */
export function signVersionedTx(swapTransactionBase64: string, kp: Keypair): { signedBase64: string; signature: string } {
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransactionBase64, 'base64'));
  tx.sign([kp]);
  const sig = Buffer.from(tx.signatures[0]).toString('base64');
  return { signedBase64: Buffer.from(tx.serialize()).toString('base64'), signature: sig };
}

export async function sendSignedTx(rpcUrl: string, signedBase64: string, retries = 3): Promise<string> {
  const conn = rpcConnection(rpcUrl);
  const raw = Buffer.from(signedBase64, 'base64');
  let last: any;
  for (let i = 0; i < retries; i++) {
    try {
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
      const conf = await conn.confirmTransaction(sig, 'confirmed');
      if (conf.value.err) throw new Error('on-chain error ' + JSON.stringify(conf.value.err));
      return sig;
    } catch (e: any) {
      last = e;
      const msg = String(e?.message || e);
      if (/blockhash|expired|429|rate/i.test(msg) && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1) * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

export async function signAndSendSwap(rpcUrl: string, swapTransactionBase64: string): Promise<string> {
  const kp = botKeypair();
  const { signedBase64 } = signVersionedTx(swapTransactionBase64, kp);
  return sendSignedTx(rpcUrl, signedBase64);
}

function closeAccountIx(account: PublicKey, dest: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

async function closeEmptyTokenAccounts(conn: Connection, kp: Keypair): Promise<number> {
  const owner = kp.publicKey;
  let closed = 0;
  for (const program of [TOKEN_PROGRAM, TOKEN_2022]) {
    let res: any;
    try { res = await conn.getParsedTokenAccountsByOwner(owner, { programId: program }); }
    catch { continue; }
    const empty = res.value.filter((a: any) => Number(a.account.data?.parsed?.info?.tokenAmount?.amount || 1) === 0);
    for (let i = 0; i < empty.length; i += 6) {
      const chunk = empty.slice(i, i + 6);
      const tx = new Transaction();
      for (const a of chunk) tx.add(closeAccountIx(new PublicKey(a.pubkey), owner, owner, program));
      tx.feePayer = owner;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.sign(kp);
      try {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        closed += chunk.length;
      } catch { /* leave unclosed; withdraw can still send SOL */ }
    }
  }
  return closed;
}

/**
 * Send SOL from the bot wallet to a locked destination only. Closes empty token
 * accounts first so rent is reclaimed. The caller must already have verified
 * `to` is the locked withdraw address. Never logs the secret.
 */
export async function withdrawToLocked(rpcUrl: string, to: string, lamports?: number): Promise<{ signature: string; closedAccounts: number; lamports: number }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) throw new Error('invalid withdraw address');
  const kp = botKeypair();
  if (kp.publicKey.toBase58() === to) throw new Error('refuse to withdraw to the bot wallet itself');
  const conn = rpcConnection(rpcUrl);
  let closedAccounts = 0;
  try { closedAccounts = await closeEmptyTokenAccounts(conn, kp); } catch (e: any) {
    console.log('[withdraw] close accounts: ' + redactSecrets(e?.message || String(e)));
  }
  const fee = 5000;
  const bal = await conn.getBalance(kp.publicKey, 'confirmed');
  const send = lamports != null ? Math.min(lamports, Math.max(0, bal - fee)) : Math.max(0, bal - fee);
  if (send <= 0) throw new Error('nothing to withdraw after fees');
  const dest = new PublicKey(to);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: send }));
  tx.feePayer = kp.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(kp);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error('withdraw failed on-chain');
  return { signature, closedAccounts, lamports: send };
}

/** Offline dry-run: build and sign a transfer, do not send. */
export function dryRunSignTransfer(from: Keypair, to: PublicKey, lamports: number, recentBlockhash: string): { signature: string; signed: Transaction } {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  tx.feePayer = from.publicKey;
  tx.recentBlockhash = recentBlockhash;
  tx.sign(from);
  const sig = tx.signature ? Buffer.from(tx.signature).toString('base64') : '';
  if (!tx.verifySignatures()) throw new Error('dry-run signature verify failed');
  return { signature: sig, signed: tx };
}

export async function getSolBalance(rpcUrl: string, address: string): Promise<number | null> {
  try {
    const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }) });
    const d: any = await r.json();
    return typeof d?.result?.value === 'number' ? d.result.value / 1e9 : null;
  } catch { return null; }
}

export async function getSignatureStatus(rpcUrl: string, sig: string): Promise<string | null> {
  try {
    const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[sig], { searchTransactionHistory: true }] }) });
    const d: any = await r.json();
    const s = d?.result?.value?.[0];
    if (!s) return null;
    if (s.err) return 'failed';
    return s.confirmationStatus || 'processed';
  } catch { return null; }
}

void LAMPORTS_PER_SOL;
