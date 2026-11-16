import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryReason, exitReason, STRAT_DEFAULTS, type TapeSnap, type StratParams } from '../server/strategy.ts';

function snap(over: Partial<TapeSnap> & { t: number; px: number }): TapeSnap {
  return {
    liq: 40_000, mc: 80_000, m5: 4, m15: 8, h1: 12, vol5: 5000, vol1h: 12000,
    b5: 20, s5: 10, b1: 80, s1: 40, tr: 80, age: over.t - 30 * 60_000, ...over,
  };
}

const STRICT: StratParams = {
  ...STRAT_DEFAULTS,
  minHistTicks: 4, minImpulsePct: 3.5, pullbackMinPct: 1.2, pullbackMaxPct: 7,
  holdFloorPct: 9, maxTickVolPct: 8, maxH1: 45, maxM5: 10,
};

test('fast default entry can fire on the first qualifying snapshot', () => {
  const t0 = 1_000_000;
  const r = entryReason([snap({ t: t0, px: 100 })], STRAT_DEFAULTS, t0);
  assert.equal(r.ok, true, r.reason);
});

test('fast entry still rejects honeypot-ratio and blow-off pumps', () => {
  const t0 = 1_000_000;
  const honey = snap({ t: t0, px: 100, b5: 40, s5: 1, m5: 8 });
  assert.equal(entryReason([honey], STRAT_DEFAULTS, t0).ok, false);
  const blown = snap({ t: t0, px: 100, m5: 80, h1: 120 });
  assert.equal(entryReason([blown], STRAT_DEFAULTS, t0).ok, false);
});

test('optional strict preset still requires impulse + pullback and rejects a chase', () => {
  const t0 = 1_000_000;
  const hist: TapeSnap[] = [
    snap({ t: t0, px: 100 }),
    snap({ t: t0 + 8000, px: 104 }),
    snap({ t: t0 + 16000, px: 106 }),
    snap({ t: t0 + 24000, px: 103, m5: 3, m15: 8 }),
  ];
  const ok = entryReason(hist, STRICT, t0 + 24000);
  assert.equal(ok.ok, true, ok.reason);
  const chase: TapeSnap[] = hist.slice(0, 3);
  chase[2] = snap({ t: t0 + 16000, px: 106, m5: 20, h1: 80 });
  assert.equal(entryReason(chase, STRICT, t0 + 16000).ok, false);
});

test('strict preset rejects high-vol candles and already-pumped coins', () => {
  const t0 = 2_000_000;
  const hist: TapeSnap[] = [
    snap({ t: t0, px: 100 }),
    snap({ t: t0 + 8000, px: 120 }),
    snap({ t: t0 + 16000, px: 118 }),
    snap({ t: t0 + 24000, px: 116, h1: 80 }),
  ];
  assert.equal(entryReason(hist, STRICT, t0 + 24000).ok, false);
});

test('partial take-profit then breakeven on the runner', () => {
  const p = { ...STRAT_DEFAULTS, takeProfitPct: 4.5, partialPct: 50, breakevenAtPct: 2, hardStopPct: 3.5 };
  const pos = { entryPrice: 100, peakPrice: 100, openedAt: 0, partialTaken: false, breakeven: false };
  const tp = exitReason(pos, 104.6, p, 1000);
  assert.equal(tp.partial, true);
  assert.equal(tp.kind, 'partial_tp');
  const after = { ...pos, peakPrice: 104.6, partialTaken: true, breakeven: true };
  const be = exitReason(after, 100.05, p, 5000);
  assert.equal(be.kind, 'breakeven');
  const hard = exitReason(after, 96, p, 6000);
  assert.equal(hard.kind, 'hard_stop');
});
