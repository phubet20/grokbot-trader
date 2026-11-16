// EXECUTOR agent.
//  - paper mode (default): fills are simulated at the REAL Jupiter quote
//    (price impact included) + extra pessimistic slippage + network/priority fees
//    + token-account rent (locked while the position is open).
//  - live mode: builds an UNSIGNED Jupiter swap transaction that must be signed
//    in the user's Phantom wallet. No private keys are ever stored or used here.
import type { MarketSource } from './market.ts';
import { SOL_MINT } from './market.ts';
import type { Config } from './config.ts';
import { liveGate } from './config.ts';

export const BASE_FEE_SOL = 0.000005;
export const ATA_RENT_SOL = 0.00203928;

export type BuyFill = { ok: true; tokens: number; decimals: number; solSpent: number; feesSol: number; rentSol: number; fillPrice: number; impactPct: number; route: string } | { ok: false; error: string };
export type SellFill = { ok: true; solReceived: number; feesSol: number; fillPrice: number; impactPct: number; route: string } | { ok: false; error: string };

export class PaperExecutor {
  m: MarketSource;
  cfg: Config;
  constructor(m: MarketSource, cfg: Config) { this.m = m; this.cfg = cfg; }

  async buy(mint: string, solAmount: number, solPrice: number): Promise<BuyFill> {
    const lamports = BigInt(Math.floor(solAmount * 1e9));
    if (lamports <= 0n) return { ok: false, error: 'size 0' };
    const q = await this.m.quote(SOL_MINT, mint, lamports, this.cfg.slippageBps);
    if (!q || q.outAmount <= 0) return { ok: false, error: 'no Jupiter route' };
    if (q.priceImpactPct > 5) return { ok: false, error: `price impact ${q.priceImpactPct.toFixed(1)}%` };
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
    return { ok: true, solReceived, feesSol, fillPrice: (solReceived * solPrice) / tokens, impactPct: q.priceImpactPct, route: q.route };
  }
}

/**
 * LIVE path - builds an unsigned versioned transaction via Jupiter's swap API.
 * The returned base64 tx is sent to the browser where the user approves it in
 * Phantom (signAndSendTransaction). Refuses unless liveGate() is armed.
 */
export async function buildLiveSwapTx(cfg: Config, m: MarketSource, args: { inputMint: string; outputMint: string; amountRaw: bigint; userPublicKey: string }) {
  const gate = liveGate(cfg);
  if (!gate.live) throw new Error('LIVE trading is disabled: ' + gate.reason);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(args.userPublicKey)) throw new Error('invalid wallet address');
  const q = await m.quote(args.inputMint, args.outputMint, args.amountRaw, cfg.slippageBps);
  if (!q?.raw) throw new Error('no Jupiter route');
  const r = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q.raw,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Math.round(cfg.priorityFeeSol * 1e9 * 5), priorityLevel: 'high' } },
    }),
  });
  if (!r.ok) throw new Error('Jupiter swap build failed HTTP ' + r.status);
  const d: any = await r.json();
  return { swapTransaction: d.swapTransaction as string, lastValidBlockHeight: d.lastValidBlockHeight as number, quote: q };
}

/** Read-only SOL balance for a public address (used to display the connected wallet). */
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
