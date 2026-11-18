// Builds the web UI on first start (or if sources are newer than the build).
// Also restores strategy modules if missing (stable defaults payload).
import { existsSync, statSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;

// --- strategy restore (idempotent) ---
const part1Path = join(root, 'server/strategy-part1.ts');
const part2Path = join(root, 'server/strategy-part2.ts');
const stratPath = join(root, 'server/strategy.ts');
const payloadPath = join(root, 'scripts/strategy-payload.json');
if ((!existsSync(part1Path) || !existsSync(part2Path)) && existsSync(payloadPath)) {
  const { part1, part2 } = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const dec = (b64) => inflateSync(Buffer.from(b64, 'base64')).toString('utf8');
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(part1Path, dec(part1));
  writeFileSync(part2Path, dec(part2));
  writeFileSync(stratPath, `// Higher-selectivity entries and structured exits.\n// Risk numbers stay consistent with server/config.ts DEFAULTS.\nexport * from './strategy-part1.ts';\nexport * from './strategy-part2.ts';\n`);
  console.log('[strategy] restored modules with stable defaults (hard 7% / trail 10% / TP 2.5%)');
}

// --- web build ---
const dist = join(root, 'web/dist/index.html');
function newest(dir) {
  let t = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    t = Math.max(t, f.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}
const needs = !existsSync(dist) || newest(join(root, 'web/src')) > statSync(dist).mtimeMs;
if (needs) {
  if (!existsSync(join(root, 'web/node_modules'))) execSync('npm install --no-audit --no-fund', { cwd: join(root, 'web'), stdio: 'inherit' });
  console.log('[build] building web UI...');
  execSync('npx vite build', { cwd: join(root, 'web'), stdio: 'inherit' });
}
