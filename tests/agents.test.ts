import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate } from '../server/analyst.ts';
import { preCheck, securityCheck } from '../server/safety.ts';
import { DEFAULTS, liveGate, sanitize, LIVE_CONFIRM_PHRASE } from '../server/config.ts';
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
test('safety pre-check rejects thin/young/honeypot pools', () => {
  assert.ok(!preCheck({ ...base, liquidityUsd: 50, volume: { ...base.volume, m5: 0 } }, DEFAULTS, now).ok);
  // Fresh launches are allowed through pre-check so the scanner can catch the first pump.
  assert.ok(preCheck({ ...base, createdAt: now - 10_000 }, DEFAULTS, now).ok);
  assert.ok(preCheck({ ...base, txns: { ...base.txns, h1b: 300, h1s: 0 } }, DEFAULTS, now).reasons.some((r) => r.includes('honeypot')));
  assert.ok(!preCheck({ ...base, quoteSymbol: 'BONK' }, DEFAULTS, now).ok);
});
test('safety security check: authorities, holders, missing data fail closed', () => {
  const s = { mintAuthority: null, freezeAuthority: null, holders: 1000, topHolderPct: 5, top10Pct: 25, dangerRisks: [], rugged: false, fetchedAt: now, available: true };
  assert.ok(securityCheck(s, DEFAULTS).ok);
  assert.ok(!securityCheck({ ...s, mintAuthority: 'X' }, DEFAULTS).ok);
  assert.ok(!securityCheck({ ...s, freezeAuthority: 'X' }, DEFAULTS).ok);
  assert.ok(!securityCheck({ ...s, holders: 10 }, DEFAULTS).ok);
  assert.ok(!securityCheck({ ...s, topHolderPct: 40 }, DEFAULTS).ok);
  assert.ok(!securityCheck(null, DEFAULTS).ok);
});
test('pump.fun bonding-curve security: missing RugCheck is ok, authorities and dev cap still reject', () => {
  const s = { mintAuthority: null, freezeAuthority: null, holders: 2, topHolderPct: 5, top10Pct: 25, dangerRisks: [], rugged: false, fetchedAt: now, available: true };
  assert.ok(securityCheck(null, DEFAULTS, { pumpCurve: true, devHoldPct: 4 }).ok, 'no report yet is not a reject on the curve');
  assert.ok(securityCheck(s, DEFAULTS, { pumpCurve: true, devHoldPct: 4 }).ok);
  assert.ok(!securityCheck({ ...s, mintAuthority: 'X' }, DEFAULTS, { pumpCurve: true }).ok);
  assert.ok(!securityCheck({ ...s, freezeAuthority: 'X' }, DEFAULTS, { pumpCurve: true }).ok);
  assert.ok(!securityCheck(null, DEFAULTS, { pumpCurve: true, devHoldPct: 40 }).ok);
});
test('live mode needs mode=live AND the exact confirmation phrase', () => {
  assert.equal(liveGate(DEFAULTS).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live' }).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live', liveConfirm: 'yes' }).live, false);
  assert.equal(liveGate({ ...DEFAULTS, mode: 'live', liveConfirm: LIVE_CONFIRM_PHRASE }).live, true);
});
test('config sanitize: min $2 start, live-auto kept, bogus mode -> paper', () => {
  assert.equal(sanitize({ startUsd: 3 }).startUsd, 3);
  assert.equal(sanitize({ startUsd: 1 }).startUsd, 2);
  assert.equal(sanitize({ mode: 'live-auto' as any }).mode, 'live-auto');
  assert.equal(sanitize({ mode: 'yolo' as any }).mode, 'paper');
});
