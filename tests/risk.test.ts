import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionSizeUsd, slotSizeUsd, usableSlots, entryBlocked, evaluateExit, activeStop, reserveSol, sizeMultiplier, consecutiveLosses, adaptFilters, momentumEntryOk, momentumFade, lowBalanceReason, ATA_RENT_SOL } from '../server/risk.ts';

const P = { positionPct: 8, minTradeUsd: 0.5, maxPositions: 4, hardStopPct: 8, trailingStopPct: 12, maxHoldMin: 120, dailyLossLimitPct: 15 };
const T0 = 1_000_000;

test('position size is % of portfolio', () => {
  assert.equal(positionSizeUsd(P, 81, 81, 0.5), 6.48);
  assert.equal(positionSizeUsd(P, 1000, 1000, 0.5), 80);
});
test('works with a $10 portfolio', () => {
  assert.equal(positionSizeUsd(P, 10, 10, 0.57), 0.8);
});
test('size capped by free cash minus reserve, 0 when below min trade', () => {
  assert.equal(positionSizeUsd(P, 100, 3, 0.5), 2.5);
  assert.equal(positionSizeUsd(P, 100, 0.8, 0.5), 0);
  assert.equal(positionSizeUsd(P, 0, 0, 0), 0);
});
test('entry gates', () => {
  const g = { openPositions: 0, dayStartEquityUsd: 100, equityUsd: 100, alreadyHolding: false, inCooldown: false };
  assert.equal(entryBlocked(P, g), null);
  assert.match(entryBlocked(P, { ...g, openPositions: 4 })!, /max 4/);
  assert.match(entryBlocked(P, { ...g, equityUsd: 85 })!, /daily loss/);
  assert.equal(entryBlocked(P, { ...g, equityUsd: 85.1 }), null);
  assert.match(entryBlocked(P, { ...g, alreadyHolding: true })!, /already/);
  assert.match(entryBlocked(P, { ...g, inCooldown: true })!, /cooldown/);
});
test('hard stop at -8% from entry', () => {
  const pos = { entryPrice: 1, peakPrice: 1, openedAt: T0 };
  assert.equal(evaluateExit(P, pos, 0.93, T0 + 1000).exit, false);
  const d = evaluateExit(P, pos, 0.92, T0 + 1000);
  assert.equal(d.exit, true); assert.equal(d.kind, 'hard_stop');
});
test('trailing stop 12% from peak once it is above the hard stop', () => {
  let pos = { entryPrice: 1, peakPrice: 1, openedAt: T0 };
  let d = evaluateExit(P, pos, 1.5, T0 + 1000);
  assert.equal(d.exit, false); assert.equal(d.peak, 1.5);
  pos = { ...pos, peakPrice: d.peak };
  assert.equal(evaluateExit(P, pos, 1.33, T0 + 2000).exit, false);  // -11.3% from top
  d = evaluateExit(P, pos, 1.32, T0 + 2000);                      // -12% from top
  assert.equal(d.exit, true); assert.equal(d.kind, 'trailing_stop');
  assert.match(d.reason, /\+32\.0%/);
});
test('small peak: hard stop stays the active level', () => {
  const pos = { entryPrice: 1, peakPrice: 1.03 };
  assert.equal(activeStop(P, pos).kind, 'hard');
  assert.equal(activeStop(P, { entryPrice: 1, peakPrice: 1.2 }).kind, 'trailing');
  assert.ok(Math.abs(activeStop(P, { entryPrice: 1, peakPrice: 1.2 }).level - 1.056) < 1e-9);
});
test('peak never decreases and new high resets trailing', () => {
  const pos = { entryPrice: 1, peakPrice: 2, openedAt: T0 };
  assert.equal(evaluateExit(P, pos, 1.9, T0).peak, 2);
  assert.equal(evaluateExit(P, pos, 2.5, T0).peak, 2.5);
});
test('time stop', () => {
  const pos = { entryPrice: 1, peakPrice: 1, openedAt: T0 };
  assert.equal(evaluateExit(P, pos, 1.01, T0 + 119 * 60_000).exit, false);
  assert.equal(evaluateExit(P, pos, 1.01, T0 + 120 * 60_000).kind, 'time_stop');
});
test('bad prices never trigger exits', () => {
  const pos = { entryPrice: 1, peakPrice: 1, openedAt: T0 };
  assert.equal(evaluateExit(P, pos, 0, T0).exit, false);
  assert.equal(evaluateExit(P, pos, NaN, T0).exit, false);
});

