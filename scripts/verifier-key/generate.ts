/**
 * `yarn verifier:key:generate <keyId>` — mint a verifier signing keypair.
 *
 * Prints the secret **once, to stdout, and never anywhere else**. It is not
 * logged, not written to a file, and not sent to the on-chain registry — the
 * registry takes the public half. If the operator loses the line, the answer is
 * to generate another key and register that one; there is no recovery path and
 * there should not be, because a recovery path is a second copy.
 *
 * The output is a ready-made `VERIFIER_SIGNING_KEYS` entry. That is not a
 * convenience: the alternative is an operator converting a key by hand between
 * base58 and hex at the moment they are already under pressure, with the
 * material on a clipboard.
 */
import { generateKeyPairSync, createPublicKey } from 'node:crypto';

import { getAddressDecoder } from '@solana/kit';

const PKCS8_HEADER_LENGTH = 16;
const SPKI_HEADER_LENGTH = 12;

function main(): void {
  const keyId = process.argv[2];
  if (!keyId || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(keyId)) {
    console.error('usage: yarn verifier:key:generate <key-id>');
    console.error('  <key-id> is kebab-case, 3-32 chars — e.g. verifier-2026-08');
    console.error('  It becomes the on-chain label and the join key of every journal line,');
    console.error('  so name it after when it was minted, not after what it does.');
    process.exit(1);
  }

  const { privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_HEADER_LENGTH);
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_HEADER_LENGTH);

  const publicKeyHex = Buffer.from(publicKey).toString('hex');
  const address = getAddressDecoder().decode(new Uint8Array(publicKey));

  console.log('');
  console.log(`key id      ${keyId}`);
  console.log(`public key  ${publicKeyHex}`);
  console.log(`address     ${address}`);
  console.log('');
  console.log('Register the PUBLIC key on-chain — this is what the allowlist holds:');
  console.log('');
  console.log(`  yarn verifier:registry register ${address} ${keyId} 180`);
  console.log('');
  console.log('Then give the deployment the private half. Append to the JSON array already');
  console.log('in VERIFIER_SIGNING_KEYS — do NOT replace it, or the outgoing key becomes');
  console.log('unloadable and the rotation has an outage in the middle of it:');
  console.log('');
  console.log(
    `  {"keyId":"${keyId}","secretKey":"${Buffer.from(seed).toString('hex')}"}`,
  );
  console.log('');
  console.log('That line is the only copy. It is not stored anywhere by this script.');
  console.log('');
}

main();
