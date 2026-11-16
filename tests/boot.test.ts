import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLASH_MS, splashProgress, splashShouldFinish, nextBackoffMs, placeholderSnap, saveSnapCache, loadSnapCache } from '../web/src/boot.ts';

test('splash finishes in 1.5s or on tap, and never waits on ready', () => {
  assert.equal(SPLASH_MS, 1500);
  assert.equal(splashProgress(0), 0);
  assert.equal(splashProgress(750), 0.5);
  assert.equal(splashProgress(1500), 1);
  assert.equal(splashProgress(5000), 1);
  assert.equal(splashShouldFinish(0, false), false);
  assert.equal(splashShouldFinish(1499, false), false);
  assert.equal(splashShouldFinish(1500, false), true);
  assert.equal(splashShouldFinish(200, true), true);
  // ready is intentionally not a parameter — network cannot block the splash
  assert.equal(splashShouldFinish(1500, false), true);
});

test('backoff grows and caps at 15s', () => {
  let ms = 0;
  const seq = [];
  for (let i = 0; i < 8; i++) { ms = nextBackoffMs(ms); seq.push(ms); }
  assert.equal(seq[0], 1000);
  assert.ok(seq[1] > seq[0]);
  assert.equal(seq[seq.length - 1], 15_000);
});

test('placeholder snap is safe to render and cache helpers tolerate missing localStorage', () => {
  const p = placeholderSnap();
  assert.equal(p.appName, 'Grok Bot');
  assert.equal(p.wallet.connected, false);
  assert.ok(p.agents.scanner);
  const merged = placeholderSnap({ appName: 'X', wallet: { connected: true, type: 'paper', address: 'A', solBalance: 1, depositUsd: 10, running: true, realSol: null, startedAt: 1, dayKey: '', dayStartEquity: 10 } });
  assert.equal(merged.appName, 'X');
  assert.equal(merged.wallet.connected, true);
  assert.equal(loadSnapCache(), null);
  assert.doesNotThrow(() => saveSnapCache({ appName: 'X', wallet: {}, stats: {}, positions: [] }));
});
