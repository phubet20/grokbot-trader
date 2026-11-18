// Builds the web UI on first start (or if sources are newer than the build).
// If strategy.ts is a barrel-only stub, restore full file from main and patch stable defaults.
import { existsSync, statSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const stratPath = join(root, 'server/strategy.ts');

function needsStrategyRestore() {
  if (!existsSync(stratPath)) return true;
  const t = readFileSync(stratPath, 'utf8');
  if (t.includes("export * from './strategy-part")) return true;
  if (!t.includes('export function liveExit')) return true;
  if (!t.includes('export function firstPullback')) return true;
  return false;
}

function patchStableDefaults(src) {
  let out = src;
  out = out.replace(/hardStopPct:\s*3([,\s])/, 'hardStopPct: 7$1');
  out = out.replace(/trailingStopPct:\s*5([,\s])/, 'trailingStopPct: 10$1');
  out = out.replace(/takeProfitPct:\s*3([,\s])/, 'takeProfitPct: 2.5$1');
  out = out.replace(/maxHoldMin:\s*12([,\s])/, 'maxHoldMin: 30$1');
  out = out.replace(/partialPct:\s*50([,\s])/, 'partialPct: 0$1');
  out = out.replace(/breakevenAtPct:\s*1\.8([,\s])/, 'breakevenAtPct: 1.5$1');
  out = out.replace(/minAgeMin:\s*3([,\s])/, 'minAgeMin: 1$1');
  out = out.replace(/minLiq:\s*12_000/, 'minLiq: 1_200');
  out = out.replace(/minMcap:\s*8_000/, 'minMcap: 2_000');
  out = out.replace(/maxMcap:\s*15_000_000/, 'maxMcap: 50_000_000');
  out = out.replace(/minBuyRatio5:\s*0\.55/, 'minBuyRatio5: 0.52');
  out = out.replace(/minTx5:\s*8([,\s])/, 'minTx5: 4$1');
  if (!out.includes('Risk numbers here must stay consistent')) {
    out = out.replace(
      '// Used by the engine and the tape backtester so research and production stay aligned.\n',
      '// Used by the engine and the tape backtester so research and production stay aligned.\n// Risk numbers here must stay consistent with server/config.ts DEFAULTS.\n'
    );
  }
  return out;
}

if (needsStrategyRestore()) {
  try {
    const url = 'https://raw.githubusercontent.com/phubet20/grokbot-trader/main/server/strategy.ts';
    let src = '';
    try {
      src = execSync(`curl -fsSL --max-time 30 '${url}'`, { encoding: 'utf8', maxBuffer: 5_000_000 });
    } catch {
      src = await (await fetch(url)).text();
    }
    if (src && src.includes('export function liveExit')) {
      writeFileSync(stratPath, patchStableDefaults(src));
      console.log('[strategy] restored from main and patched stable defaults (hard 7% / trail 10% / TP 2.5%)');
    } else {
      console.warn('[strategy] download did not look valid; left existing file');
    }
  } catch (e) {
    console.warn('[strategy] restore failed:', e?.message || e);
  }
}

// --- web build ---
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
let needs = !existsSync(dist);
if (!needs && existsSync(join(root, 'web/src'))) {
  try { needs = newest(join(root, 'web/src')) > statSync(dist).mtimeMs; } catch { needs = true; }
}
if (needs) {
  if (!existsSync(join(root, 'web/node_modules'))) execSync('npm install --no-audit --no-fund', { cwd: join(root, 'web'), stdio: 'inherit' });
  console.log('[build] building web UI...');
  execSync('npx vite build', { cwd: join(root, 'web'), stdio: 'inherit' });
}
