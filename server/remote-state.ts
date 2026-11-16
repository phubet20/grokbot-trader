// Persist paper learning, trades, and book to a private GitHub repo so
// Render's ephemeral disk can be rebuilt without wiping the equity curve.
// Auth is STATE_GITHUB_TOKEN (env only — never commit or log the value).
import { Store, exportSnapshot, importSnapshot, type PaperSnapshot } from './store.ts';

const DEFAULT_REPO = 'phubet20/grokbot-trader-state';
const DEFAULT_PATH = 'paper-state.json';

function token(): string {
  return (process.env.STATE_GITHUB_TOKEN || '').trim();
}
function repo(): string {
  return (process.env.STATE_GITHUB_REPO || DEFAULT_REPO).trim();
}
function path(): string {
  return (process.env.STATE_GITHUB_PATH || DEFAULT_PATH).trim();
}

export function remoteStateConfigured(): boolean {
  return !!token() && !!repo();
}

let cachedSha: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let hooked = false;
let lastPush = 0;
let lastRestore = 0;
let lastError = '';

async function gh(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const t = token();
  if (!t) return { ok: false, status: 0, json: null };
  const r = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${t}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'grokbot-trader',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { ok: r.ok, status: r.status, json };
}

export async function hydrateStore(store: Store): Promise<boolean> {
  if (!remoteStateConfigured()) return false;
  try {
    const url = `https://api.github.com/repos/${repo()}/contents/${path()}`;
    const r = await gh('GET', url);
    if (!r.ok || !r.json?.content) {
      if (r.status !== 404) { lastError = `load ${r.status}`; console.log(`[remote-state] load failed (${r.status})`); }
      return false;
    }
    cachedSha = r.json.sha;
    const raw = Buffer.from(String(r.json.content).replace(/\n/g, ''), 'base64').toString('utf8');
    const snap = JSON.parse(raw) as PaperSnapshot;
    if (!snap?.savedAt) return false;
    const ok = importSnapshot(store, snap);
    if (ok) {
      lastRestore = snap.savedAt;
      lastError = '';
      console.log(`[remote-state] restored paper state from GitHub (${new Date(snap.savedAt).toISOString()})`);
    }
    return ok;
  } catch (e: any) {
    console.log(`[remote-state] load error: ${e?.message || e}`);
    return false;
  }
}

export async function pushStore(store: Store): Promise<boolean> {
  if (!remoteStateConfigured()) return false;
  try {
    const snap = exportSnapshot(store);
    const content = Buffer.from(JSON.stringify(snap), 'utf8').toString('base64');
    const url = `https://api.github.com/repos/${repo()}/contents/${path()}`;
    if (!cachedSha) {
      const cur = await gh('GET', url);
      if (cur.ok) cachedSha = cur.json?.sha;
    }
    const r = await gh('PUT', url, {
      message: `paper state ${new Date(snap.savedAt).toISOString()}`,
      content,
      sha: cachedSha,
    });
    if (r.status === 409 || (r.status === 422 && cachedSha)) {
      const cur = await gh('GET', url);
      if (cur.ok) cachedSha = cur.json?.sha;
      const retry = await gh('PUT', url, {
        message: `paper state ${new Date(snap.savedAt).toISOString()}`,
        content,
        sha: cachedSha,
      });
      if (!retry.ok) { console.log(`[remote-state] save failed (${retry.status})`); return false; }
      cachedSha = retry.json?.content?.sha || cachedSha;
      lastPush = Date.now();
      return true;
    }
    if (!r.ok) { console.log(`[remote-state] save failed (${r.status})`); return false; }
    cachedSha = r.json?.content?.sha || cachedSha;
    lastPush = Date.now();
    return true;
  } catch (e: any) {
    console.log(`[remote-state] save error: ${e?.message || e}`);
    return false;
  }
}

export function schedulePush(store: Store, delayMs = 8000) {
  if (!remoteStateConfigured()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void pushStore(store); }, delayMs);
}

export async function flushRemote(store: Store) {
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (!remoteStateConfigured()) return;
  if (Date.now() - lastPush < 1500) return;
  await pushStore(store);
}

export function remoteStateStatus() {
  return {
    configured: remoteStateConfigured(),
    repo: remoteStateConfigured() ? repo() : '',
    lastPush,
    lastRestore,
    lastError,
  };
}

export function attachRemoteSync(store: Store) {
  if (hooked || !remoteStateConfigured()) return;
  hooked = true;
  const set = store.set.bind(store);
  const addTrade = store.addTrade.bind(store);
  const addEquity = store.addEquity.bind(store);
  const reset = store.reset.bind(store);
  const clearPaperSession = store.clearPaperSession.bind(store);
  store.set = (k, v) => { set(k, v); schedulePush(store); };
  store.addTrade = (t) => { addTrade(t); schedulePush(store, 2000); };
  store.addEquity = (ts, usd) => { addEquity(ts, usd); schedulePush(store); };
  store.reset = () => { reset(); schedulePush(store, 500); };
  store.clearPaperSession = () => { clearPaperSession(); schedulePush(store, 500); };
}
