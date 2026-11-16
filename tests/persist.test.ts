
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'gb-persist-'));
process.env.DATA_DIR = dir;
const { Store, exportSnapshot, importSnapshot, SYNC_KV } = await import('../server/store.ts');
const { remoteStateConfigured } = await import('../server/remote-state.ts');

test('exportSnapshot never includes secrets and import restores the paper book', () => {
  const s = new Store(join(dir, 'p.db'));
  s.set('wallet', { connected: true, type: 'paper', address: 'Paper111', solBalance: 1, depositUsd: 81, startedAt: 1, running: true, dayKey: 'x', dayStartEquity: 81, realSol: null });
  s.set('positions', [{ id: 'p1', mint: 'M', symbol: 'COIN', qty: 1, lastPrice: 1, entryPrice: 1, costUsd: 2 }]);
  s.set('autotune', { slope: 1, trades: [] });
  s.set('config', { takeProfitPct: 2, realisticPaper: true, liveConfirm: 'I UNDERSTAND REAL FUNDS ARE AT RISK', mode: 'live', rpcUrl: 'http://secret' });
  s.set('withdrawHistory', [{ ts: 1, sol: 0.1, to: 'Dest111', signature: 'sig' }]);
  s.addTrade({ id: 't1', closedAt: Date.now(), symbol: 'COIN', pnlUsd: 0.5 } as any);
  s.addEquity(Date.now(), 82);
  const snap = exportSnapshot(s);
  const blob = JSON.stringify(snap);
  assert.equal(snap.v, 1);
  assert.ok(snap.kv.wallet);
  assert.equal((snap.kv.wallet as any).depositUsd, 81);
  assert.equal((snap.kv.positions as any[]).length, 1);
  assert.equal((snap.kv.config as any).takeProfitPct, 2);
  assert.equal((snap.kv.config as any).liveConfirm, undefined);
  assert.equal((snap.kv.config as any).mode, undefined);
  assert.equal((snap.kv.config as any).rpcUrl, undefined);
  assert.doesNotMatch(blob, /I UNDERSTAND REAL FUNDS ARE AT RISK/);
  assert.doesNotMatch(blob, /http:\/\/secret/);
  for (const k of Object.keys(snap.kv)) {
    assert.doesNotMatch(k, /secret|token|private|seed|mnemonic|password/i);
  }
  assert.ok(SYNC_KV.includes('config'));

  const s2 = new Store(join(dir, 'p2.db'));
  assert.equal(importSnapshot(s2, snap), true);
  assert.equal((s2.get('wallet', {}) as any).depositUsd, 81);
  assert.equal((s2.get('positions', []) as any[]).length, 1);
  assert.equal(s2.trades(10).length, 1);
  assert.equal((s2.get('config', {}) as any).liveConfirm, undefined);
});

test('remote-state is off unless STATE_GITHUB_TOKEN is set, and never reads a committed token', () => {
  const prev = process.env.STATE_GITHUB_TOKEN;
  delete process.env.STATE_GITHUB_TOKEN;
  assert.equal(remoteStateConfigured(), false);
  if (prev) process.env.STATE_GITHUB_TOKEN = prev;
});
