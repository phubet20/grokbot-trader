import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdcAmount, canAutoSwapUsdc, MIN_USDC_SWAP, swapUsdcToSol } from '../server/usdc.ts';
import { DEFAULTS } from '../server/config.ts';
import { ReplayMarket } from '../server/replay.ts';

test('parseUsdcAmount converts raw 6-decimal amounts', () => {
  const a = parseUsdcAmount('1500000');
  assert.equal(a.ui, 1.5);
  assert.equal(a.raw, 1_500_000n);
  const z = parseUsdcAmount('0');
  assert.equal(z.ui, 0);
});

test('USDC auto-swap is skipped in paper, on dust, and when SOL for fees is missing', () => {
  assert.equal(canAutoSwapUsdc('paper', 10, 1).ok, false);
  assert.equal(canAutoSwapUsdc('paper', 10, 1).reason, 'paper');
  assert.equal(canAutoSwapUsdc('live-auto', 0.1, 1).ok, false);
  assert.equal(canAutoSwapUsdc('live-auto', 0.1, 1).reason, 'dust');
  assert.ok(MIN_USDC_SWAP >= 0.5);
  assert.equal(canAutoSwapUsdc('live-auto', 5, 0).ok, false);
  assert.equal(canAutoSwapUsdc('live-auto', 5, 1).ok, true);
});

test('swapUsdcToSol refuses while MODE is paper', async () => {
  await assert.rejects(
    () => swapUsdcToSol(DEFAULTS, new ReplayMarket()),
    /live-only|disabled/i,
  );
});
