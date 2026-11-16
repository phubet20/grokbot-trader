// Rebuild open positions from the bot wallet's on-chain SPL token accounts.
// Used on live / live-auto startup after a sleep or redeploy. Never sends a transaction.
import { Connection, PublicKey } from '@solana/web3.js';
import type { Position } from './types.ts';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SKIP = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

export type Reconciled = Position & { reconciled: true; entryEstimated: boolean };

export async function fetchTokenHoldings(rpcUrl: string, owner: string): Promise<{ mint: string; qty: number; decimals: number; ata: string }[]> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) throw new Error('invalid owner');
  const conn = new Connection(rpcUrl, 'confirmed');
  const ownerPk = new PublicKey(owner);
  const out: { mint: string; qty: number; decimals: number; ata: string }[] = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
    const res = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId });
    for (const { pubkey, account } of res.value) {
      const info = (account.data as any)?.parsed?.info;
      const mint = info?.mint;
      const ta = info?.tokenAmount;
      if (!mint || SKIP.has(mint)) continue;
      const qty = Number(ta?.uiAmount);
      const decimals = Number(ta?.decimals ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      out.push({ mint, qty, decimals, ata: pubkey.toBase58() });
    }
  }
  return out;
}

/** Best-effort entry from recent parsed txs on the ATA: first inbound transfer / swap. */
export async function estimateEntryFromHistory(rpcUrl: string, ata: string, solPrice: number): Promise<{ entryPrice: number; openedAt: number; estimated: boolean } | null> {
  const conn = new Connection(rpcUrl, 'confirmed');
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(ata), { limit: 20 });
    if (!sigs.length) return null;
    // oldest first to find the opening inbound
    const ordered = [...sigs].reverse();
    const txs = await conn.getParsedTransactions(ordered.map((s) => s.signature), { maxSupportedTransactionVersion: 0 });
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      if (!tx || tx.meta?.err) continue;
      const openedAt = (tx.blockTime || ordered[i].blockTime || 0) * 1000;
      const pre = (tx.meta?.preTokenBalances || []).find((b: any) => b.owner && true);
      // SOL spent ≈ pre/post lamport drop on the fee payer (bot wallet)
      const solSpent = Math.max(0, ((tx.meta?.preBalances?.[0] || 0) - (tx.meta?.postBalances?.[0] || 0)) / 1e9);
      const preTok = (tx.meta?.preTokenBalances || []).find((b: any) => b.pubkey === ata || b.accountIndex !== undefined);
      // Find token amount gained on this ATA
      let gained = 0;
      const keys = tx.transaction.message.getAccountKeys?.() || { get: (_n: number) => null };
      const postTok = (tx.meta?.postTokenBalances || []);
      const preMap = new Map((tx.meta?.preTokenBalances || []).map((b: any) => [b.accountIndex, Number(b.uiTokenAmount?.uiAmount || 0)]));
      for (const b of postTok) {
        const after = Number(b.uiTokenAmount?.uiAmount || 0);
        const before = preMap.get(b.accountIndex) || 0;
        const d = after - before;
        if (d > gained) gained = d;
      }
      if (gained > 0 && solSpent > 0 && solPrice > 0) {
        const fees = 0.00001;
        const entryPrice = ((solSpent) * solPrice) / gained;
        if (entryPrice > 0 && Number.isFinite(entryPrice)) return { entryPrice, openedAt: openedAt || Date.now(), estimated: false };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function rebuildPositions(opts: {
  rpcUrl: string; owner: string; solPrice: number;
  current: Position[];
  priceOf: (mint: string) => Promise<number>;
  metaOf?: (mint: string) => { symbol?: string; name?: string; image?: string; pool?: string } | undefined;
}): Promise<{ positions: Position[]; added: number; skipped: number }> {
  const holdings = await fetchTokenHoldings(opts.rpcUrl, opts.owner);
  const have = new Set(opts.current.map((p) => p.mint));
  const positions = [...opts.current];
  let added = 0, skipped = 0;
  for (const h of holdings) {
    if (have.has(h.mint)) continue;
    const px = await opts.priceOf(h.mint).catch(() => 0);
    if (!(px > 0)) { skipped++; continue; }
    const hist = await estimateEntryFromHistory(opts.rpcUrl, h.ata, opts.solPrice);
    const entry = hist?.entryPrice || px;
    const estimated = !hist || hist.estimated || !!(hist && Math.abs(hist.entryPrice - px) / px > 5);
    const meta = opts.metaOf?.(h.mint) || {};
    const pos: Reconciled = {
      id: 'recon-' + h.mint.slice(0, 16),
      mint: h.mint, pool: meta.pool || '', symbol: meta.symbol || h.mint.slice(0, 6),
      name: meta.name || meta.symbol || 'on-chain', image: meta.image,
      openedAt: hist?.openedAt || Date.now(),
      entryPrice: entry, qty: h.qty, decimals: h.decimals,
      costUsd: entry * h.qty, costSol: opts.solPrice > 0 ? (entry * h.qty) / opts.solPrice : 0,
      peakPrice: Math.max(entry, px), lastPrice: px, score: 0, rentSol: 0.002,
      reconciled: true, entryEstimated: !hist || estimated,
    };
    positions.push(pos);
    have.add(h.mint);
    added++;
  }
  // Drop local positions that no longer have tokens (unless qty was already 0)
  const live = new Set(holdings.map((h) => h.mint));
  const kept = positions.filter((p) => !p.id.startsWith('recon-') || live.has(p.mint));
  return { positions: kept, added, skipped };
}

export async function fetchMintAuthorities(rpcUrl: string, mint: string): Promise<{ mintAuthority: string | null; freezeAuthority: string | null; decimals: number } | null> {
  try {
    const conn = new Connection(rpcUrl, 'confirmed');
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info.value?.data as any)?.parsed?.info;
    if (!parsed) return null;
    return {
      mintAuthority: parsed.mintAuthority || null,
      freezeAuthority: parsed.freezeAuthority || null,
      decimals: Number(parsed.decimals ?? 6),
    };
  } catch { return null; }
}
