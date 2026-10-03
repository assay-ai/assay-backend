import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { ChainsModule } from '@modules/chains/chains.module';
import { AlertingModule } from '@shared/alerting';

import { AwsKmsSigner, KmsKeyRef, KmsSigningClient } from './backends/aws-kms.signer';
import { EnvKeypairSigner } from './backends/env-keypair.signer';
import { takeEnvSigningKeys } from './backends/env-key-source';
import { takeEvmSigningKeys } from './backends/evm-key-source';
import { Secp256k1EnvSigner } from './backends/secp256k1-env.signer';
import { SigningCurve } from './domain/key-curve';
import { SIGNER_PORT, SignerBackend, SignerPort } from './ports/signer.port';
import { RedisSigningRateLimiter } from './services/redis-signing-rate-limiter.service';
import { VerifierKeyDirectory } from './services/verifier-key-directory.service';
import { VerifierSigningService } from './services/verifier-signing.service';
import { VerifierSigningConfig, verifierSigningConfigFactory } from './signing.config';
import {
  ENV_SIGNING_KEY_SOURCES,
  EVM_SIGNING_KEY_SOURCES,
  KMS_SIGNING_CLIENT,
  KMS_SIGNING_KEY_REFS,
  SIGNERS_BY_CURVE,
  SIGNING_RATE_LIMITS,
  SIGNING_RATE_REDIS,
  VERIFIER_KMS_KEYS_ENV,
  VERIFIER_SIGNING_CONFIG,
} from './signing.constants';

/**
 * The verifier signing key and everything that guards it.
 *
 * ## Import this module deliberately, and nowhere else
 *
 * It is **not** part of `VerificationModule`, and that is the point. Importing
 * it is what puts the signing key into a process's address space, so it has to
 * be a decision made once per service rather than something inherited by
 * everything that happens to want a verdict. The security model puts the
 * verifier signer in the trusted tier, on the other
 * side of a line from `api` and `mcp`; a module that arrived by transitive
 * import would erase that line without anybody choosing to.
 *
 * Today it is imported by the worker alone — see `bootstrap/worker/app.module.ts`.
 * The end state is its own `SERVICE_TYPE`, exactly as the facilitator already
 * has for the fee-payer key; that separation is not done here, because the
 * process split is a deployment change and this module is a custody one.
 *
 * ## Resolving the backend
 *
 * `SIGNER_PORT` is chosen by `VERIFIER_SIGNER_BACKEND` and today `env` is the
 * only value with an implementation. The factory below is written as a switch
 * over the enum rather than as a direct binding so that adding KMS is a case
 * and a class — the shape the seam promises — and so that an unimplemented
 * value fails at boot with a list of what works, instead of resolving to
 * `undefined` and failing at the first signature.
 *
 * The env material is read *once*, here, in a factory that deletes it from
 * `process.env` on the way through (`backends/env-key-source.ts`). Doing it in
 * a provider rather than inside the signer's constructor is what makes that
 * true regardless of how many times Nest instantiates anything.
 */

/**
 * Backends with a class behind them. Adding to this without adding a case below
 * is a boot failure.
 *
 * `KMS` is here because `AwsKmsSigner` exists and passes the same contract suite
 * the env backend does — but selecting it still needs a client bound to
 * `KMS_SIGNING_CLIENT`, and the factory below says so in as many words rather
 * than failing at the first signature. Listing it and then explaining what is
 * missing is more useful than pretending it does not exist: the operator who
 * sets `VERIFIER_SIGNER_BACKEND=kms` is exactly the person who needs that
 * sentence.
 */
const IMPLEMENTED_BACKENDS: readonly SignerBackend[] = [SignerBackend.ENV, SignerBackend.KMS];

