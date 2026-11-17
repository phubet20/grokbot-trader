// Buy/sell alerts synthesized with the Web Audio API (no bundled copyrighted assets).
// iOS Safari only starts audio after a user gesture — we unlock on the first tap.

export const SOUND_PREF_KEY = 'grokbot.sound.on';

type SellTone = 'win' | 'lose';
export type TradeSound = 'buy' | 'sell-win' | 'sell-lose';

let ctx: AudioContext | null = null;
let unlocked = false;
let enabled = true;
let unlockBound = false;

function readPref(): boolean {
  try {
    const v = localStorage.getItem(SOUND_PREF_KEY);
    if (v === '0' || v === 'false' || v === 'off') return false;
    return true; // default on
  } catch {
    return true;
  }
}

enabled = typeof localStorage !== 'undefined' ? readPref() : true;

function Ctor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null;
}

function getCtx(): AudioContext | null {
  const AC = Ctor();
  if (!AC) return null;
  if (!ctx || ctx.state === 'closed') ctx = new AC();
  return ctx;
}

/** Silent buffer + resume — required on iOS Safari before any audible note. */
export async function unlockAudio(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  try {
    if (c.state === 'suspended') await c.resume();
    const buf = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
    unlocked = c.state === 'running';
  } catch {
    unlocked = false;
  }
  return unlocked;
}

export function installSoundUnlock(): void {
  if (unlockBound || typeof window === 'undefined') return;
  unlockBound = true;
  const once = () => { void unlockAudio(); };
  for (const ev of ['pointerdown', 'touchstart', 'click', 'keydown'] as const) {
    window.addEventListener(ev, once, { capture: true, passive: true });
  }
}

export function soundEnabled(): boolean { return enabled; }

export function setSoundEnabled(on: boolean): void {
  enabled = !!on;
  try { localStorage.setItem(SOUND_PREF_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
  if (enabled) void unlockAudio();
}

/** Map an activity row (current mode's book) to a sound, or null if it isn't a fill. */
export function tradeSoundFor(act: { kind?: string; usd?: number; pct?: number } | null | undefined): TradeSound | null {
  if (!act?.kind) return null;
  if (act.kind === 'buy') return 'buy';
  if (act.kind === 'sell' || act.kind === 'stop') {
    const pnl = Number.isFinite(act.usd) ? Number(act.usd) : Number(act.pct);
    return pnl < 0 ? 'sell-lose' : 'sell-win';
  }
  return null;
}

function env(c: AudioContext, start: number, peak: number, dur: number, gain = 0.12): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * gain), start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  return g;
}

function osc(c: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, gain: number, dest: AudioNode, freqEnd?: number): void {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (freqEnd && freqEnd !== freq) o.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
  const g = env(c, start, 1, dur, gain);
  o.connect(g);
  g.connect(dest);
  o.start(start);
  o.stop(start + dur + 0.02);
}

function noiseBurst(c: AudioContext, start: number, dur: number, gain: number, dest: AudioNode): void {
  const n = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 1800;
  const g = env(c, start, 1, dur, gain);
  src.connect(filter);
  filter.connect(g);
  g.connect(dest);
  src.start(start);
  src.stop(start + dur + 0.02);
}

/** Short two-tone terminal ping, like a trading desk blip. */
function synthBuy(c: AudioContext): void {
  const t = c.currentTime + 0.01;
  const master = c.createGain();
  master.gain.value = 0.9;
  master.connect(c.destination);
  osc(c, 1320, t, 0.055, 'sine', 0.11, master);
  osc(c, 1980, t + 0.055, 0.08, 'triangle', 0.09, master);
  osc(c, 2640, t + 0.055, 0.05, 'sine', 0.035, master);
}

/** Cash-register ka-ching. Losing sells use a lower, duller pair of bells. */
function synthSell(c: AudioContext, tone: SellTone): void {
  const t = c.currentTime + 0.01;
  const master = c.createGain();
  master.gain.value = 0.95;
  master.connect(c.destination);
  const hi = tone === 'win' ? 2093 : 784;
  const mid = tone === 'win' ? 2637 : 932;
  // Metallic bell partials
  for (const [mult, g] of [[1, 0.14], [2.01, 0.045], [2.76, 0.03], [4.07, 0.016]] as const) {
    osc(c, hi * mult, t, 0.22, 'sine', g, master);
  }
  for (const [mult, g] of [[1, 0.11], [2.0, 0.035], [3.01, 0.02]] as const) {
    osc(c, mid * mult, t + 0.07, 0.28, 'sine', g, master);
  }
  // Drawer clink
  noiseBurst(c, t + 0.02, 0.05, tone === 'win' ? 0.045 : 0.03, master);
}

async function play(kind: TradeSound): Promise<void> {
  if (!enabled) return;
  await unlockAudio();
  const c = getCtx();
  if (!c || c.state !== 'running') return;
  try {
    if (kind === 'buy') synthBuy(c);
    else synthSell(c, kind === 'sell-lose' ? 'lose' : 'win');
  } catch { /* autoplay or closed context — ignore */ }
}

export function playTradeSound(act: { kind?: string; usd?: number; pct?: number } | null | undefined): void {
  const kind = tradeSoundFor(act);
  if (!kind) return;
  void play(kind);
}

if (typeof window !== 'undefined') installSoundUnlock();
