// Builds the web UI on first start (or if sources are newer than the build).
import { existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
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
