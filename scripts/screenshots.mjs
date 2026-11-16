// Mobile screenshots (390x844) of every screen. Usage:
//   node scripts/screenshots.mjs [baseUrlConnected] [baseUrlFresh]
// baseUrlConnected: a running instance with a connected wallet (dashboard etc.)
// baseUrlFresh:     a running instance with NO wallet connected (splash/connect)
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
const A = process.argv[2] || 'http://127.0.0.1:8787';
const F = process.argv[3] || A;
const OUT = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (name) => { await page.screenshot({ path: OUT + name + '.png' }); console.log('saved', name); };
const wait = (ms) => page.waitForTimeout(ms);

// 1-3: splash + connect flow on the fresh instance
await page.goto(F + '/?theme=light'); await wait(1200); await shot('01-loading');
await page.waitForSelector('[data-testid=connect]', { timeout: 20000 }); await page.waitForSelector('text=/SOL$/', { timeout: 20000 }); await wait(600); await shot('02-connect-phantom');
await page.click('[data-testid=connect]'); await page.waitForSelector('text=Connected ✓', { timeout: 20000 }); await wait(150); await shot('03-connected');
await wait(1500);

// dashboard etc. on the connected instance
await page.goto(A + '/?skip=1&theme=light'); await page.waitForSelector('[data-testid=balance]'); await wait(2500); await shot('04-dashboard-light');
await page.evaluate(() => window.scrollTo(0, 900)); await wait(500); await shot('05-dashboard-light-scrolled');
await page.goto(A + '/?skip=1&theme=dark'); await page.waitForSelector('[data-testid=balance]'); await wait(2500); await shot('06-dashboard-dark');
await page.evaluate(() => window.scrollTo(0, 700)); await wait(500); await shot('07-dashboard-dark-agents-activity');
await page.goto(A + '/?skip=1&theme=dark&tab=agents'); await wait(2000); await shot('08-agents-tab');
await page.goto(A + '/?skip=1&theme=dark&tab=activity'); await wait(2000); await shot('09-activity-tab');
await page.goto(A + '/?skip=1&theme=light&tab=account'); await wait(2000); await shot('10-account-settings');
// token detail: prefer an open position, else last traded token
const st = await (await fetch(A + '/api/state')).json();
const trades = await (await fetch(A + '/api/trades')).json();
const mint = st.positions[0]?.mint || trades[0]?.mint || st.ticker[0]?.mint;
if (mint) { await page.goto(A + `/?skip=1&theme=dark&token=${mint}`); await wait(5000); await shot('11-token-detail'); }
const tmint = trades.find((t) => t.pnlUsd > 0)?.mint || trades[0]?.mint;
if (tmint && tmint !== mint) { await page.goto(A + `/?skip=1&theme=dark&token=${tmint}`); await wait(5000); await shot('11b-token-detail-closed-trade'); }
await page.goto(A + '/?skip=1&theme=dark&toast=1'); await wait(900); await shot('12-take-profit-toast');
await page.goto(A + '/?skip=1&theme=dark&recap=1'); await wait(1500); await shot('13-night-recap');
await browser.close();
console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