const providers: Provider[] = [
  {
    provide: VERIFIER_SIGNING_CONFIG,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) =>
      verifierSigningConfigFactory(configService, IMPLEMENTED_BACKENDS),
  },
  {
    provide: SIGNING_RATE_LIMITS,
    inject: [VERIFIER_SIGNING_CONFIG],
    useFactory: (config: VerifierSigningConfig) => config.rateLimits,
  },
  {
    // Its own connection rather than the shared cache client, for the reason
    // the kill switch gives next door: this one is on the path that decides
    // whether a signature is produced, and it must not queue behind cache
    // traffic or be taken down by it.
    provide: SIGNING_RATE_REDIS,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) =>
      new Redis(configService.get<string>('redis.url') as string, {
        password: configService.get<string>('redis.password') || undefined,
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
      }),
  },
  {
    provide: ENV_SIGNING_KEY_SOURCES,
    useFactory: () => takeEnvSigningKeys(process.env),
  },
  EnvKeypairSigner,
  {
    // A SECOND variable, read the same way and deleted the same way.
    // The EVM verifier key is secp256k1 and must never be the ed25519 one, so
    // it does not share `VERIFIER_SIGNING_KEYS`: one variable holding both
    // curves would make "which key signs for which chain" a parsing question
    // instead of a provisioning one, and the two rotate on separate schedules.
    provide: EVM_SIGNING_KEY_SOURCES,
    useFactory: () => takeEvmSigningKeys(process.env),
  },
  Secp256k1EnvSigner,
  {
    // ARNs, not secrets. Parsed even when the backend is `env`, so that a
    // misconfigured list fails the boot of the deployment that is about to
    // switch rather than the first one that tries to sign.
    provide: KMS_SIGNING_KEY_REFS,
    inject: [ConfigService],
    useFactory: (configService: ConfigService): readonly KmsKeyRef[] =>
      parseKmsKeyRefs(configService.get<string>(VERIFIER_KMS_KEYS_ENV)),
  },
  {
    // Unbound by default. See `signing.constants.ts` for why the SDK is not a
    // dependency of a path nothing calls yet.
    provide: KMS_SIGNING_CLIENT,
    useValue: null,
  },
  {
    provide: SIGNER_PORT,
    inject: [VERIFIER_SIGNING_CONFIG, EnvKeypairSigner, KMS_SIGNING_CLIENT, KMS_SIGNING_KEY_REFS],
    useFactory: (
      config: VerifierSigningConfig,
      env: EnvKeypairSigner,
      kmsClient: KmsSigningClient | null,
      kmsKeys: readonly KmsKeyRef[],
    ) => {
      switch (config.backend) {
        case SignerBackend.ENV:
          return env;
        case SignerBackend.KMS:
          if (!kmsClient) {
            throw new Error(
              'VERIFIER_SIGNER_BACKEND=kms, but no KMS client is bound. AwsKmsSigner is ' +
                'implemented and tested; wiring it needs three things: `yarn add ' +
                '@aws-sdk/client-kms`, a KmsSigningClient adapter provided for ' +
                'KMS_SIGNING_CLIENT in this module, and VERIFIER_KMS_KEYS set to the key ' +
                'ARNs. See src/modules/verification/signing/backends/aws-kms.signer.ts.',
            );
          }
          return new AwsKmsSigner(kmsClient, kmsKeys);
        default:
          // `verifierSigningConfigFactory` has already refused anything not in
          // `IMPLEMENTED_BACKENDS`, so this is unreachable — and it is here so
          // that adding an enum member without adding a case is a compile-time
          // nudge and a boot-time failure rather than a silent `undefined`.
          throw new Error(`No signer bound for backend "${config.backend}"`);
      }
    },
  },
  {
    /**
     * Which backend holds which curve — see `SIGNERS_BY_CURVE`.
     *
     * `VERIFIER_SIGNER_BACKEND` chooses the **ed25519** custody service and
     * nothing else. There is deliberately no `EVM_VERIFIER_SIGNER_BACKEND`:
     * `AwsKmsSecp256k1Signer` is not built yet (the KMS client is
     * `useValue: null` and `@aws-sdk/client-kms` is not a dependency), so a
     * variable offering a choice of one value would be a dial that does
     * nothing. `recovery-id.ts` is the half of that backend worth keeping now.
     */
    provide: SIGNERS_BY_CURVE,
    inject: [SIGNER_PORT, Secp256k1EnvSigner],
    useFactory: (ed25519: SignerPort, secp256k1: Secp256k1EnvSigner) =>
      new Map<SigningCurve, SignerPort>([
        ['ed25519', ed25519],
        ['secp256k1', secp256k1],
      ]),
  },
  RedisSigningRateLimiter,
  VerifierKeyDirectory,
  VerifierSigningService,
];

/**
 * `VERIFIER_KMS_KEYS`, or an empty list.
 *
 * No error path quotes the value, for the same reason `env-key-source.ts` does
 * not — this one holds ARNs rather than secrets today, but the parser is one
 * copy-paste away from being reused on something that does not.
 */
function parseKmsKeyRefs(raw: string | undefined): readonly KmsKeyRef[] {
  if (!raw || raw.trim() === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${VERIFIER_KMS_KEYS_ENV} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${VERIFIER_KMS_KEYS_ENV} must be a JSON array of { keyId, arn }`);
  }
  return parsed.map((entry, index) => {
    const { keyId, arn } = (entry ?? {}) as Partial<KmsKeyRef>;
    if (typeof keyId !== 'string' || typeof arn !== 'string' || !keyId || !arn) {
      throw new Error(`${VERIFIER_KMS_KEYS_ENV} entry ${index} needs both keyId and arn`);
    }
    return { keyId, arn };
  });
}

@Module({
  // `ChainsModule` for `VERIFIER_REGISTRY` — the on-chain allowlist read.
  //
  // `AlertingModule` is imported here even though it is `@Global()`, because
  // global still means "instantiated once somewhere" and the worker bootstrap
  // did not import it — so every alert on this path would have been a boot
  // failure instead. A module whose entire contract is "import me deliberately,
  // into one process" cannot also require the importer to know what else to
  // bring; the rotation drill found this by being the first thing to build the
  // graph outside a bootstrap that happened to have it.
  imports: [ChainsModule, AlertingModule],
  providers,
  exports: [VerifierSigningService, VerifierKeyDirectory, SIGNER_PORT],
})
export class VerifierSigningModule {}
