/** Splash and boot helpers. The splash never waits on the network. */

export const SPLASH_MS = 1500;
export const SNAP_CACHE_KEY = 'grokbot.snap.v2';

export function splashProgress(elapsedMs: number, durationMs = SPLASH_MS): number {
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

/** Splash finishes on time or on tap — never waits for a server 'ready' flag. */
export function splashShouldFinish(elapsedMs: number, tapped: boolean, durationMs = SPLASH_MS): boolean {
  return tapped || elapsedMs >= durationMs;
}

export function loadSnapCache(): any | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SNAP_CACHE_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    return snap && typeof snap === 'object' ? snap : null;
  } catch { return null; }
}

export function saveSnapCache(snap: any) {
  try {
    if (typeof localStorage === 'undefined' || !snap || typeof snap !== 'object') return;
    const slim = {
      appName: snap.appName,
      mode: snap.mode,
      modeReason: snap.modeReason,
      wallet: snap.wallet,
      stats: snap.stats,
      positions: snap.positions,
      agents: snap.agents,
      activity: (snap.activity || []).slice(0, 20),
      decisions: (snap.decisions || []).slice(0, 10),
      ticker: snap.ticker,
      config: snap.config,
      autotune: snap.autotune,
      botWallet: snap.botWallet,
      background: snap.background,
      scan: snap.scan,
      cachedAt: Date.now(),
    };
    localStorage.setItem(SNAP_CACHE_KEY, JSON.stringify(slim));
  } catch { /* quota / private mode */ }
}

export function nextBackoffMs(prevMs: number): number {
  const n = prevMs <= 0 ? 1000 : Math.min(15_000, Math.round(prevMs * 1.8));
  return n;
}

export function placeholderSnap(cached?: any): any {
  const base = cached && typeof cached === 'object' ? cached : {};
  return {
    appName: 'Grok Bot',
    mode: 'paper',
    modeReason: '',
    dataSource: 'live',
    wallet: { connected: false, type: 'paper', address: '', realSol: null, solBalance: 0, depositUsd: 0, startedAt: 0, running: false, dayKey: '', dayStartEquity: 0 },
    stats: { equity: 0, deposit: 0, pnlUsd: 0, pnlPct: 0, multiplier: 1, trades: 0, closed: 0, wins: 0, losses: 0, winRate: 0, cashUsd: 0, solBalance: 0, solPrice: 0, runtimeMin: 0 },
    positions: [],
    agents: {
      scanner: { status: 'Idle', label: '', calls: 0, inFlightChecks: 0 },
      safety: { status: 'Idle', label: '', calls: 0, passed: 0, penalties: 0 },
      analyst: { status: 'Idle', label: '', calls: 0 },
      risk: { status: 'Idle', label: '', exits: 0 },
      executor: { status: 'Idle', label: '', fills: 0, last: '' },
    },
    activity: [],
    decisions: [],
    ticker: [],
    calls: {},
    apiErrors: 0,
    config: {},
    pending: [],
    autotune: null,
    botWallet: null,
    background: {},
    scan: {},
    ...base,
  };
}

export function healthzUrl(origin = typeof location !== 'undefined' ? location.origin : ''): string {
  return (origin || '').replace(/\/$/, '') + '/healthz';
}
