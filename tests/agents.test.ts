import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, liveGate, sanitize, migrateStockDefaults, LIVE_CONFIRM_PHRASE } from '../server/config.ts';

test('defaults are the momentum-scalp set', () => {
  assert.equal(DEFAULTS.takeProfitPct, 2);
  assert.equal(DEFAULTS.positionPct, 8);
  assert.equal(DEFAULTS.hardStopPct, 6);
  assert.equal(DEFAULTS.trailingStopPct, 7);
  assert.equal(DEFAULTS.maxHoldMin, 8);
  assert.equal(DEFAULTS.scanIntervalSec, 2);
  assert.equal(DEFAULTS.minScore, 50);
  assert.equal(sanitize({ takeProfitPct: 5 }).takeProfitPct, 5);

  const migrated = migrateStockDefaults({ minScore: 48, positionPct: 8, takeProfitPct: 3, scanIntervalSec: 6, hardStopPct: 35, trailingStopPct: 60, maxHoldMin: 0 });
  assert.equal(migrated.minScore, 50);
  assert.equal(migrated.positionPct, 8);
  assert.equal(migrated.takeProfitPct, 2);
  assert.equal(migrated.scanIntervalSec, 2);
  assert.equal(migrated.hardStopPct, 6);
  assert.equal(migrated.trailingStopPct, 7);
  assert.equal(migrated.maxHoldMin, 8);

  const custom = migrateStockDefaults({ minScore: 52, positionPct: 6, takeProfitPct: 4, scanIntervalSec: 4, hardStopPct: 9, trailingStopPct: 12 });
  assert.equal(custom.minScore, 52);
  assert.equal(custom.positionPct, 6);
  assert.equal(custom.takeProfitPct, 4);
  assert.equal(custom.scanIntervalSec, 4);

  assert.equal(sanitize({ takeProfitPct: -1 }).takeProfitPct, 0.5);
  assert.equal(sanitize({ takeProfitPct: 99 }).takeProfitPct, 50);
  assert.equal(sanitize({ positionPct: 50 }).positionPct, 25);
});

test('liveGate requires confirm phrase', () => {
  assert.equal(liveGate({ ...DEFAULTS, mode: 'paper' }).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live-auto', liveConfirm: '' }).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live-auto', liveConfirm: LIVE_CONFIRM_PHRASE }).live, true);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live-auto', liveConfirm: LIVE_CONFIRM_PHRASE }).auto, true);
});
