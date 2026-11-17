import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeSoundFor, SOUND_PREF_KEY, soundEnabled, setSoundEnabled } from '../web/src/sounds.ts';

test('tradeSoundFor maps buys and sells, with a lower tone on losing sells', () => {
  assert.equal(tradeSoundFor({ kind: 'buy', usd: 1 }), 'buy');
  assert.equal(tradeSoundFor({ kind: 'sell', usd: 0.4, pct: 3 }), 'sell-win');
  assert.equal(tradeSoundFor({ kind: 'sell', usd: -0.2, pct: -4 }), 'sell-lose');
  assert.equal(tradeSoundFor({ kind: 'stop', usd: -0.5, pct: -12 }), 'sell-lose');
  assert.equal(tradeSoundFor({ kind: 'stop', usd: 0.1, pct: 2 }), 'sell-win');
  assert.equal(tradeSoundFor({ kind: 'reject' }), null);
  assert.equal(tradeSoundFor({ kind: 'info' }), null);
  assert.equal(tradeSoundFor(null), null);
});

test('sound preference defaults on and can be toggled off', () => {
  const prev = globalThis.localStorage;
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  };
  try {
    delete store[SOUND_PREF_KEY];
    setSoundEnabled(true);
    assert.equal(soundEnabled(), true);
    assert.equal(store[SOUND_PREF_KEY], '1');
    setSoundEnabled(false);
    assert.equal(soundEnabled(), false);
    assert.equal(store[SOUND_PREF_KEY], '0');
    setSoundEnabled(true);
    assert.equal(soundEnabled(), true);
  } finally {
    (globalThis as any).localStorage = prev;
  }
});
