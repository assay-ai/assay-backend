/**
 * `yarn verifier:rotation-drill` — verifier key rotation and revocation, run for real.
 *
 * ```text
 *  1  enrol two keys on devnet                       real transactions
 *  2  sign with the outgoing key                     real ed25519, verified
 *  3  rotate: old -> RETIRED, new -> ACTIVE          no restart, no downtime
 *  4  sign with the incoming key                     real ed25519, verified
 *  5  revoke the old key on-chain                    real transaction
 *  6  try to sign with it again                      REFUSED by the allowlist
 *  7  drive the rate limiter past its ceiling        REFUSED, and journalled
 *  8  print the journal                              every line, including refusals
 * ```
 *
 * Everything below runs against the **deployed devnet program**, this
 * deployment's **real Postgres**, and its **real Redis**. Nothing is stubbed;
 * a mocked rotation drill proves that the mock rotates.
 *
 * ## The keys are generated here and never leave the process
 *
 * Two throwaway keypairs are minted in memory and injected into
 * `process.env.VERIFIER_SIGNING_KEYS` *before* the container is built — which
 * the env backend then deletes on the way through. They are never written to
 * `.env`, never printed, and never logged. That is not incidental to the drill:
 * `scripts/verifier-key/leak-scan.sh` greps this script's own output, and the
 * point is for it to find nothing.
 *
 * Re-runnable. Each run mints new keys, so it enrols new registry entries
 * rather than colliding with the previous run's — which is also what rotation
 * does in production, since a revoked key can never be re-registered.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import { inspect } from 'node:util';
import { execFileSync } from 'node:child_process';

import { INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { getAddressDecoder } from '@solana/kit';

import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import {
  VerifierSigningKeyRepository,
  VerifierSigningLogEntryRepository,
} from '@database/postgres';
import {
  RegisteredVerifierStatus,
  VERIFIER_REGISTRY,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';
import { ChainId } from '@modules/chains/ports/caip.types';
import { SigningKeyState } from '@modules/verification/signing/domain/key-lifecycle';
import { SIGNER_PORT, SignerBackend } from '@modules/verification/signing/ports/signer.port';
import { takeEnvSigningKeys } from '@modules/verification/signing/backends/env-key-source';
import { SigningRequesterType } from '@modules/verification/signing/domain/signing-journal';
import { RedisSigningRateLimiter } from '@modules/verification/signing/services/redis-signing-rate-limiter.service';
import { VerifierKeyDirectory } from '@modules/verification/signing/services/verifier-key-directory.service';
import { VerifierSigningService } from '@modules/verification/signing/services/verifier-signing.service';
import { VerifierSigningModule } from '@modules/verification/signing/verifier-signing.module';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';

/** The DER prefix that makes a bare 32-byte seed a PKCS#8 document. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The drill is a Solana-key drill, so every per-chain call names the
 * Solana chain this deployment serves. Read from `ENABLED_CHAINS` rather than
 * hard-coded: the drill writes a real row into `verifier_signing_keys`, whose
 * `chain_id` is NOT NULL and whose ACTIVE index is now per chain, so a
 * hard-coded devnet id would seed a mainnet deployment's directory with a
 * devnet key and the ACTIVE index would not even notice.
 */
const DRILL_CHAIN_ID: ChainId = (() => {
  const solana = (process.env.ENABLED_CHAINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('solana:'));
  if (solana.length !== 1) {
    throw new Error(
      `ENABLED_CHAINS must name exactly one solana chain for the rotation drill; it names ${solana.length}`,
    );
  }
  return solana[0] as ChainId;
})();

const OLD_KEY_ID = `drill-old-${stamp()}`;
const NEW_KEY_ID = `drill-new-${stamp()}`;

/** Deliberately tiny, so phase 7 is a handful of calls rather than sixty. */
const RATE_PER_REQUESTER = '3';
const RATE_PER_KEY = '8';

interface MintedKey {
  readonly keyId: string;
  readonly seedHex: string;
  readonly publicKey: Uint8Array;
  readonly publicKeyHex: string;
}

