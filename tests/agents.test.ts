import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate } from '../server/analyst.ts';
import { preCheck, securityCheck } from '../server/safety.ts';
import { DEFAULTS, liveGate, sanitize, migrateStockDefaults, LIVE_CONFIRM_PHRASE } from '../server/config.ts';
import type { Candidate } from '../server/types.ts';

const now = Date.now();
const base: Candidate = {
  mint: 'M', pool: 'P', symbol: 'TEST', name: 'Test', dex: 'raydium', priceUsd: 0.001, mcapUsd: 800_000, liquidityUsd: 120_000,
  createdAt: now - 3 * 3600_000, change: { m5: 4, m15: 8, h1: 20, h6: 30, h24: 50 }, volume: { m5: 20_000, h1: 150_000, h6: 400_000, h24: 900_000 },
  txns: { m5b: 60, m5s: 30, h1b: 600, h1s: 400, h24b: 5000, h24s: 4000 }, traders1h: 450, quoteSymbol: 'SOL', source: 't',
};

test('analyst: strong momentum scores high, dump scores low', () => {
  const hi = scoreCandidate(base).score;
  const lo = scoreCandidate({ ...base, change: { m5: -8, m15: -15, h1: -30, h6: -40, h24: -50 }, txns: { ...base.txns, m5b: 10, m5s: 60, h1b: 200, h1s: 600 } }).score;
  assert.ok(hi >= 70, 'hi=' + hi); assert.ok(lo <= 40, 'lo=' + lo);
  assert.ok(hi <= 100 && lo >= 0);
});
test('analyst: penalises blow-off tops', () => {
  const blow = scoreCandidate({ ...base, change: { ...base.change, m5: 80 } }).score;
  assert.ok(blow < scoreCandidate(base).score);
});
test('safety pre-check passes a healthy pool', () => {
  assert.deepEqual(preCheck(base, DEFAULTS, now).reasons, []);
});
test('safety pre-check never hard-rejects; thin/honeypot/quote become penalties', () => {
  const thin = preCheck({ ...base, liquidityUsd: 50, volume: { ...base.volume, m5: 0 } }, DEFAULTS, now);
  assert.equal(thin.ok, true);
  assert.ok(thin.adj < 0 && thin.reasons.some((r) => r.includes('thin')));
  assert.ok(preCheck({ ...base, createdAt: now - 10_000 }, DEFAULTS, now).ok);
  const hp = preCheck({ ...base, txns: { ...base.txns, h1b: 300, h1s: 0 } }, DEFAULTS, now);
  assert.equal(hp.ok, true);
  assert.ok(hp.reasons.some((r) => r.includes('honeypot')));
  assert.ok(hp.adj <= -20);
  const q = preCheck({ ...base, quoteSymbol: 'BONK' }, DEFAULTS, now);
  assert.equal(q.ok, true);
  assert.ok(q.adj < 0 && q.reasons.some((r) => r.includes('quote')));
});
test('safety security check: honeypot and mint/freeze are heavy penalties, never blocks; unknown is 0', () => {
  const s = { mintAuthority: null, freezeAuthority: null, holders: 1000, topHolderPct: 5, top10Pct: 25, dangerRisks: [], rugged: false, fetchedAt: now, available: true };
  assert.equal(securityCheck(s, DEFAULTS).ok, true);
  assert.equal(securityCheck(s, DEFAULTS).adj, 0);
  const mint = securityCheck({ ...s, mintAuthority: 'X' }, DEFAULTS);
  assert.equal(mint.ok, true); assert.ok(mint.adj <= -35);
  const freeze = securityCheck({ ...s, freezeAuthority: 'X' }, DEFAULTS);
  assert.equal(freeze.ok, true); assert.ok(freeze.adj <= -35);
  const rug = securityCheck({ ...s, rugged: true }, DEFAULTS);
  assert.equal(rug.ok, true); assert.ok(rug.adj <= -40);
  const hp = securityCheck({ ...s, dangerRisks: ['Honeypot risk'] }, DEFAULTS);
  assert.equal(hp.ok, true); assert.ok(hp.adj <= -35);
  assert.ok(securityCheck({ ...s, holders: 10 }, DEFAULTS).ok, 'low holders is not a hard fail');
  assert.ok(securityCheck({ ...s, topHolderPct: 40 }, DEFAULTS).ok, 'top holder % is not a hard fail');
  assert.equal(securityCheck(null, DEFAULTS).ok, true, 'API miss / unknown must not block entries');
  assert.equal(securityCheck(null, DEFAULTS).adj, 0);
  assert.ok(securityCheck({ ...s, available: false }, DEFAULTS).ok);
});
test('pump.fun bonding-curve security: missing RugCheck is 0, authorities are penalties not blocks', () => {
  const s = { mintAuthority: null, freezeAuthority: null, holders: 2, topHolderPct: 5, top10Pct: 25, dangerRisks: [], rugged: false, fetchedAt: now, available: true };
  assert.ok(securityCheck(null, DEFAULTS, { pumpCurve: true, devHoldPct: 4 }).ok, 'no report yet is not a reject on the curve');
  assert.equal(securityCheck(s, DEFAULTS, { pumpCurve: true, devHoldPct: 4 }).adj, 0);
  const mint = securityCheck({ ...s, mintAuthority: 'X' }, DEFAULTS, { pumpCurve: true });
  assert.equal(mint.ok, true); assert.ok(mint.adj <= -35);
  const freeze = securityCheck({ ...s, freezeAuthority: 'X' }, DEFAULTS, { pumpCurve: true });
  assert.equal(freeze.ok, true); assert.ok(freeze.adj <= -35);
  assert.ok(securityCheck(null, DEFAULTS, { pumpCurve: true, devHoldPct: 40 }).ok, 'dev hold alone is not a hard fail');
});
test('live mode needs mode=live AND the exact confirmation phrase', () => {
  assert.equal(liveGate(DEFAULTS).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live' }).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live', liveConfirm: 'yes' }).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live', liveConfirm: LIVE_CONFIRM_PHRASE }).live, true);
});
test('config sanitize + stable defaults (Nov 2026)', () => {
  assert.equal(sanitize({ startUsd: 3 }).startUsd, 3);
  assert.equal(sanitize({ startUsd: 1 }).startUsd, 2);
  assert.equal(sanitize({ mode: 'live-auto' as any }).mode, 'live-auto');
  assert.equal(sanitize({ mode: 'yolo' as any }).mode, 'paper');
  // Stable defaults
  assert.equal(DEFAULTS.takeProfitPct, 2.5);
  assert.equal(DEFAULTS.positionPct, 5);
  assert.equal(DEFAULTS.hardStopPct, 7);
  assert.equal(DEFAULTS.trailingStopPct, 10);
  assert.equal(DEFAULTS.maxHoldMin, 30);
  assert.equal(DEFAULTS.scanIntervalSec, 3);
  assert.equal(DEFAULTS.minScore, 42);
  assert.equal(sanitize({ takeProfitPct: 5 }).takeProfitPct, 5);
  // Migration forces old known-bad values to stable set
  const migrated = migrateStockDefaults({ minScore: 48, positionPct: 8, takeProfitPct: 3, scanIntervalSec: 6, hardStopPct: 35, trailingStopPct: 60, maxHoldMin: 0 });
  assert.equal(migrated.minScore, 42);
  assert.equal(migrated.positionPct, 5);
  assert.equal(migrated.takeProfitPct, 2.5);
  assert.equal(migrated.scanIntervalSec, 3);
  assert.equal(migrated.hardStopPct, 7);
  assert.equal(migrated.trailingStopPct, 10);
  assert.equal(migrated.maxHoldMin, 30);
  // Custom user values are preserved
  const custom = migrateStockDefaults({ minScore: 52, positionPct: 6, takeProfitPct: 4, scanIntervalSec: 4, hardStopPct: 9, trailingStopPct: 12 });
  assert.equal(custom.minScore, 52);
  assert.equal(custom.positionPct, 6);
  assert.equal(custom.takeProfitPct, 4);
  assert.equal(custom.scanIntervalSec, 4);
  assert.equal(custom.hardStopPct, 9);
  assert.equal(custom.trailingStopPct, 12);
  // Sanitize clamps
  assert.equal(sanitize({ takeProfitPct: -1 }).takeProfitPct, 0.5);
  assert.equal(sanitize({ takeProfitPct: 99 }).takeProfitPct, 50);
  assert.equal(sanitize({ hardStopPct: 1 }).hardStopPct, 3);
  assert.equal(sanitize({ hardStopPct: 50 }).hardStopPct, 25);
  assert.equal(sanitize({ positionPct: 50 }).positionPct, 25);
});
