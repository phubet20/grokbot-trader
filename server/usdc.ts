// Solana USDC (SPL) helpers. FOMO and other wallets can send USDC on Solana
// to the bot address. Live modes may auto-swap it to SOL. Paper only displays.
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { USDC_MINT, SOL_MINT } from './market.ts';
import { liveGate, type Config } from './config.ts';
import { botKeypair, botPublicKey, hasBotWallet, redactSecrets } from './wallet.ts';
import { buildLiveSwapTx, signAndSendSwap, getSolBalance, fetchSwapOrder, isGaslessOrder, signAndExecuteOrder } from './executor.ts';
import type { MarketSource } from './market.ts';
import { reserveSol } from './risk.ts';

export { USDC_MINT };
export const USDC_DECIMALS = 6;
export const MIN_USDC_SWAP = 0.5;
export const USDC_FEE_RESERVE_SOL = 0.005;

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

export type UsdcBalance = { raw: bigint; ui: number; ata: string | null; mint: string };

export function parseUsdcAmount(amount: string | number, decimals = USDC_DECIMALS): { raw: bigint; ui: number } {
  const raw = BigInt(typeof amount === 'number' ? Math.floor(amount) : String(amount || '0'));
  const ui = Number(raw) / 10 ** decimals;
  return { raw, ui };
}

export function ataAddress(owner: PublicKey, mint: PublicKey = new PublicKey(USDC_MINT)): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN,
  )[0];
}

export async function getUsdcBalance(rpcUrl: string, owner: string): Promise<UsdcBalance> {
  const empty: UsdcBalance = { raw: 0n, ui: 0, ata: null, mint: USDC_MINT };
  if (!owner || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) return empty;
  try {
    const conn = new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com', { commitment: 'confirmed' });
    const ownerPk = new PublicKey(owner);
    const res = await conn.getParsedTokenAccountsByOwner(ownerPk, { mint: new PublicKey(USDC_MINT) });
    let raw = 0n;
    let ata: string | null = null;
    for (const a of res.value || []) {
      const amt = a.account.data?.parsed?.info?.tokenAmount;
      const n = BigInt(String(amt?.amount || '0'));
      if (n > raw) { raw = n; ata = a.pubkey.toBase58(); }
    }
    return { raw, ui: Number(raw) / 10 ** USDC_DECIMALS, ata, mint: USDC_MINT };
  } catch {
    return empty;
  }
}

export function canAutoSwapUsdc(mode: string, usdcUi: number, solBalance: number, reserveSolAmt = USDC_FEE_RESERVE_SOL): { ok: boolean; reason: string; needGasless: boolean } {
  if (mode === 'paper') return { ok: false, reason: 'paper', needGasless: false };
  if (usdcUi < MIN_USDC_SWAP) return { ok: false, reason: 'dust', needGasless: false };
  if (solBalance < reserveSolAmt) return { ok: true, reason: 'need SOL for fees', needGasless: true };
  return { ok: true, reason: '', needGasless: false };
}

/** Live-auto only: swap the bot wallet's USDC to SOL via Jupiter, keeping a SOL fee reserve. */
export async function swapUsdcToSol(cfg: Config, m: MarketSource, amountRaw?: bigint): Promise<{ signature: string; usdcIn: number; solOutEst: number; gasless?: boolean }> {
  const gate = liveGate(cfg);
  if (!gate.live) throw new Error('USDC auto-swap is live-only: ' + gate.reason);
  if (!hasBotWallet()) throw new Error('bot wallet is not configured');
  const pub = botPublicKey()!;
  const bal = await getUsdcBalance(cfg.rpcUrl, pub);
  const raw = amountRaw != null && amountRaw > 0n ? (amountRaw < bal.raw ? amountRaw : bal.raw) : bal.raw;
  if (raw <= 0n || Number(raw) / 1e6 < MIN_USDC_SWAP) throw new Error('no USDC to swap');
  const sol = (await getSolBalance(cfg.rpcUrl, pub)) || 0;
  const reserve = Math.max(USDC_FEE_RESERVE_SOL, reserveSol(cfg.priorityFeeSol) + 0.002);
  const usdcIn = Number(raw) / 10 ** USDC_DECIMALS;
  if (sol < reserve) {
    const order = await fetchSwapOrder({ inputMint: USDC_MINT, outputMint: SOL_MINT, amountRaw: raw, taker: pub });
    if (!isGaslessOrder(order, pub)) {
      throw new Error('Need ~0.01 SOL for fees (no gasless Jupiter route for this size)');
    }
    const signature = await signAndExecuteOrder({ transaction: order.transaction!, requestId: order.requestId! });
    const solOutEst = Number(order.outAmount || 0) / 1e9;
    return { signature, usdcIn, solOutEst, gasless: true };
  }
  const built = await buildLiveSwapTx(cfg, m, {
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    amountRaw: raw,
    userPublicKey: pub,
  });
  const signature = await signAndSendSwap(cfg.rpcUrl, built.swapTransaction);
  const solOutEst = built.quote.outAmount / 1e9;
  return { signature, usdcIn, solOutEst, gasless: false };
}

function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, ata: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

function transferIx(source: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9);
  data[0] = 3; // Transfer
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Send USDC (all, or a raw amount) to a validated destination. Live only. */
export async function transferUsdc(
  rpcUrl: string,
  to: string,
  amountRaw?: bigint,
  opts: { priorityFeeSol?: number } = {},
): Promise<{ signature: string; usdc: number; attempts: number } | null> {
  if (!hasBotWallet()) return null;
  const kp = botKeypair();
  const bal = await getUsdcBalance(rpcUrl, kp.publicKey.toBase58());
  if (bal.raw <= 0n || !bal.ata) return null;
  const raw = amountRaw != null && amountRaw > 0n ? (amountRaw < bal.raw ? amountRaw : bal.raw) : bal.raw;
  if (raw <= 0n) return null;
  const dest = new PublicKey(to);
  const mint = new PublicKey(USDC_MINT);
  const destAta = ataAddress(dest, mint);
  const conn = new Connection(rpcUrl, { commitment: 'confirmed' });
  const cuLimit = 60_000;
  const prioSol = opts.priorityFeeSol ?? 0.0001;
  const micro = Math.max(1_000, Math.min(1_000_000, Math.floor(prioSol * 1e9 * 1e6 / cuLimit)));
  let last: Error | null = null;
  for (let i = 1; i <= 3; i++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
    tx.add(createAtaIdempotentIx(kp.publicKey, dest, mint, destAta));
    tx.add(transferIx(new PublicKey(bal.ata), destAta, kp.publicKey, raw));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(kp);
    try {
      const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
      const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (conf.value.err) throw new Error('ถอน USDC ไม่สำเร็จบนโซลานา');
      return { signature, usdc: Number(raw) / 10 ** USDC_DECIMALS, attempts: i };
    } catch (e: any) {
      last = e instanceof Error ? e : new Error(String(e));
      const msg = last.message || '';
      if (/block height exceeded|blockhash not found|expired|has expired|429|timeout|ECONNRESET/i.test(msg) && i < 3) {
        await new Promise((r) => setTimeout(r, 400 * i));
        continue;
      }
      console.log('[usdc] transfer: ' + redactSecrets(msg));
      throw last;
    }
  }
  throw last || new Error('ถอน USDC ไม่สำเร็จ');
}

/** Back-compat: send all remaining USDC. */
export async function transferUsdcToLocked(rpcUrl: string, to: string): Promise<{ signature: string; usdc: number } | null> {
  const r = await transferUsdc(rpcUrl, to);
  return r ? { signature: r.signature, usdc: r.usdc } : null;
}