async function main(): Promise<void> {
  const programId = process.env.SOLANA_SETTLEMENT_PROGRAM_ID;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!programId || !rpcUrl) {
    fail('SOLANA_SETTLEMENT_PROGRAM_ID and SOLANA_RPC_URL must both be set.');
  }

  // `leak-scan.sh` pins the seeds so it knows exactly what to grep for. Nothing
  // else sets these, and a run without them mints fresh throwaway keys.
  const oldKey = mint(OLD_KEY_ID, process.env.VERIFIER_DRILL_SEED_OLD);
  const newKey = mint(NEW_KEY_ID, process.env.VERIFIER_DRILL_SEED_NEW);

  // Before the container exists. `takeEnvSigningKeys` deletes it during boot.
  process.env.VERIFIER_SIGNING_KEYS = JSON.stringify([
    { keyId: oldKey.keyId, secretKey: oldKey.seedHex },
    { keyId: newKey.keyId, secretKey: newKey.seedHex },
  ]);
  process.env.VERIFIER_SIGNER_BACKEND = SignerBackend.ENV;
  process.env.VERIFIER_SIGNING_RATE_PER_REQUESTER = RATE_PER_REQUESTER;
  process.env.VERIFIER_SIGNING_RATE_PER_KEY = RATE_PER_KEY;

  section('0. Setup');
  console.log(`program        ${programId}`);
  console.log(`cluster        ${rpcUrl}`);
  console.log(`outgoing key   ${oldKey.keyId}  ${addressOfHex(oldKey)}`);
  console.log(`incoming key   ${newKey.keyId}  ${addressOfHex(newKey)}`);
  console.log('the private halves exist only in this process and are never printed');

  section('1. Enrol both keys in the on-chain allowlist');
  // Both, up front. Rotation is only non-disruptive if the incoming key is
  // already enrolled before the cutover — enrolling at the cutover is a gap.
  registryCli(['register', addressOfHex(oldKey), oldKey.keyId, '180']);
  registryCli(['register', addressOfHex(newKey), newKey.keyId, '180']);

  const app = await boot();
  const directory = app.get(VerifierKeyDirectory);
  const signing = app.get(VerifierSigningService);
  const registry = app.get<VerifierRegistryPort>(VERIFIER_REGISTRY);
  const keys = app.get(VerifierSigningKeyRepository);
  const journal = app.get(VerifierSigningLogEntryRepository);
  const rateLimiter = app.get(RedisSigningRateLimiter);

  try {
    await seedDirectory(keys, oldKey, newKey, registry);

    section('2. Sign with the outgoing key');
    const beforeRotation = await signAndVerify(signing, oldKey, 'before-rotation');

    section('3. Rotate — no restart, no downtime');
    await directory.transition(oldKey.keyId, SigningKeyState.RETIRED, 'scheduled 180-day rotation');
    await directory.transition(newKey.keyId, SigningKeyState.ACTIVE, 'scheduled 180-day rotation');
    directory.forgetRegistryCache();
    console.log(`${oldKey.keyId}  ACTIVE  -> RETIRED`);
    console.log(`${newKey.keyId}  PENDING -> ACTIVE`);
    console.log('the process was not restarted and no signature was refused in between');

    section('4. Sign with the incoming key');
    await signAndVerify(signing, newKey, 'after-rotation');

    section('5. Revoke the outgoing key on-chain');
    registryCli(['revoke', addressOfHex(oldKey)]);
    registryCli(['show', addressOfHex(oldKey)]);

    section('6. The revoked key is refused');
    await proveRevokedKeyIsRefused(directory, signing, registry, oldKey, newKey, beforeRotation);

    section('7. Signing rate limit');
    await proveRateLimit(signing, rateLimiter, newKey);

    section('8. The signing journal');
    await printJournal(journal, [oldKey.keyId, newKey.keyId]);

    section('9. Key material containment');
    proveContainment(app, beforeRotation);

    section('Result');
    console.log('rotation drill PASSED');
  } finally {
    // Same teardown as `scripts/devnet/deposit.ts`: `app.close()` alone leaves
    // the Postgres and Redis handles open, and the datasource is named
    // `postgres` rather than default, so the shutdown hook cannot find it. The
    // rate limiter's own connection closes itself — see its `onModuleDestroy`.
    const dataSource = app.get<DataSource>(getDataSourceToken('postgres'), { strict: false });
    const redis = app.get<Redis>(REDIS_CACHE_CLIENT, { strict: false });
    await app.close().catch(() => undefined);
    await dataSource?.destroy().catch(() => undefined);
    redis?.disconnect();
  }
}

// ── phases ──────────────────────────────────────────────────────────────────

/**
 * The local directory starts where a real rotation starts: the outgoing key
 * signing, the incoming key enrolled but idle.
 */
