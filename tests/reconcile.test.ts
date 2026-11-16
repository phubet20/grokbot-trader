import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOnchainHoldings } from '../server/reconcile.ts';

test('applyOnchainHoldings drops paper positions that are not in the wallet', () => {
  const paper = [
    { mint: 'PaperMint111', qty: 1000, decimals: 6, id: 'p1', symbol: 'FAKE' },
    { mint: 'PaperMint222', qty: 50, decimals: 6, id: 'p2', symbol: 'FAKE2' },
  ];
  const kept = applyOnchainHoldings(paper, [], []);
  assert.equal(kept.length, 0);
});

test('applyOnchainHoldings keeps and resizes on-chain holdings, and appends new ones', () => {
  const current = [
    { mint: 'MintHeld', qty: 10, decimals: 6, id: 'live-1', symbol: 'HELD' },
    { mint: 'MintGone', qty: 99, decimals: 6, id: 'paper-leftover', symbol: 'GONE' },
  ];
  const holdings = [
    { mint: 'MintHeld', qty: 12.5, decimals: 6 },
    { mint: 'MintNew', qty: 3, decimals: 9 },
  ];
  const incoming = [
    { mint: 'MintNew', qty: 3, decimals: 9, id: 'recon-MintNew', symbol: 'NEW' },
  ];
  const kept = applyOnchainHoldings(current, holdings, incoming);
  assert.equal(kept.length, 2);
  const held = kept.find((p) => p.mint === 'MintHeld')!;
  assert.equal(held.qty, 12.5);
  assert.equal(held.id, 'live-1');
  assert.ok(kept.some((p) => p.mint === 'MintNew' && p.id === 'recon-MintNew'));
  assert.ok(!kept.some((p) => p.mint === 'MintGone'));
});
