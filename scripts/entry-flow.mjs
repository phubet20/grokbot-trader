// Headless entry-flow check at 390x844. Usage:
//   node scripts/entry-flow.mjs <baseUrl>
// baseUrl must already include any access-token path prefix and have no trailing slash.
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const OUT = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = async (name) => { await page.screenshot({ path: OUT + name + '.png' }); console.log('saved', name); };
const wait = (ms) => page.waitForTimeout(ms);

// Manifest must keep a relative start_url so a home-screen PWA stays under the token path.
const man = await (await page.request.get(BASE + '/manifest.webmanifest')).json();
if (man.start_url !== './' && man.start_url !== '.') {
  console.error('FAIL: manifest start_url is not relative:', man.start_url);
  await browser.close();
  process.exit(1);
}
if (man.scope !== './' && man.scope !== '.') {
  console.error('FAIL: manifest scope is not relative:', man.scope);
  await browser.close();
  process.exit(1);
}
console.log('manifest start_url/scope ok (relative)');

await page.goto(BASE + '/?theme=light', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.splash h1', { timeout: 20000 });
await wait(400);
await shot('entry-01-splash');

// Sheet must appear on its own — no extra tap.
await page.waitForSelector('[data-testid=connect-sheet]', { timeout: 20000 });
await page.waitForSelector('[data-testid=connect]', { timeout: 10000 });
await page.waitForSelector('text=/SOL/', { timeout: 20000 });
await wait(400);
await shot('entry-02-connect-sheet');

await page.click('[data-testid=connect]');
// Approving animation, if it is still on screen
try {
  await page.waitForSelector('text=Approving…', { timeout: 3000 });
  await wait(80);
  await shot('entry-03-approving');
} catch {
  console.log('approving state was brief; continuing');
}

await page.waitForSelector('text=Connected ✓', { timeout: 20000 });
await wait(150);
await shot('entry-04-connected');

await page.waitForSelector('[data-testid=start]', { timeout: 8000 });
await wait(200);
await shot('entry-05-start');

await page.click('[data-testid=start]');
await page.waitForSelector('[data-testid=setup]', { timeout: 8000 });
await wait(900);
await shot('entry-06-setup');

await page.waitForSelector('[data-testid=balance]', { timeout: 15000 });
await wait(600);
await shot('entry-07-dashboard');

// Fresh reopen (reload) must still show the connect sheet even if the server remembers the wallet.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.splash h1', { timeout: 20000 });
await page.waitForSelector('[data-testid=connect-sheet]', { timeout: 20000 });
await page.waitForSelector('text=/SOL/', { timeout: 20000 });
await wait(300);
await shot('entry-08-reopen-sheet');
console.log('reopen still shows connect sheet');

if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
else console.log('no page errors');
await browser.close();
console.log('entry flow ok');