async function seedDirectory(
  keys: VerifierSigningKeyRepository,
  oldKey: MintedKey,
  newKey: MintedKey,
  registry: VerifierRegistryPort,
): Promise<void> {
  // A previous run — or a real deployment — leaves a key ACTIVE, and
  // `uniq_verifier_signing_keys_active_per_chain` refuses a second one ON THIS
  // CHAIN (it was global before multichain support). That refusal is
  // the index doing its job, so the drill retires the incumbent rather than
  // working around the constraint.
  const incumbent = await keys.findActive(DRILL_CHAIN_ID);
  if (incumbent) {
    await keys.transition(incumbent.keyId, SigningKeyState.ACTIVE, SigningKeyState.RETIRED, {
      retiredAt: new Date(),
      reason: 'superseded by a rotation drill run',
    });
    console.log(`retired the incumbent ACTIVE key ${incumbent.keyId} to make room`);
  }

  for (const [key, state] of [
    [oldKey, SigningKeyState.ACTIVE],
    [newKey, SigningKeyState.PENDING],
  ] as const) {
    const entry = await registry.lookup(DRILL_CHAIN_ID, key.publicKey);
    await keys.save(
      keys.create({
        keyId: key.keyId,
        backend: SignerBackend.ENV,
        backendRef: 'env:VERIFIER_SIGNING_KEYS',
        publicKey: key.publicKeyHex,
        chainId: DRILL_CHAIN_ID,
        chainAddress: registry.addressOf(DRILL_CHAIN_ID, key.publicKey),
        state,
        registeredExpiresAt: entry?.expiresAt ?? null,
        activatedAt: state === SigningKeyState.ACTIVE ? new Date() : null,
        reason: 'rotation drill',
      }),
    );
  }
  console.log(`directory seeded: ${oldKey.keyId}=ACTIVE, ${newKey.keyId}=PENDING`);
}

async function signAndVerify(
  signing: VerifierSigningService,
  expected: MintedKey,
  requestId: string,
): Promise<{ payload: Uint8Array; signature: Uint8Array }> {
  const payload = Buffer.from(`rotation-drill:${requestId}:${stamp()}`);
  const result = await signing.sign({
    chainId: DRILL_CHAIN_ID,
    purpose: 'rotation_drill',
    requestId,
    requestedBy: { type: SigningRequesterType.OPERATOR, id: 'rotation-drill' },
    payload,
  });

  const verified = await verify(result.publicKey, result.signature, payload);
  console.log(`signed by      ${result.keyId}`);
  console.log(`public key     ${Buffer.from(result.publicKey).toString('hex')}`);
  console.log(`signature      ${Buffer.from(result.signature).toString('hex').slice(0, 32)}…`);
  console.log(`verifies       ${verified}`);
  console.log(`journal row    ${result.journalId}`);

  assert(
    result.keyId === expected.keyId,
    `expected ${expected.keyId}, signed with ${result.keyId}`,
  );
  assert(verified, 'the signature did not verify against the reported public key');
  return { payload, signature: result.signature };
}

/**
 * The claim being proved: **revoking the key on-chain is sufficient, on its
 * own, to stop this platform signing with it** — even when the local directory
 * says otherwise.
 *
 * So the old key is deliberately put *back* into `ACTIVE` locally, which is a
 * legal transition (a rotation rollback), and the signing attempt is still
 * refused. If the local table were authoritative this would succeed; the point
 * is that it is not.
 */
