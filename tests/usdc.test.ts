import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdcAmount, canAutoSwapUsdc, MIN_USDC_SWAP, swapUsdcToSol } from '../server/usdc.ts';
import { isGaslessOrder } from '../server/executor.ts';
import { DEFAULTS } from '../server/config.ts';
import { ReplayMarket } from '../server/replay.ts';

test('parseUsdcAmount converts raw 6-decimal amounts', () => {
  const a = parseUsdcAmount('1500000');
  assert.equal(a.ui, 1.5);
  assert.equal(a.raw, 1_500_000n);
  const z = parseUsdcAmount('0');
  assert.equal(z.ui, 0);
});

test('USDC auto-swap is skipped in paper and on dust; 0 SOL still tries a gasless route', () => {
  assert.equal(canAutoSwapUsdc('paper', 10, 1).ok, false);
  assert.equal(canAutoSwapUsdc('paper', 10, 1).reason, 'paper');
  assert.equal(canAutoSwapUsdc('live-auto', 0.1, 1).ok, false);
  assert.equal(canAutoSwapUsdc('live-auto', 0.1, 1).reason, 'dust');
  assert.ok(MIN_USDC_SWAP >= 0.5);
  const g = canAutoSwapUsdc('live-auto', 5, 0);
  assert.equal(g.ok, true);
  assert.equal(g.needGasless, true);
  assert.equal(canAutoSwapUsdc('live-auto', 5, 1).ok, true);
  assert.equal(canAutoSwapUsdc('live-auto', 5, 1).needGasless, false);
});

test('swapUsdcToSol refuses while MODE is paper', async () => {
  await assert.rejects(
    () => swapUsdcToSol(DEFAULTS, new ReplayMarket()),
    /live-only|disabled/i,
  );
});

test('isGaslessOrder requires a sponsored fee payer and zero rent on the taker', () => {
  const taker = '2VscQ33yZudTXXNjCpfB5X4jsJVL4ZoZxGDzS5xCtLYo';
  const base = { gasless: true, requestId: 'r1', transaction: 'AQID', signatureFeePayer: 'SomeMarketMaker111', rentFeeLamports: 0 };
  assert.equal(isGaslessOrder(base, taker), true);
  assert.equal(isGaslessOrder({ ...base, signatureFeePayer: taker }, taker), false);
  assert.equal(isGaslessOrder({ ...base, gasless: false }, taker), false);
  assert.equal(isGaslessOrder({ ...base, rentFeeLamports: 1488440 }, taker), false);
  assert.equal(isGaslessOrder({ ...base, transaction: '' }, taker), false);
});
