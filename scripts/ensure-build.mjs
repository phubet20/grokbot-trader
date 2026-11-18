// Builds the web UI on first start (or if sources are newer than the build).
// Restores strategy.ts / engine.ts if incomplete (e.g. truncated push).
import { existsSync, statSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const stratPath = join(root, 'server/strategy.ts');
const enginePath = join(root, 'server/engine.ts');
// Last known-good engine on fix/stability before accidental truncation.
const ENGINE_RAW = 'https://raw.githubusercontent.com/phubet20/grokbot-trader/4ee39b5db6745e5108336d8f29061a632353a665/server/engine.ts';

function needsStrategyRestore() {
  if (!existsSync(stratPath)) return true;
  const t = readFileSync(stratPath, 'utf8');
  if (t.includes("export * from './strategy-part")) return true;
  if (!t.includes('export function liveExit')) return true;
  if (!t.includes('export function firstPullback')) return true;
  return false;
}

function needsEngineRestore() {
  if (!existsSync(enginePath)) return true;
  const t = readFileSync(enginePath, 'utf8');
  if (t.length < 50_000) return true;
  if (!t.includes('Orchestrates the 5 agents')) return true;
  if (!t.includes('class Engine') && !t.includes('export class Engine')) return true;
  if (!t.includes('setRunning')) return true;
  return false;
}

function patchStableDefaults(src) {
  let out = src;
  // Momentum-scalp profile (matches server/config.ts DEFAULTS).
  out = out.replace(/hardStopPct:\s*\d+(\.\d+)?([,\s])/, 'hardStopPct: 6$2');
  out = out.replace(/trailingStopPct:\s*\d+(\.\d+)?([,\s])/, 'trailingStopPct: 7$2');
  out = out.replace(/takeProfitPct:\s*\d+(\.\d+)?([,\s])/, 'takeProfitPct: 2$2');
  out = out.replace(/maxHoldMin:\s*\d+([,\s])/, 'maxHoldMin: 8$1');
  out = out.replace(/partialPct:\s*50([,\s])/, 'partialPct: 0$1');
  out = out.replace(/breakevenAtPct:\s*1\.8([,\s])/, 'breakevenAtPct: 1.2$1');
  out = out.replace(/minAgeMin:\s*3([,\s])/, 'minAgeMin: 1$1');
  out = out.replace(/minLiq:\s*[\d_]+/, 'minLiq: 3_000');
  out = out.replace(/minMcap:\s*[\d_]+/, 'minMcap: 5_000');
  out = out.replace(/maxMcap:\s*[\d_]+/, 'maxMcap: 30_000_000');
  out = out.replace(/minBuyRatio5:\s*0\.\d+/, 'minBuyRatio5: 0.58');
  out = out.replace(/minTx5:\s*\d+([,\s])/, 'minTx5: 10$1');
  if (!out.includes('Risk numbers here must stay consistent')) {
    out = out.replace(
      '// Used by the engine and the tape backtester so research and production stay aligned.\n',
      '// Used by the engine and the tape backtester so research and production stay aligned.\n// Risk numbers here must stay consistent with server/config.ts DEFAULTS.\n'
    );
  }
  return out;
}

function patchEnginePause(src) {
  // If still using force-resume-on-pause, rewrite to respect explicit stop.
  if (src.includes('stays paused after restart until you change it')) return src;
  const old = `  setRunning(r: boolean) {
    this.wallet.running = r;
    this.saveWallet();
    this.log('Core', 'info', r ? 'Bot resumed' : 'Bot paused - no new trades (will auto-resume on restart or when the app reopens)');
    // Keep AUTO_START on so a restart, redeploy, or app reopen resumes immediately.
    ensureAutoStartEnv();
    void persistRenderEnv({ AUTO_START: '1' }).then((res) => {
      if (res.ok && r) this.log('Core', 'info', 'AUTO_START kept on so trading resumes after a restart');
    });
    this.emitState();
    if (r && this.wallet.connected) {
      this.lossPauseUntil = 0;
      this.store.setBook(this.book, 'lossPauseUntil', 0);
      void this.kickoffTrading('start');
    }
  }`;
  const neu = `  setRunning(r: boolean) {
    this.wallet.running = r;
    this.saveWallet();
    // Respect explicit pause: do not auto-resume until the user starts again.
    if (r) {
      this.log('Core', 'info', 'Bot resumed');
      ensureAutoStartEnv();
      void persistRenderEnv({ AUTO_START: '1' }).then((res) => {
        if (res.ok) this.log('Core', 'info', 'AUTO_START on \u2014 will resume after restart while left running');
      });
      this.lossPauseUntil = 0;
      this.store.setBook(this.book, 'lossPauseUntil', 0);
      if (this.wallet.connected) void this.kickoffTrading('start');
    } else {
      this.log('Core', 'info', 'Bot paused \u2014 no new trades until you start again (survives restart)');
      process.env.AUTO_START = '0';
      void persistRenderEnv({ AUTO_START: '0' }).then((res) => {
        if (res.ok) this.log('Core', 'info', 'AUTO_START off \u2014 stays paused after restart until you change it');
      });
    }
    this.emitState();
  }`;
  if (src.includes(old)) return src.replace(old, neu);
  return src;
}

async function restoreStrategy() {
  if (!needsStrategyRestore()) return;
  const url = 'https://raw.githubusercontent.com/phubet20/grokbot-trader/main/server/strategy.ts';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const src = await res.text();
  if (!src.includes('export function liveExit')) throw new Error('unexpected strategy content');
  writeFileSync(stratPath, patchStableDefaults(src));
  console.log('[strategy] restored from main and patched scalp defaults (hard 6% / trail 7% / TP 2% / hold 8m)');
}

async function restoreEngine() {
  if (!needsEngineRestore()) return;
  const res = await fetch(ENGINE_RAW, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error('engine HTTP ' + res.status);
  let src = await res.text();
  if (!src.includes('Orchestrates the 5 agents')) throw new Error('unexpected engine content');
  src = patchEnginePause(src);
  writeFileSync(enginePath, src);
  console.log('[engine] restored from known-good commit and pause behavior patched');
}

function buildWeb() {
  const dist = join(root, 'web/dist/index.html');
  function newest(dir) {
    if (!existsSync(dir)) return 0;
    let t = 0;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      t = Math.max(t, f.isDirectory() ? newest(p) : statSync(p).mtimeMs);
    }
    return t;
  }
  let needsBuild = !existsSync(dist);
  if (!needsBuild && existsSync(join(root, 'web/src'))) {
    try { needsBuild = newest(join(root, 'web/src')) > statSync(dist).mtimeMs; } catch { needsBuild = true; }
  }
  if (!needsBuild) return;
  if (!existsSync(join(root, 'web/package.json'))) {
    console.warn('[build] web/package.json missing; skip UI build');
    return;
  }
  if (!existsSync(join(root, 'web/node_modules'))) {
    execSync('npm install --no-audit --no-fund', { cwd: join(root, 'web'), stdio: 'inherit' });
  }
  console.log('[build] building web UI...');
  execSync('npx vite build', { cwd: join(root, 'web'), stdio: 'inherit' });
}

await restoreEngine().catch((e) => console.warn('[engine] restore failed:', e?.message || e));
await restoreStrategy().catch((e) => console.warn('[strategy] restore failed:', e?.message || e));
buildWeb();