async function proveRevokedKeyIsRefused(
  directory: VerifierKeyDirectory,
  signing: VerifierSigningService,
  registry: VerifierRegistryPort,
  oldKey: MintedKey,
  newKey: MintedKey,
  signedBefore: { payload: Uint8Array; signature: Uint8Array },
): Promise<void> {
  // The signature the revoked key made in phase 2 is still cryptographically
  // valid — so what refuses it downstream is the allowlist, not the maths.
  // Stating both halves keeps the proof honest.
  const stillVerifies = await verify(
    oldKey.publicKey,
    signedBefore.signature,
    signedBefore.payload,
  );
  console.log(`the pre-revocation signature still verifies cryptographically: ${stillVerifies}`);

  const entry = await registry.lookup(DRILL_CHAIN_ID, oldKey.publicKey);
  console.log(`on-chain status of ${oldKey.keyId}: ${entry?.status}`);
  assert(entry?.status === RegisteredVerifierStatus.REVOKED, 'the key is not revoked on-chain');
  console.log('so any consumer that checks the allowlist rejects it — which the settlement');
  console.log('program does itself, independently, when a slash is submitted');

  // Now force the platform to try. Local state says ACTIVE; the chain says no.
  await directory.transition(newKey.keyId, SigningKeyState.RETIRED, 'drill: making room');
  await directory.transition(oldKey.keyId, SigningKeyState.ACTIVE, 'drill: local state lies');
  directory.forgetRegistryCache();

  let refusal = '';
  try {
    await signing.sign({
      chainId: DRILL_CHAIN_ID,
      purpose: 'rotation_drill',
      requestId: 'after-revocation',
      requestedBy: { type: SigningRequesterType.OPERATOR, id: 'rotation-drill' },
      payload: Buffer.from('this must not be signed'),
    });
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }

  console.log('');
  console.log(`local directory says ${oldKey.keyId} is ACTIVE; signing anyway:`);
  console.log(`  REFUSED: ${refusal}`);
  assert(/revoked on-chain/.test(refusal), 'the revoked key was not refused for the right reason');

  // Put the rotation back the way it should be for the rest of the drill.
  await directory.transition(oldKey.keyId, SigningKeyState.REVOKED, 'drill: revoked on-chain');
  await directory.transition(newKey.keyId, SigningKeyState.ACTIVE, 'drill: restore');
  directory.forgetRegistryCache();

  // And REVOKED is terminal here too, mirroring the program.
  let terminal = '';
  try {
    await directory.transition(oldKey.keyId, SigningKeyState.ACTIVE, 'drill: resurrect');
  } catch (error) {
    terminal = error instanceof Error ? error.message : String(error);
  }
  console.log(`  and locally: ${terminal}`);
  assert(/REVOKED is terminal/.test(terminal), 'REVOKED was not terminal locally');
}

