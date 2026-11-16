// Web Push (VAPID). Private key is read from env or a gitignored file; never logged or served.
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
    console.log('  web push: enabled');
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

export type TradePush = { side: 'BUY' | 'SELL'; symbol: string; sizeUsd: number; price: number; pnlPct?: number };

function formatBody(t: TradePush): { title: string; body: string } {
  const size = Number.isFinite(t.sizeUsd) ? `$${Math.abs(t.sizeUsd).toFixed(2)}` : '';
  const price = Number.isFinite(t.price) ? ` @ ${t.price}` : '';
  if (t.side === 'SELL') {
    const pnl = t.pnlPct != null && Number.isFinite(t.pnlPct) ? `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%` : '';
    return { title: `Sold $${t.symbol}`, body: [size, price, pnl].filter(Boolean).join(' · ') };
  }
  return { title: `Bought $${t.symbol}`, body: [size, price].filter(Boolean).join(' · ') };
}

/** Send a buy/sell push to every saved subscription. Never throws. */
export async function notifyTrade(t: TradePush): Promise<{ sent: number; status?: number; error?: string }> {
  if (!configured || !storeRef) return { sent: 0, error: 'push disabled' };
  const subs = loadSubs();
  if (!subs.length) return { sent: 0, error: 'no subscribers' };
  const { title, body } = formatBody(t);
  const payload = JSON.stringify({ title, body, side: t.side, symbol: t.symbol, url: './' });
  let sent = 0;
  let lastStatus: number | undefined;
  const keep: PushSub[] = [];
  for (const sub of subs) {
    try {
      const r = await webpush.sendNotification(sub as any, payload, { TTL: 3600, urgency: t.side === 'SELL' ? 'high' : 'normal' });
      lastStatus = r.statusCode;
      if (r.statusCode === 201 || r.statusCode === 200) sent++;
      keep.push(sub);
    } catch (e: any) {
      lastStatus = e?.statusCode;
      if (e?.statusCode === 404 || e?.statusCode === 410) continue; // dropped
      keep.push(sub);
      if (!sent) return { sent: 0, status: lastStatus, error: e?.message || 'push failed' };
    }
  }
  if (keep.length !== subs.length) saveSubs(keep);
  return { sent, status: lastStatus };
}

/** Test helper: send one payload to an explicit subscription (used to verify 201). */
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
