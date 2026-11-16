// Verifies the LIVE path can BUILD an unsigned Jupiter swap tx. Nothing is signed or sent.
import { DEFAULTS, LIVE_CONFIRM_PHRASE } from '../server/config.ts';
import { LiveMarket, SOL_MINT, USDC_MINT } from '../server/market.ts';
import { buildLiveSwapTx } from '../server/executor.ts';
const cfg = { ...DEFAULTS, mode: 'live' as const, liveConfirm: LIVE_CONFIRM_PHRASE };
const r = await buildLiveSwapTx(cfg, new LiveMarket(), { inputMint: SOL_MINT, outputMint: USDC_MINT, amountRaw: 10_000_000n, userPublicKey: '3kA85d5Rntcup8a8dKxqPPP2TavLPvNp857Urzmna4kx' });
console.log('unsigned tx bytes:', Buffer.from(r.swapTransaction, 'base64').length, 'route:', r.quote.route, 'lastValidBlockHeight:', r.lastValidBlockHeight);
