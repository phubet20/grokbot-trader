// Build an unsigned SOL transfer from the user's Phantom wallet to the bot wallet.
// Never sends the transaction. The client may sign it in Phantom when not in paper/dry-run.
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { Connection } from '@solana/web3.js';

export function assembleDepositTx(opts: { from: string; to: string; lamports: number; blockhash: string }): Transaction {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.from)) throw new Error('invalid source address');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.to)) throw new Error('invalid bot wallet address');
  if (opts.from === opts.to) throw new Error('source and destination are the same');
  if (!Number.isFinite(opts.lamports) || opts.lamports <= 0 || !Number.isInteger(opts.lamports)) throw new Error('enter an amount of SOL greater than 0');
  if (opts.lamports > 1e15) throw new Error('amount too large');
  const from = new PublicKey(opts.from);
  const to = new PublicKey(opts.to);
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: opts.lamports }));
  tx.recentBlockhash = opts.blockhash;
  tx.feePayer = from;
  return tx;
}

export function solToLamports(sol: number): number {
  const n = Number(sol);
  if (!Number.isFinite(n) || n <= 0) throw new Error('enter an amount of SOL greater than 0');
  const lamports = Math.round(n * 1e9);
  if (lamports <= 0) throw new Error('enter an amount of SOL greater than 0');
  return lamports;
}

export function serializeUnsigned(tx: Transaction): string {
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}

export async function prepareDepositTx(rpcUrl: string, from: string, to: string, sol: number) {
  const lamports = solToLamports(sol);
  const connection = new Connection(rpcUrl, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = assembleDepositTx({ from, to, lamports, blockhash });
  return {
    txBase64: serializeUnsigned(tx),
    from,
    to,
    sol: lamports / 1e9,
    lamports,
    blockhash,
    lastValidBlockHeight,
    sent: false as const,
  };
}
