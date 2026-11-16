/** Render free instances sleep after ~15 min without inbound HTTP. Pinging the
 *  public /healthz may count as inbound traffic and keep the process awake.
 *  This is not officially guaranteed. The free plan also caps 750 instance-hours
 *  per month (~24/7 uses ~720–744 hours). Localhost pings do not prevent sleep. */
export const keepaliveState = {
  url: '',
  everyMs: 4 * 60_000,
  lastOkAt: 0,
  lastStatus: 0,
  lastError: '',
  startedAt: 0,
  fails: 0,
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
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    fetch(url, { method: 'GET', redirect: 'follow', cache: 'no-store' as RequestCache })
      .then((r) => {
        keepaliveState.lastStatus = r.status;
        if (r.ok) {
          keepaliveState.lastOkAt = Date.now();
          keepaliveState.lastError = '';
          keepaliveState.fails = 0;
        } else {
          keepaliveState.lastError = String(r.status);
          keepaliveState.fails++;
          console.log('keepalive', r.status);
          scheduleRetry();
        }
      })
      .catch((e) => {
        keepaliveState.lastError = e?.message || String(e);
        keepaliveState.fails++;
        console.log('keepalive fail', keepaliveState.lastError);
        scheduleRetry();
      });
  };
  const scheduleRetry = () => {
    if (retryTimer) return;
    const wait = Math.min(60_000, 15_000 * Math.max(1, keepaliveState.fails));
    retryTimer = setTimeout(() => { retryTimer = undefined; tick(); }, wait);
  };
  tick();
  setInterval(tick, keepaliveState.everyMs);
  console.log('  keepalive -> public /healthz every 4 minutes (not officially guaranteed on the free plan)');
}
