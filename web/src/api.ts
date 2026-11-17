import { useEffect, useRef, useState } from 'react';
import { loadSnapCache, saveSnapCache, nextBackoffMs, placeholderSnap, healthzUrl } from './boot';
import { playTradeSound } from './sounds';

export type Snap = any;
export async function api(path: string, body?: unknown, opts?: { timeoutMs?: number; retries?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const retries = opts?.retries ?? 0;
  let last: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch('api/' + path, body === undefined
        ? { signal: ctl.signal }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'request failed');
      return d;
    } catch (e: any) {
      last = e?.name === 'AbortError' ? new Error('request timed out') : (e instanceof Error ? e : new Error(String(e)));
    } finally {
      clearTimeout(t);
    }
  }
  throw last || new Error('request failed');
}

export type Toast = { id: number; kind: string; title: string; text?: string; usd?: number; pct?: number; symbol?: string; image?: string };

/** Live state over Server-Sent Events, with periodic full refresh. */
export function useLive() {
  const [snap, setSnap] = useState<Snap | null>(() => loadSnapCache());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [online, setOnline] = useState(true);
  const [waking, setWaking] = useState(false);
  const [live, setLive] = useState(false);
  const tid = useRef(1);
  const retry = useRef<() => void>(() => {});
  const lastRev = useRef(0);
  useEffect(() => {
    let es: EventSource | null = null;
    let stop = false;
    let backoff = 0;
    let esTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const apply = (d: Snap, opts?: { fromUser?: boolean }) => {
      if (!d || typeof d !== 'object') return;
      if (typeof d.rev === 'number') {
        if (!opts?.fromUser && d.rev < lastRev.current) return; // stale poll must not bounce LIVE back to TEST
        lastRev.current = d.rev;
      }
      setSnap(d);
      saveSnapCache(d);
      setOnline(true);
      setWaking(false);
      setLive(true);
      backoff = 0;
    };
    const onUserSnap = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      if (d) apply(d, { fromUser: true });
    };
    window.addEventListener('grokbot:snap', onUserSnap);
    const wakeServer = () => {
      const url = healthzUrl();
      if (!url) return;
      fetch(url, { cache: 'no-store' }).catch(() => {});
    };
    const pullState = () => {
      api('state', undefined, { timeoutMs: 6000, retries: 0 }).then(apply).catch(() => {
        setOnline(false);
        setWaking(true);
      });
    };
    const connectEs = () => {
      if (stop) return;
      es?.close();
      try { es = new EventSource('api/events'); }
      catch { schedule(); return; }
      es.onopen = () => { setOnline(true); setWaking(false); backoff = 0; };
      es.onerror = () => {
        setOnline(false);
        setWaking(true);
        es?.close();
        es = null;
        schedule();
      };
      const on = (t: string, f: (d: any) => void) => es!.addEventListener(t, (e: MessageEvent) => {
        try { f(JSON.parse(e.data)); } catch { /* ignore */ }
      });
      on('state', apply);
      on('agents', (d) => setSnap((s: Snap) => (s ? { ...s, agents: d } : s)));
      on('positions', (d) => setSnap((s: Snap) => (s ? { ...s, positions: d } : s)));
      on('activity', (d) => { playTradeSound(d); setSnap((s: Snap) => (s ? { ...s, activity: [d, ...(s.activity || [])].slice(0, 100) } : s)); });
      on('decision', (d) => setSnap((s: Snap) => (s ? { ...s, decisions: [d, ...(s.decisions || [])].slice(0, 60) } : s)));
      on('equity', (d) => setSnap((s: Snap) => (s ? { ...s, stats: { ...s.stats, equity: d.usd, pnlUsd: d.usd - s.stats.deposit, multiplier: s.stats.deposit ? d.usd / s.stats.deposit : 1, pnlPct: s.stats.deposit ? (d.usd / s.stats.deposit - 1) * 100 : 0 }, lastEquity: d } : s)));
      on('toast', (d) => { const id = tid.current++; setToasts((t) => [...t, { ...d, id }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), d.kind === 'profit' ? 5000 : 3200); });
      on('approval', (d) => setApprovals((a) => [...a, d]));
    };
    const schedule = () => {
      if (stop) return;
      backoff = nextBackoffMs(backoff);
      setWaking(true);
      esTimer = setTimeout(() => { wakeServer(); pullState(); connectEs(); }, backoff);
    };
    retry.current = () => { backoff = 0; wakeServer(); pullState(); connectEs(); };
    // Immediate wake + first fetch; do not block the UI on this.
    setWaking(!loadSnapCache());
    wakeServer();
    pullState();
    connectEs();
    pollTimer = setInterval(() => { if (stop) return; pullState(); wakeServer(); }, 4000);
    return () => { stop = true; es?.close(); if (esTimer) clearTimeout(esTimer); if (pollTimer) clearInterval(pollTimer); window.removeEventListener('grokbot:snap', onUserSnap); };
  }, []);
  return { snap, setSnap, toasts, setToasts, approvals, setApprovals, online, waking, live, retry: () => retry.current() };
}

export const usd = (x: number | undefined | null, d = 2) => x === undefined || x === null || !Number.isFinite(x) ? '—' : (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const sUsd = (x: number) => (x >= 0 ? '+' : '-') + '$' + Math.abs(x).toFixed(2);
export const pct = (x: number | undefined | null, d = 1) => x === undefined || x === null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
export const compact = (x: number | undefined | null) => {
  if (x === undefined || x === null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  return a >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : x.toFixed(0);
};
export const price = (p: number | undefined) => {
  if (!p || !Number.isFinite(p)) return '—';
  if (p >= 1) return '$' + p.toFixed(4);
  const dec = Math.min(12, Math.max(4, -Math.floor(Math.log10(p)) + 3));
  return '$' + p.toFixed(dec);
};
export const hm = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const hhmm = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const short = (a: string) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
export const age = (ts?: number) => {
  if (!ts) return '—';
  const m = (Date.now() - ts) / 60000;
  return m < 60 ? Math.round(m) + 'm old' : m < 1440 ? Math.round(m / 60) + 'h old' : Math.round(m / 1440) + 'd old';
};
