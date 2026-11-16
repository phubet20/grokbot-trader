/** Render free instances sleep after ~15 min without inbound HTTP. Pinging the
 *  public /healthz may count as inbound traffic and keep the process awake.
 *  This is not officially guaranteed. The free plan also caps 750 instance-hours
 *  per month (~24/7 uses ~720–744 hours). Localhost pings do not prevent sleep. */
export const keepaliveState = {
  url: '',
  everyMs: 5 * 60_000,
  lastOkAt: 0,
  lastStatus: 0,
  lastError: '',
  startedAt: 0,
};

export function keepaliveSnapshot() {
  const host = (() => {
    try { return keepaliveState.url ? new URL(keepaliveState.url).host : ''; } catch { return ''; }
  })();
  return {
    enabled: !!keepaliveState.url,
    host,
    everyMin: keepaliveState.everyMs / 60_000,
    lastOkAt: keepaliveState.lastOkAt,
    lastStatus: keepaliveState.lastStatus,
    lastError: keepaliveState.lastError,
    officialGuarantee: false,
  };
}

export function startKeepalive() {
  const url = process.env.KEEPALIVE_URL || (process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/healthz' : '');
  if (!url) return;
  keepaliveState.url = url;
  keepaliveState.startedAt = Date.now();
  const tick = () => fetch(url, { method: 'GET', redirect: 'follow' })
    .then((r) => {
      keepaliveState.lastStatus = r.status;
      if (r.ok) { keepaliveState.lastOkAt = Date.now(); keepaliveState.lastError = ''; }
      else { keepaliveState.lastError = String(r.status); console.log('keepalive', r.status); }
    })
    .catch((e) => { keepaliveState.lastError = e?.message || String(e); console.log('keepalive fail', keepaliveState.lastError); });
  setTimeout(tick, 15_000);
  setInterval(tick, keepaliveState.everyMs);
  console.log('  keepalive -> public /healthz every 5 minutes (not officially guaranteed on the free plan)');
}
