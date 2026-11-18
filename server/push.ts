// Web Push (VAPID). Private key is read from env or a gitignored file; never logged or served.
// Default policy: only profitable SELL pushes (engine gates buys off). Keeps phone quiet.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';
import type { Store } from './store.ts';

const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof import('web-push');

const PUB_FILE = join(ROOT, 'VAPID_PUBLIC_KEY.txt');
const PRIV_FILE = join(ROOT, 'VAPID_PRIVATE_KEY.txt');

function readSecret(envName: string, file: string): string {
  return (process.env[envName] || (existsSync(file) ? readFileSync(file, 'utf8') : '')).trim();
}

export type PushSub = { endpoint: string; keys?: { p256dh?: string; auth?: string }; expirationTime?: number | null };

let storeRef: Store | null = null;
let configured = false;
let lastPushAt = 0;
const MIN_PUSH_GAP_MS = 1500;

export function vapidPublicKey(): string {
  return readSecret('VAPID_PUBLIC_KEY', PUB_FILE);
}

function vapidPrivateKey(): string {
  return readSecret('VAPID_PRIVATE_KEY', PRIV_FILE);
}

export function pushEnabled(): boolean {
  return !!(vapidPublicKey() && vapidPrivateKey());
}

export function initPush(store: Store) {
  storeRef = store;
  const pub = vapidPublicKey();
  const priv = vapidPrivateKey();
  if (!pub || !priv) {
    configured = false;
    console.log('  web push: disabled (no VAPID keys)');
    return;
  }
  const subject = (process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'mailto:webpush@localhost').trim();
  try {
    webpush.setVapidDetails(subject.startsWith('http') || subject.startsWith('mailto:') ? subject : `mailto:${subject}`, pub, priv);
    configured = true;
    console.log('  web push: enabled (profit sells only)');
  } catch (e: any) {
    configured = false;
    console.log('  web push: failed to configure:', e?.message || e);
  }
}

function loadSubs(): PushSub[] {
  return storeRef?.get<PushSub[]>('pushSubs', []) || [];
}
function saveSubs(subs: PushSub[]) {
  storeRef?.set('pushSubs', subs.slice(0, 20));
}

export function subscriberCount(): number {
  return loadSubs().length;
}

export function addSubscription(sub: PushSub) {
  if (!sub?.endpoint || !/^https?:\/\//.test(sub.endpoint)) throw new Error('invalid push subscription');
  if (!sub.keys?.p256dh || !sub.keys?.auth) throw new Error('push subscription missing keys');
  const next = loadSubs().filter((s) => s.endpoint !== sub.endpoint);
  next.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime ?? null });
  saveSubs(next);
  return { ok: true, subscribers: next.length };
}

export function removeSubscription(endpoint: string) {
  const next = loadSubs().filter((s) => s.endpoint !== endpoint);
  saveSubs(next);
  return { ok: true, subscribers: next.length };
}

export type TradePush = {
  side: 'BUY' | 'SELL';
  symbol: string;
  sizeUsd: number;
  price: number;
  pnlPct?: number;
  pnlUsd?: number;
};

function formatUsd(n: number): string {
  const a = Math.abs(n);
  const d = a > 0 && a < 0.01 ? 4 : a < 1 ? 3 : 2;
  return `${n >= 0 ? '+' : '-'}$${a.toFixed(d)}`;
}

function formatBody(t: TradePush): { title: string; body: string } {
  if (t.side === 'SELL') {
    const pnlU = t.pnlUsd != null && Number.isFinite(t.pnlUsd) ? formatUsd(t.pnlUsd) : '';
    const pnlP = t.pnlPct != null && Number.isFinite(t.pnlPct) ? `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%` : '';
    const size = Number.isFinite(t.sizeUsd) ? `$${Math.abs(t.sizeUsd).toFixed(2)}` : '';
    return { title: `Profit · ${t.symbol}`, body: [pnlU, pnlP, size].filter(Boolean).join(' · ') };
  }
  const size = Number.isFinite(t.sizeUsd) ? `$${Math.abs(t.sizeUsd).toFixed(2)}` : '';
  return { title: `Buy · ${t.symbol}`, body: size };
}

export async function notifyTrade(t: TradePush): Promise<{ sent: number; status?: number; error?: string }> {
  if (!configured || !storeRef) return { sent: 0, error: 'push disabled' };
  if (t.side === 'SELL' && !(t.pnlUsd != null ? t.pnlUsd > 0 : (t.pnlPct != null && t.pnlPct > 0))) {
    return { sent: 0, error: 'skipped non-profit sell' };
  }
  const now = Date.now();
  if (now - lastPushAt < MIN_PUSH_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_PUSH_GAP_MS - (now - lastPushAt)));
  }
  lastPushAt = Date.now();
  const subs = loadSubs();
  if (!subs.length) return { sent: 0, error: 'no subscribers' };
  const { title, body } = formatBody(t);
  const payload = JSON.stringify({ title, body, side: t.side, symbol: t.symbol, url: './' });
  let sent = 0;
  let lastStatus: number | undefined;
  const keep: PushSub[] = [];
  for (const sub of subs) {
    try {
      const r = await webpush.sendNotification(sub as any, payload, { TTL: 3600, urgency: 'high' });
      lastStatus = r.statusCode;
      if (r.statusCode === 201 || r.statusCode === 200) sent++;
      keep.push(sub);
    } catch (e: any) {
      lastStatus = e?.statusCode;
      if (e?.statusCode === 404 || e?.statusCode === 410) continue;
      keep.push(sub);
      if (!sent) return { sent: 0, status: lastStatus, error: e?.message || 'push failed' };
    }
  }
  if (keep.length !== subs.length) saveSubs(keep);
  return { sent, status: lastStatus };
}

export async function sendTestPush(sub: PushSub, payload: unknown): Promise<{ statusCode: number }> {
  if (!configured) {
    const pub = vapidPublicKey();
    const priv = vapidPrivateKey();
    if (!pub || !priv) throw new Error('push disabled');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:webpush@localhost', pub, priv);
  }
  const r = await webpush.sendNotification(sub as any, JSON.stringify(payload), { TTL: 60 });
  return { statusCode: r.statusCode };
}

export { formatBody };
export const webpushLib = webpush;
