import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  parseWithdrawDestination, isSecretLikeDestination, WITHDRAW_ERR, DEFAULT_WITHDRAW_TO,
  keepLamportsForWithdraw, spendableLamports, withdrawFeeLamports,
} from '../server/withdraw.ts';
import { DEFAULTS } from '../server/config.ts';
import { Engine } from '../server/engine.ts';
import { Store } from '../server/store.ts';
import { ReplayMarket } from '../server/replay.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT = DEFAULT_WITHDRAW_TO;

test('parseWithdrawDestination accepts a valid on-curve public key', () => {
  const r = parseWithdrawDestination(DEFAULT);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.address, DEFAULT);
  const bot = parseWithdrawDestination('2VscQ33yZudTXXNjCpfB5X4jsJVL4ZoZxGDzS5xCtLYo');
  assert.equal(bot.ok, true);
});

test('parseWithdrawDestination trims whitespace on a valid address', () => {
  const r = parseWithdrawDestination('  ' + DEFAULT + '\n');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.address, DEFAULT);
});

test('parseWithdrawDestination rejects an invalid address with a Thai error', () => {
  for (const bad of ['', 'hello', 'not-an-address', '123', 'So11111111111111111111111111111111111111111x']) {
    const r = parseWithdrawDestination(bad);
    assert.equal(r.ok, false, bad);
    if (!r.ok) {
      assert.equal(r.code, 'invalid');
      assert.equal(r.error, WITHDRAW_ERR.invalid);
      assert.match(r.error, /ที่อยู่ไม่ถูกต้อง/);
    }
  }
});

test('parseWithdrawDestination rejects 12- and 24-word seeds and does not echo them', () => {
  const w12 = Array.from({ length: 12 }, () => 'abandon').join(' ');
  const w24 = Array.from({ length: 24 }, () => 'zebra').join(' ');
  for (const seed of [w12, w24]) {
    assert.equal(isSecretLikeDestination(seed), true);
    const r = parseWithdrawDestination(seed);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'secret');
      assert.equal(r.error, WITHDRAW_ERR.secret);
      assert.match(r.error, /คีย์ลับ|วลีกู้คืน/);
      assert.equal(JSON.stringify(r).includes('abandon'), false);
      assert.equal(JSON.stringify(r).includes('zebra'), false);
    }
  }
});

test('parseWithdrawDestination rejects a 64-byte base58 secret key', () => {
  const kp = Keypair.generate();
  const secret = bs58.encode(kp.secretKey);
  assert.ok(secret.length >= 80, 'secret length ' + secret.length);
  assert.equal(isSecretLikeDestination(secret), true);
  const r = parseWithdrawDestination(secret);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'secret');
    assert.equal(r.error, WITHDRAW_ERR.secret);
    assert.equal(JSON.stringify(r).includes(secret), false);
  }
  // The matching public key is still accepted.
  const pub = parseWithdrawDestination(kp.publicKey.toBase58());
  assert.equal(pub.ok, true);
});

test('parseWithdrawDestination rejects hex and JSON secret-like payloads', () => {
  const hex64 = 'aa'.repeat(32);
  const json = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
  for (const s of [hex64, '0x' + hex64 + hex64, json]) {
    const r = parseWithdrawDestination(s);
    assert.equal(r.ok, false, s.slice(0, 20));
    if (!r.ok) assert.equal(r.code, 'secret');
  }
});

test('Max leaves fee reserve, and more when live positions are open', () => {
  const fee = withdrawFeeLamports(0.0002);
  assert.ok(fee > 5000);
  const none = keepLamportsForWithdraw({ priorityFeeSol: 0.0002, openLivePositions: 0 });
  const open = keepLamportsForWithdraw({ priorityFeeSol: 0.0002, openLivePositions: 2 });
  assert.ok(open > none, `open ${open} vs none ${none}`);
  const bal = 1_000_000;
  assert.equal(spendableLamports(bal, none), Math.max(0, bal - none));
  assert.equal(spendableLamports(3_000, none), 0);
});

test('engine withdraw is refused in TEST, including dry-run', async () => {
  const dirp = mkdtempSync(join(tmpdir(), 'gb-wd2-'));
  const e = new Engine({ ...DEFAULTS, scanIntervalSec: 9999, monitorIntervalSec: 9999 }, new ReplayMarket(1), new Store(join(dirp, 't.db')));
  await e.connect({ type: 'paper', startUsd: 10 });
  await assert.rejects(() => e.withdraw({ max: true, to: DEFAULT }), /โหมด TEST/);
  await assert.rejects(() => e.withdraw({ dryRun: true, to: DEFAULT }), /โหมด TEST/);
  await assert.rejects(() => e.withdraw({ to: 'abandon '.repeat(12).trim() }), /คีย์ลับ|วลีกู้คืน/);
  e.stop();
});
