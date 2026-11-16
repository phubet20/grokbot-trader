// UI-only check of the live-mode connect sheet. Does not connect a wallet or send a swap.
//   node scripts/live-connect-ui.mjs <baseUrl>
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const OUT = process.env.SHOT_DIR || '/tmp/live-connect-ui/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const wait = (ms) => page.waitForTimeout(ms);
const fail = async (msg) => { console.error('FAIL:', msg); await browser.close(); process.exit(1); };

const health = await (await page.request.get(BASE + '/api/health')).json();
if (health.mode !== 'live') await fail('expected api/health mode=live, got ' + health.mode);
console.log('api/health mode=live');

await page.goto(BASE + '/?theme=light', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid=connect-sheet]', { timeout: 25000 });
await page.waitForSelector('[data-testid=open-in-phantom]', { timeout: 15000 });
await wait(700); // wait for sheet animation
await page.waitForSelector('text=LIVE · real funds', { timeout: 10000 });
if (await page.locator('[data-testid=connect]').count()) await fail('Connect should be hidden until Phantom is present');

const href = await page.getAttribute('[data-testid=open-in-phantom]', 'href');
const pageUrl = page.url();
const origin = new URL(pageUrl).origin;
const expected = `https://phantom.app/ul/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(origin)}`;
if (!href || !href.startsWith('https://phantom.app/ul/browse/')) await fail('Open in Phantom href is not a Phantom universal link');
const u = new URL(href);
const encoded = u.pathname.slice('/ul/browse/'.length);
let decoded;
try { decoded = decodeURIComponent(encoded); } catch { await fail('browse path is not url-encoded'); }
if (decoded !== pageUrl) await fail('browse target is not the current app URL');
if (u.searchParams.get('ref') !== origin) await fail('ref param is not the page origin');
if (href !== expected) await fail('href did not match the expected Phantom browse format');
console.log('Open in Phantom universal link ok (browse=current url, ref=origin)');

const box = await page.locator('[data-testid=open-in-phantom]').boundingBox();
const vh = page.viewportSize().height;
if (!box) await fail('Open in Phantom button has no box');
if (box.y < 0 || box.y + box.height > vh + 1) await fail(`Open in Phantom button not fully in the ${vh}px viewport (y=${box.y}, h=${box.height})`);
console.log(`Open in Phantom button in viewport at y=${Math.round(box.y)}`);
await page.screenshot({ path: OUT + 'live-open-in-phantom.png' });
console.log('saved live-open-in-phantom.png');

if (errors.length) await fail('PAGE ERRORS:\n' + errors.join('\n'));
await browser.close();
console.log('live connect UI ok');
