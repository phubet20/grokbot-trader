import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeMode, liveBuysAllowed, pickRuntimeMode } from '../server/runtime-mode.ts';

test('no persisted choice stays on TEST even if host MODE is live-auto', () => {
  assert.equal(resolveRuntimeMode({ armed: true, envMode: 'live-auto' }), 'paper');
  assert.equal(resolveRuntimeMode({ armed: true, auto: true }), 'paper');
});

test('explicit RUNTIME_MODE or saved mode is honored when live is armed', () => {
  assert.equal(resolveRuntimeMode({ armed: true, envRuntimeMode: 'live-auto', envMode: 'paper' }), 'live-auto');
  assert.equal(resolveRuntimeMode({ armed: true, savedMode: 'paper', envRuntimeMode: 'live-auto' }), 'paper');
  assert.equal(resolveRuntimeMode({ armed: false, savedMode: 'live-auto' }), 'paper');
});

test('live buys require mode + explicit armed flag + live gate', () => {
  assert.equal(liveBuysAllowed('live-auto', true, true), true);
  assert.equal(liveBuysAllowed('paper', true, true), false);
  assert.equal(liveBuysAllowed('live-auto', false, true), false);
  assert.equal(liveBuysAllowed('live-auto', true, false), false);
  assert.equal(liveBuysAllowed('live', true, true), true);
});

test('pickRuntimeMode accepts test as paper', () => {
  assert.equal(pickRuntimeMode('test'), 'paper');
  assert.equal(pickRuntimeMode('LIVE-AUTO'), 'live-auto');
});