async function proveRateLimit(
  signing: VerifierSigningService,
  rateLimiter: RedisSigningRateLimiter,
  key: MintedKey,
): Promise<void> {
  // Start from a clean window so the count below is the whole story.
  await rateLimiter.reset(key.keyId);
  console.log(`limits: ${RATE_PER_REQUESTER}/requester, ${RATE_PER_KEY}/key, 60s window`);
  console.log('');

  let allowed = 0;
  let refused = 0;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await signing.sign({
        chainId: DRILL_CHAIN_ID,
        purpose: 'rotation_drill',
        requestId: `rate-${attempt}`,
        requestedBy: { type: SigningRequesterType.OPERATOR, id: 'rate-drill' },
        payload: Buffer.from(`rate limit attempt ${attempt}`),
      });
      allowed += 1;
      console.log(`  attempt ${attempt}  SIGNED`);
    } catch (error) {
      refused += 1;
      console.log(`  attempt ${attempt}  ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log('');
  console.log(`${allowed} signed, ${refused} refused`);
  assert(allowed === Number(RATE_PER_REQUESTER), `expected ${RATE_PER_REQUESTER} to be signed`);
  assert(refused === 5 - Number(RATE_PER_REQUESTER), 'the limiter let too many through');
  console.log('refused attempts are counted and journalled — a burst of them IS the signal');
}

async function printJournal(
  journal: VerifierSigningLogEntryRepository,
  keyIds: readonly string[],
): Promise<void> {
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const rows = (await Promise.all(keyIds.map((keyId) => journal.findForKeySince(keyId, since))))
    .flat()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  console.log('when                      key                       requested by       request');
  console.log('                          outcome                   payload sha256 (first 16)');
  console.log('─'.repeat(96));
  for (const row of rows) {
    console.log(
      `${row.createdAt.toISOString()}  ${row.keyId.padEnd(24)}  ` +
        `${`${row.requestedByType}:${row.requestedById}`.padEnd(17)}  ${row.requestId ?? '—'}`,
    );
    console.log(
      `${' '.repeat(26)}${row.outcome.padEnd(26)}${row.payloadSha256.slice(0, 16)}` +
        `${row.refusalReason ? `  (${row.refusalReason})` : ''}`,
    );
  }
  console.log('─'.repeat(96));
  console.log(`${rows.length} rows — every signature and every refusal`);
}

/**
 * The key-containment check (see `leak-scan.sh`), from the inside.
 *
 * Deliberately *tries* to leak, on the three routes that would carry key
 * material out of a Node process, and prints what each one produces so that
 * `leak-scan.sh` can grep the lot. Every line printed here is a line the scan
 * expects to find the canary seed missing from.
 */
function proveContainment(
  app: INestApplicationContext,
  signed: { payload: Uint8Array; signature: Uint8Array },
): void {
  console.log(
    `process.env.VERIFIER_SIGNING_KEYS after boot: ${
      process.env.VERIFIER_SIGNING_KEYS === undefined ? 'undefined (deleted)' : 'STILL PRESENT'
    }`,
  );
  assert(
    process.env.VERIFIER_SIGNING_KEYS === undefined,
    'the key material survived boot in process.env',
  );

  // 1. The whole environment, as a crash reporter would attach it.
  console.log(`\nprocess.env dump (${Object.keys(process.env).length} vars):`);
  console.log(JSON.stringify(process.env));

  // 2. The signer object, as a structured logger or a debug line would print it.
  const signer = app.get(SIGNER_PORT);
  console.log('\nthe signer, inspected with hidden properties shown:');
  console.log(inspect(signer, { depth: 8, showHidden: true }));
  console.log(`JSON.stringify: ${JSON.stringify(signer)}`);

  // 3. The response an API would return for a signature.
  console.log('\nthe signature response, serialised:');
  console.log(
    JSON.stringify({
      signature: Buffer.from(signed.signature).toString('hex'),
      payload: Buffer.from(signed.payload).toString('hex'),
    }),
  );

  // 4. The boot-failure path, which is where Node's JSON.parse would quote the
  //    input it choked on.
  try {
    takeEnvSigningKeys({
      VERIFIER_SIGNING_KEYS: `[{"keyId":"canary","secretKey":"${process.env.VERIFIER_DRILL_SEED_OLD ?? 'aa'.repeat(32)}"`,
    });
  } catch (error) {
    console.log(`\nthe parse-failure message: ${error instanceof Error ? error.message : error}`);
  }
}

// ── plumbing ────────────────────────────────────────────────────────────────

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    DatabaseModule,
    RedisCacheModule,
    VerifierSigningModule,
  ],
})
class RotationDrillModule {}

async function boot(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(RotationDrillModule, {
    logger: ['error', 'warn', 'log'],
    abortOnError: false,
  });
}

/** A real ed25519 keypair, in memory. The seed goes into the env var and nowhere else. */
function mint(keyId: string, seedHex?: string): MintedKey {
  const privateKey = seedHex
    ? createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]),
        format: 'der',
        type: 'pkcs8',
      })
    : generateKeyPairSync('ed25519').privateKey;
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  const publicKey = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12),
  );
  return {
    keyId,
    seedHex: Buffer.from(seed).toString('hex'),
    publicKey,
    publicKeyHex: Buffer.from(publicKey).toString('hex'),
  };
}

/**
 * Enrolment goes through the operator CLI, as a subprocess, on purpose.
 *
 * It is the only path that exists — the application has no way to write the
 * allowlist, by design — and running it here rather than reimplementing it
 * means the drill exercises the tool an operator actually uses.
 */
function registryCli(args: readonly string[]): void {
  // The yarn that launched this drill, run by the current node — never
  // whichever `yarn` happens to be first on PATH, since the subprocess inherits
  // the operator's keys through the environment.
  const yarnPath = process.env.npm_execpath;
  if (!yarnPath) {
    throw new Error('Run the drill through yarn (`yarn verifier:rotation-drill`).');
  }
  const output = execFileSync(
    process.execPath,
    [yarnPath, '--silent', 'verifier:registry', ...args],
    { encoding: 'utf8', env: process.env },
  );
  console.log(
    output
      .split('\n')
      .filter((line) => line.trim() && !/^(program|cluster|admin)\s/.test(line))
      .map((line) => `  ${line}`)
      .join('\n'),
  );
}

/**
 * Base58, from the same decoder the backend uses. Not via the registry service,
 * because phase 1 enrols the keys before the container exists.
 */
function addressOfHex(key: MintedKey): string {
  return getAddressDecoder().decode(key.publicKey);
}

async function verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await webcrypto.subtle.importKey('raw', publicKey, 'Ed25519', true, ['verify']);
  return webcrypto.subtle.verify('Ed25519', key, signature, message);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function fail(message: string): never {
  console.error(`\nDRILL FAILED: ${message}`);
  process.exit(1);
}

/** Seconds since epoch — unique per run, and short enough for a 64-char key id. */
function stamp(): string {
  return Math.floor(Date.now() / 1000).toString(36);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
