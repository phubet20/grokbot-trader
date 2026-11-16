import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { formatBody, sendTestPush, webpushLib } from '../server/push.ts';

const webpush = webpushLib;

function b64url(buf: Buffer) { return buf.toString('base64url'); }

/** Uncompressed P-256 public key (0x04 || X || Y) as base64url — required for p256dh. */
function clientPushKeys() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  assert.equal(point.length, 65);
  return { p256dh: b64url(point), auth: b64url(randomBytes(16)) };
}

test('buy and sell notification copy includes symbol, size, price, and PnL on sells', () => {
  const buy = formatBody({ side: 'BUY', symbol: 'DOGE', sizeUsd: 2.5, price: 0.0012 });
  assert.match(buy.title, /Bought \$DOGE/);
  assert.match(buy.body, /\$2.50/);
  const sell = formatBody({ side: 'SELL', symbol: 'DOGE', sizeUsd: 2.7, price: 0.0013, pnlPct: 8.25 });
  assert.match(sell.title, /Sold \$DOGE/);
  assert.match(sell.body, /\+8.25%/);
});

test('web-push sendNotification to a local endpoint returns 201', async () => {
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:webpush@localhost';
  const prevTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const seen: { status: number; body: Buffer } = { status: 0, body: Buffer.alloc(0) };
  const dir = mkdtempSync(join(tmpdir(), 'push-cert-'));
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout '${dir}/k.pem' -out '${dir}/c.pem' -days 1 -nodes -subj '/CN=localhost'`, { stdio: 'pipe' });
  const server = createServer({
    key: readFileSync(join(dir, 'k.pem')),
    cert: readFileSync(join(dir, 'c.pem')),
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.body = Buffer.concat(chunks);
      res.writeHead(201, { 'content-type': 'text/plain' });
      res.end('created');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  try {
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const keys = clientPushKeys();
    const sub = { endpoint: `https://127.0.0.1:${addr.port}/push`, keys };
    const r = await sendTestPush(sub, { title: 'Bought $TEST', body: '$2.00 @ 0.001' });
    assert.equal(r.statusCode, 201);
    assert.ok(seen.body.length > 0, 'encrypted payload was posted');
  } finally {
    if (prevTLS === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTLS;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
