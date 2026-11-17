/** Resolve TEST vs LIVE across ephemeral disk, persisted Render env, and MODE. */
export type RuntimeMode = 'paper' | 'live' | 'live-auto';

export function pickRuntimeMode(v?: string | null): RuntimeMode | '' {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'paper' || s === 'test') return 'paper';
  if (s === 'live') return 'live';
  if (s === 'live-auto') return 'live-auto';
  return '';
}

/**
 * Prefer a saved (disk) mode, then RUNTIME_MODE (persisted after an explicit
 * user tap). Never auto-select live from the host MODE= env — that only arms
 * the capability (liveGate). With no user choice, stay on TEST.
 */
export function resolveRuntimeMode(opts: {
  armed: boolean;
  auto?: boolean;
  savedMode?: string | null;
  envRuntimeMode?: string | null;
  envMode?: string | null;
}): RuntimeMode {
  const chosen = pickRuntimeMode(opts.savedMode) || pickRuntimeMode(opts.envRuntimeMode);
  if (chosen) {
    if (chosen !== 'paper' && !opts.armed) return 'paper';
    return chosen;
  }
  return 'paper';
}

/** New live buys require the user's explicit LIVE tap (persisted armed flag), not just MODE= or AUTO_START. */
export function liveBuysAllowed(mode: RuntimeMode, entriesArmed: boolean, gateLive: boolean): boolean {
  return mode !== 'paper' && !!entriesArmed && !!gateLive;
}