test('reserve is rent plus two (base+priority) fees, far below 0.008 SOL', () => {
  const r = reserveSol(0.0002);
  assert.ok(r > ATA_RENT_SOL);
  assert.ok(r < 0.003, 'reserve=' + r);
});
test('tiny $2 and $5 portfolios size up when 8% is below min trade', () => {
  const P2 = { ...P, minTradeUsd: 0.25 };
  const reserve = 0.35;
  const s2 = positionSizeUsd(P2, 2, 2, reserve);
  assert.ok(s2 >= 1.6 && s2 <= 1.65, 's2=' + s2); // spendable 1.65, 8% of $2 is $0.16 < 0.25
  const s5 = positionSizeUsd(P2, 5, 5, reserve);
  assert.equal(s5, 0.4); // 8% of $5
  const s10 = positionSizeUsd(P2, 10, 10, 0.57);
  assert.equal(s10, 0.8);
});
test('anti-martingale grows after wins and shrinks after losses, never martingales', () => {
  assert.equal(sizeMultiplier([]), 1);
  assert.ok(sizeMultiplier([1, 1, 1]) > 1 && sizeMultiplier([1, 1, 1]) <= 1.6);
  assert.ok(sizeMultiplier([-1, -1, -1]) < 1 && sizeMultiplier([-1, -1, -1]) >= 0.5);
  // a loss after wins must shrink, not add size
  const afterWin = sizeMultiplier([2]);
  const afterLoss = sizeMultiplier([2, -1]);
  assert.ok(afterLoss < afterWin);
});
test('consecutive loss cooldown and tighter filters (self-correction, not averaging down)', () => {
  assert.equal(consecutiveLosses([1, -1, -1]), 2);
  const a = adaptFilters({ minScore: 55, trailingStopPct: 6, hardStopPct: 5 }, [-1, -1]);
  assert.ok(a.minScore > 55);
  assert.equal(a.pauseMs, 0);
  assert.ok(a.trailingStopPct <= 6);
});
test('low balance message when cash cannot cover reserve + min trade', () => {
  assert.ok(lowBalanceReason(2, 0.1, 0.3, 0.25));
  assert.equal(lowBalanceReason(10, 10, 0.3, 0.25), null);
});
test('momentum entry requires buy pressure and acceleration; fade on ratio drop', () => {
  const c: any = { change: { m5: 5, m15: 8, h1: 12 }, volume: { m5: 8000, h1: 20000 }, txns: { m5b: 20, m5s: 8, h1b: 80, h1s: 50 }, liquidityUsd: 40000 };
  assert.equal(momentumEntryOk(c), true);
  assert.equal(momentumEntryOk({ ...c, change: { ...c.change, m5: 0.5 } }), false);
  const fade = momentumFade({ ...c, txns: { ...c.txns, m5b: 3, m5s: 12 } }, 1.2, 1.1);
  assert.equal(fade.exit, true);
});

test('even slot sizing: $81 gets 10 slots, $2 uses fewer so each trade stays viable', () => {
  const P2 = { ...P, minTradeUsd: 0.25, maxPositions: 10 };
  const n81 = usableSlots(P2, 81, 81, 0.35, 0);
  assert.equal(n81, 10);
  const s81 = slotSizeUsd(P2, 81, 81, 0.35, 0);
  assert.ok(s81 >= 7 && s81 <= 8.1, 's81=' + s81);
  const n2 = usableSlots(P2, 2, 2, 0.35, 0);
  assert.ok(n2 >= 1 && n2 <= 4, 'tiny book uses fewer slots, n2=' + n2);
  const s2 = slotSizeUsd(P2, 2, 2, 0.35, 0);
  assert.ok(s2 >= 0.25 && s2 <= 2, 's2=' + s2);
  // cannot overfill: once slots are used, no extra size
  const nFull = usableSlots(P2, 81, 8, 0.35, 10);
  assert.equal(nFull, 0);
});
