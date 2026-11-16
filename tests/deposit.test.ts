import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { assembleDepositTx, solToLamports, serializeUnsigned } from '../server/deposit.ts';

test('assembleDepositTx builds an unsigned SOL transfer to the bot wallet and does not send', () => {
  const from = Keypair.generate();
  const to = Keypair.generate();
  const lamports = solToLamports(0.05);
  assert.equal(lamports, 50_000_000);
  const tx = assembleDepositTx({ from: from.publicKey.toBase58(), to: to.publicKey.toBase58(), lamports, blockhash: 'EkSnNWid2cf4F46JUKEtnvqQgXUe7E3FpSWRzQTtJ1qS' });
  assert.equal(tx.feePayer?.toBase58(), from.publicKey.toBase58());
  assert.equal(tx.instructions.length, 1);
  const keys = tx.instructions[0].keys;
  assert.equal(keys[0].pubkey.toBase58(), from.publicKey.toBase58());
  assert.equal(keys[1].pubkey.toBase58(), to.publicKey.toBase58());
  assert.deepEqual(tx.instructions[0].programId.toBase58(), SystemProgram.programId.toBase58());
  const b64 = serializeUnsigned(tx);
  const again = Transaction.from(Buffer.from(b64, 'base64'));
  assert.equal(again.instructions.length, 1);
  assert.equal(again.signatures.every((s) => !s.signature), true, 'must stay unsigned (dry-run)');
});

test('assembleDepositTx rejects invalid amounts and self-transfers', () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  assert.throws(() => solToLamports(0), /greater than 0/);
  assert.throws(() => assembleDepositTx({ from: a, to: a, lamports: 1000, blockhash: 'EkSnNWid2cf4F46JUKEtnvqQgXUe7E3FpSWRzQTtJ1qS' }), /same/);
  assert.throws(() => assembleDepositTx({ from: 'nope', to: b, lamports: 1000, blockhash: 'EkSnNWid2cf4F46JUKEtnvqQgXUe7E3FpSWRzQTtJ1qS' }), /invalid/);
});
