// HTTP API + Server-Sent Events + static web UI.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
import { config, updateConfig, liveGate, ROOT } from './config.ts';
import { redactSecrets, botPublicKey } from './wallet.ts';
import { LiveMarket } from './market.ts';
import { ReplayMarket } from './replay.ts';
import { Store } from './store.ts';
import { Engine } from './engine.ts';
import { initPush, vapidPublicKey, pushEnabled, addSubscription, removeSubscription, subscriberCount } from './push.ts';
import { startKeepalive, keepaliveSnapshot } from './keepalive.ts';
import { prepareDepositTx } from './deposit.ts';
import { hydrateStore, attachRemoteSync, flushRemote, remoteStateConfigured, remoteStateStatus } from './remote-state.ts';

const market = config.dataSource === 'replay' ? new ReplayMarket(Number(process.env.REPLAY_SPEED) || 6) : new LiveMarket();
const store = new Store();
let engine!: Engine;

async function bootEngine() {
  const restored = await hydrateStore(store);
  attachRemoteSync(store);
  const savedCfg = store.get<any>('config', null);
  if (savedCfg) updateConfig(savedCfg);
  engine = new Engine(config, market, store);
  for (const ev of ['state', 'agents', 'activity', 'decision', 'equity', 'positions', 'toast', 'approval']) {
    engine.on(ev, (d) => broadcast(ev, d));
  }
  if (restored) console.log('[boot] paper book restored from remote state');
  else if (remoteStateConfigured()) console.log('[boot] remote state configured, no snapshot yet');
  return engine;
}
const DIST = join(ROOT, 'web/dist');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// Optional access gate: if ACCESS_TOKEN (env) or ACCESS_TOKEN.txt exists, the whole app (UI + API)
// is only served under the secret path /<token>/ ; everything else returns 404.
const TOKEN_FILE = join(ROOT, 'ACCESS_TOKEN.txt');
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : '')).trim();
if (ACCESS_TOKEN && !/^[A-Za-z0-9_-]{16,}$/.test(ACCESS_TOKEN)) throw new Error('ACCESS_TOKEN must be >=16 chars of [A-Za-z0-9_-]');
function stripToken(path: string): string | null {
  if (!ACCESS_TOKEN) return path;
  const seg = path.split('/')[1] || '';
  const a = Buffer.from(seg), b = Buffer.from(ACCESS_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return path.slice(1 + seg.length) || '';
}

const clients = new Set<import('node:http').ServerResponse>();
function broadcast(type: string, data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}\n\n`;
  for (const c of clients) c.write(msg);
}
const booted = bootEngine();

async function body(req: import('node:http').IncomingMessage): Promise<any> {
  let s = '';
  for await (const ch of req) { s += ch; if (s.length > 1e6) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('ok'); return; }
  const inner = stripToken(url.pathname);
  if (inner === null) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
  if (inner === '') { res.writeHead(302, { location: url.pathname + '/' + url.search }); res.end(); return; }
  const p = inner;
  const json = (code: number, d: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(d)); };
  try {
    await booted;
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return;
    }
    if (p === '/api/state') { await engine.maybeReconcile(); return json(200, engine.snapshot()); }
    if (p === '/api/funds') return json(200, await engine.fundsView());
    if (p === '/api/health') return json(200, { ok: true, mode: engine.mode, dataSource: market.name, solPrice: engine.solPrice, calls: market.calls, errors: market.errors, lastError: market.lastError, running: engine.wallet.running, connected: engine.wallet.connected, keepalive: keepaliveSnapshot(), push: { enabled: pushEnabled(), subscribers: subscriberCount() }, scan: engine.scanStatus(), pump: (market as any).pumpStatus ? (market as any).pumpStatus() : undefined, autoStart: process.env.AUTO_START || '0', withdrawLocked: !!engine.lockedWithdrawTo() });
    if (p === '/api/equity') return json(200, engine.equitySeries(url.searchParams.get('range') || 'ALL'));
    if (p === '/api/recap') return json(200, { ...engine.stats(), repos: 3, agents: 5, since: engine.wallet.startedAt, mode: engine.mode, book: engine.book });
    if (p === '/api/trades') return json(200, store.trades(500, engine.book));
    if (p === '/api/activity') return json(200, store.activity(Number(url.searchParams.get('limit')) || 200, engine.book));
    if (p.startsWith('/api/token/')) return json(200, await engine.tokenDetail(decodeURIComponent(p.slice(11)), url.searchParams.get('tf') || '1m'));
    if (p === '/api/push/vapid') return json(200, { enabled: pushEnabled(), publicKey: vapidPublicKey() || '', subscribers: subscriberCount() });
    if (req.method === 'POST') {
      const b = await body(req);
      if (p === '/api/wallet/preview') return json(200, await engine.preview(b));
      if (p === '/api/wallet/connect') return json(200, await engine.connect(b));
      if (p === '/api/wallet/disconnect') { engine.disconnect(); return json(200, { ok: true }); }
      if (p === '/api/bot/run') { engine.setRunning(!!b.running); return json(200, { ok: true }); }
      if (p === '/api/bot/restart') { return json(200, engine.restartTrading()); }
      if (p === '/api/bot/reset') { return json(200, engine.resetBot()); }
      if (p === '/api/mode') {
        const raw = String(b.mode || '');
        const next = raw === 'paper' || raw === 'test' ? 'paper' : raw === 'live' ? 'live' : 'live-auto';
        return json(200, await engine.setRuntimeMode(next));
      }
      if (p === '/api/config') { updateConfig(b); engine.emitState(); return json(200, { ...config, liveConfirm: undefined }); }
      if (p === '/api/reset') { engine.reset(); return json(200, { ok: true }); }
      if (p === '/api/paper/reset') { engine.reset(); return json(200, { ok: true }); }
      if (p === '/api/live/signed') { if (!liveGate().live || liveGate().auto) return json(403, { error: 'live disabled' }); engine.liveSigned(String(b.id), String(b.signature)); return json(200, { ok: true }); }
      if (p === '/api/live/rejected') { engine.liveRejected(String(b.id)); return json(200, { ok: true }); }
      if (p === '/api/withdraw/lock') return json(200, engine.lockWithdraw(String(b.address || ''), String(b.message || ''), String(b.signature || '')));
      if (p === '/api/withdraw') return json(200, await engine.withdraw(b || {}));
      if (p === '/api/push/subscribe') return json(200, addSubscription(b));
      if (p === '/api/push/unsubscribe') return json(200, removeSubscription(String(b.endpoint || '')));
      if (p === '/api/position/close') {
        const r = await engine.manualClose(String(b.id || b.mint || ''));
        return json(r.ok ? 200 : 400, r);
      }
      if (p === '/api/position/close-all') {
        const r = await engine.closeAll();
        return json(200, r);
      }
      if (p === '/api/deposit/prepare') {
        const to = botPublicKey();
        if (!to) return json(400, { error: 'bot wallet is not configured' });
        const from = String(b.from || '');
        const built = await prepareDepositTx(config.rpcUrl, from, to, Number(b.sol));
        return json(200, built); // unsigned; never sent here
      }
    }
    if (p.startsWith('/api/')) return json(404, { error: 'not found' });
    // static
    let f = normalize(join(DIST, p === '/' ? 'index.html' : p));
    if (!f.startsWith(DIST)) return json(403, { error: 'forbidden' });
    try { if (!(await stat(f)).isFile()) throw 0; } catch { f = join(DIST, 'index.html'); }
    const nocache = f.endsWith('index.html') || f.endsWith('sw.js') || f.endsWith('manifest.webmanifest');
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': nocache ? 'no-cache' : 'public, max-age=86400' });
    res.end(await readFile(f));
  } catch (e: any) {
    json(400, { error: redactSecrets(e?.message || String(e)) });
  }
});

const host = process.env.HOST || (process.env.PORT || process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
if (process.env.RENDER && !ACCESS_TOKEN) { console.error('Refusing to start on Render without ACCESS_TOKEN env var.'); process.exit(1); }
if (host !== '127.0.0.1' && host !== 'localhost' && !ACCESS_TOKEN) console.warn('  WARNING: listening on a network interface without ACCESS_TOKEN - anyone on the network can use the app.');
server.listen(config.port, host, async () => {
  const g = liveGate();
  const auto = g.auto ? ' AUTO' : '';
  console.log(`\n  ${config.appName} · ${g.live ? 'LIVE' + auto : 'PAPER/TEST'} mode · data: ${market.name}`);
  console.log(`  ${g.reason}`);
  if (g.auto) console.log(`  bot wallet: ${botPublicKey() || '(not configured)'}`);
  console.log(`  open http://${host === '0.0.0.0' ? 'localhost' : host}:${config.port}/${ACCESS_TOKEN ? '<ACCESS_TOKEN>/' : ''}\n`);
  await booted;
  const rs = remoteStateStatus();
  if (rs.configured) console.log(`  remote paper state: on (${rs.repo || 'configured'})`);
  else console.log('  remote paper state: off (set STATE_GITHUB_TOKEN to persist across deploys)');
  initPush(store);
  if (typeof (market as any).start === 'function') (market as any).start();
  await engine.start();
  startKeepalive();
});
const shutdown = async () => {
  try { await flushRemote(store); } catch {}
  if (engine) engine.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

