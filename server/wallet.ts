// Bot trading keypair loader and helpers.
// The secret is read from BOT_WALLET_SECRET or BOT_WALLET_SECRET.txt only.
// Never log, return, or include the secret in API payloads.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ROOT } from './config.ts';

const FILE = join(ROOT, 'BOT_WALLET_SECRET.txt');

function decodeSecret(raw: string): Uint8Array {
  const s = raw.trim();
  if (!s) throw new Error('empty secret');
  if (s.startsWith('[')) return Uint8Array.from(JSON.parse(s));
  return bs58.decode(s);
}

function readSecretBytes(): Uint8Array | null {
  const env = (process.env.BOT_WALLET_SECRET || '').trim();
  if (env) return decodeSecret(env);
  if (existsSync(FILE)) return decodeSecret(readFileSync(FILE, 'utf8'));
  return null;
}

export function hasBotWallet(): boolean {
  try { return !!readSecretBytes(); } catch { return false; }
}

export function botKeypair(): Keypair {
  const bytes = readSecretBytes();
  if (!bytes) throw new Error('bot wallet is not configured');
  return Keypair.fromSecretKey(bytes);
}

export function botPublicKey(): string | null {
  try { return botKeypair().publicKey.toBase58(); } catch { return null; }
}

export const LOCK_MESSAGE = (address: string) =>
  `I am ${address} and I lock Grok Bot withdrawals exclusively to this Solana address.`;

export function verifyWithdrawLock(address: string, message: string, signature: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  if (message !== LOCK_MESSAGE(address)) return false;
  let sig: Uint8Array;
  try {
    sig = /^[0-9a-fA-F]+$/.test(signature) && signature.length >= 128
      ? Uint8Array.from(Buffer.from(signature, 'hex'))
      : (signature.includes('+') || signature.includes('/') || signature.endsWith('=')
        ? Uint8Array.from(Buffer.from(signature, 'base64'))
        : bs58.decode(signature));
  } catch { return false; }
  try {
    const pub = new PublicKey(address).toBytes();
    return nacl.sign.detached.verify(Buffer.from(message), sig, pub);
  } catch { return false; }
}

/** Redact any configured secret that might have been interpolated into a string. */
export function redactSecrets(s: string): string {
  const parts: string[] = [];
  const env = (process.env.BOT_WALLET_SECRET || '').trim();
  if (env) parts.push(env);
  try { if (existsSync(FILE)) parts.push(readFileSync(FILE, 'utf8').trim()); } catch {}
  let out = s;
  for (const p of parts) if (p) out = out.split(p).join('[redacted]');
  return out;
}
