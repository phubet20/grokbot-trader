// Persist a tiny allowlist of env vars to Render so they survive free-plan
// sleeps and redeploys (no disk). Only WITHDRAW_TO and AUTO_START may be written.
// Requires RENDER_API_KEY (a Render API key) and RENDER_SERVICE_ID.
// Never logs the API key or dumps other env values.
const ALLOW = new Set(['WITHDRAW_TO', 'AUTO_START']);

function apiKey(): string {
  return (process.env.RENDER_API_KEY || '').trim();
}
function serviceId(): string {
  return (process.env.RENDER_SERVICE_ID || 'srv-dbthejoae00c73dem4c0').trim();
}

export function canPersistRenderEnv(): boolean {
  return apiKey().length >= 16;
}

export async function persistRenderEnv(vars: Record<string, string>): Promise<{ ok: boolean; written: string[]; error?: string }> {
  const written: string[] = [];
  const entries = Object.entries(vars).filter(([k, v]) => ALLOW.has(k) && typeof v === 'string' && v.length > 0);
  if (!entries.length) return { ok: false, written, error: 'nothing to write' };
  if (!canPersistRenderEnv()) return { ok: false, written, error: 'RENDER_API_KEY not configured' };
  const sid = serviceId();
  if (!sid.startsWith('srv-')) return { ok: false, written, error: 'RENDER_SERVICE_ID missing' };
  try {
    const existing = await listEnv(sid);
    for (const [key, value] of entries) {
      const id = existing.get(key);
      if (id) await putEnv(sid, id, value);
      else await postEnv(sid, key, value);
      written.push(key);
    }
    return { ok: true, written };
  } catch (e: any) {
    return { ok: false, written, error: e?.message || String(e) };
  }
}

async function listEnv(sid: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const data = await render(`https://api.render.com/v1/services/${sid}/env-vars?limit=100`);
  const walk = (x: any) => {
    if (!x) return;
    if (Array.isArray(x)) { for (const i of x) walk(i); return; }
    if (typeof x === 'object') {
      const ev = x.envVar || x;
      if (ev.key && ev.id) out.set(String(ev.key), String(ev.id));
      for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v);
    }
  };
  walk(data);
  return out;
}

async function postEnv(sid: string, key: string, value: string) {
  await render(`https://api.render.com/v1/services/${sid}/env-vars`, {
    method: 'POST',
    body: JSON.stringify({ key, value }),
  });
}

async function putEnv(sid: string, id: string, value: string) {
  await render(`https://api.render.com/v1/services/${sid}/env-vars/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

async function render(url: string, init: RequestInit = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey()}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Render env API ${r.status}`);
  return text ? JSON.parse(text) : null;
}

export function autoStartEnabled(): boolean {
  const v = (process.env.AUTO_START || '').trim().toLowerCase();
  // Explicit off only. Unset defaults to on so a fresh boot/redeploy starts trading immediately.
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/** Force AUTO_START on in-process so health checks and later reads agree. */
export function ensureAutoStartEnv(): void {
  process.env.AUTO_START = '1';
}
