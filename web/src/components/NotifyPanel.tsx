import { useEffect, useState } from 'react';
import { api } from '../api';

function urlBase64ToUint8Array(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || !!(navigator as any).standalone;
}

export function NotifyPanel({ snap }: { snap: any }) {
  const [msg, setMsg] = useState('');
  const [on, setOn] = useState(false);
  const enabled = !!snap?.push?.enabled;
  const ios = typeof navigator !== 'undefined' && isIOS();
  const standalone = typeof window !== 'undefined' && isStandalone();

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setOn(!!sub);
    }).catch(() => {});
  }, []);

  async function enable() {
    setMsg('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        throw new Error('This browser does not support Web Push');
      }
      if (ios && !standalone) {
        throw new Error('On iPhone, add Grok Bot to the Home Screen first (Share → Add to Home Screen), then open it from the icon. Web Push needs iOS 16.4+ and an installed PWA.');
      }
      const info = await api('push/vapid');
      if (!info.enabled || !info.publicKey) throw new Error('Notifications are not configured on the server');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Permission was not granted');
      const reg = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' });
      await reg.update();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(info.publicKey) });
      }
      await api('push/subscribe', sub.toJSON());
      setOn(true);
      setMsg('Notifications on — you will get a push for every buy and sell, even if the app is closed.');
    } catch (e: any) { setMsg(e.message || String(e)); }
  }

  async function disable() {
    setMsg('');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api('push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      setOn(false);
      setMsg('Notifications off');
    } catch (e: any) { setMsg(e.message || String(e)); }
  }

  return (
    <div className="section card notify-box" data-testid="notify-panel">
      <div className="sec-hd"><b>Push notifications</b><span className="muted tiny">{on ? 'on' : enabled ? 'off' : 'not configured'}</span></div>
      <p className="tiny muted">Get a notification for every buy and every sell (token, size, price, and PnL % on sells). The bot keeps trading on the server when this page is closed.</p>
      {ios && !standalone && (
        <p className="note hint" data-testid="ios-homescreen-hint">On iPhone, Web Push only works after you add this app to the Home Screen (Safari Share → Add to Home Screen) on iOS 16.4 or later, then open it from that icon and tap Enable.</p>
      )}
      {ios && standalone && <p className="tiny muted">Installed PWA detected. You can enable notifications here.</p>}
      {!ios && <p className="tiny muted">Android / desktop: tap Enable, then allow notifications when the browser asks.</p>}
      <div className="btn-row">
        <button className="pill-btn small-btn" data-testid="enable-notifications" disabled={!enabled || on} onClick={enable}>Enable notifications</button>
        {on && <button className="pill-btn small-btn ghost" onClick={disable}>Turn off</button>}
      </div>
      {msg && <p className="tiny" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
