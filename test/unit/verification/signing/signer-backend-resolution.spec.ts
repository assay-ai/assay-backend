import { ConfigService } from '@nestjs/config';

import { SignerBackend } from '@modules/verification/signing/ports/signer.port';
import { verifierSigningConfigFactory } from '@modules/verification/signing/signing.config';

/**
 * Which custody backend a deployment gets, and what happens when it asks for one
 * that is not wired.
 *
 * The failure mode this guards against is specific and expensive: a backend
 * value that resolves to nothing, boots fine, and fails at the *first
 * signature* — which is during an incident, on the path that issues penalties.
 * Every wrong answer below has to be a boot failure with a sentence in it.
 */
describe('signer backend resolution', () => {
  const IMPLEMENTED = [SignerBackend.ENV, SignerBackend.KMS];

  it('defaults to env outside production', () => {
    // A developer must not have to configure custody to run the test suite.
    const config = verifierSigningConfigFactory(
      configFor({ NODE_ENV: 'development' }),
      IMPLEMENTED,
    );

    expect(config.backend).toBe(SignerBackend.ENV);
  });

  it('refuses to boot in production with no backend chosen', () => {
    // The one place in the codebase where "it worked locally" is the wrong
    // outcome: where the key that can drain every provider's stake lives must
    // be a decision somebody made, not a default inherited from a file.
    expect(() =>
      verifierSigningConfigFactory(configFor({ NODE_ENV: 'production' }), IMPLEMENTED),
    ).toThrow(/No signer implementation for backend "\(unset\)"/);
  });

  it('accepts an explicit backend in production', () => {
    const config = verifierSigningConfigFactory(
      configFor({ NODE_ENV: 'production', VERIFIER_SIGNER_BACKEND: 'kms' }),
      IMPLEMENTED,
    );

    expect(config.backend).toBe(SignerBackend.KMS);
  });

  it('names what is supported when asked for a backend with no class', () => {
    // `turnkey`, `vault` and `privy` are members of the enum with nothing behind
    // them. Selecting one is a typo or a plan, and either way the operator needs
    // the list rather than a stack trace.
    expect(() =>
      verifierSigningConfigFactory(configFor({ VERIFIER_SIGNER_BACKEND: 'turnkey' }), IMPLEMENTED),
    ).toThrow(/backend "turnkey".*supported: env, kms/s);
  });

  it('refuses a value that is not a backend at all', () => {
    expect(() =>
      verifierSigningConfigFactory(configFor({ VERIFIER_SIGNER_BACKEND: 'yolo' }), IMPLEMENTED),
    ).toThrow(/backend "yolo"/);
  });

  describe('rate limits', () => {
    it('falls back to the defaults rather than to zero or NaN', () => {
      // `Number('')` is 0 and `Number('abc')` is NaN. A limit of 0 refuses every
      // signature; a limit of NaN compares false and refuses none. Both are
      // worse than the shipped default, and one of them silently disables the
      // control this whole configuration exists for.
      const config = verifierSigningConfigFactory(
        configFor({
          VERIFIER_SIGNING_RATE_PER_KEY: '',
          VERIFIER_SIGNING_RATE_PER_REQUESTER: 'abc',
          VERIFIER_SIGNING_RATE_WINDOW_SECONDS: '-5',
        }),
        IMPLEMENTED,
      );

      expect(config.rateLimits.perKey).toBe(60);
      expect(config.rateLimits.perRequester).toBe(30);
      expect(config.rateLimits.windowSeconds).toBe(60);
    });

    it('takes a valid override', () => {
      const config = verifierSigningConfigFactory(
        configFor({ VERIFIER_SIGNING_RATE_PER_KEY: '5' }),
        IMPLEMENTED,
      );

      expect(config.rateLimits.perKey).toBe(5);
    });
  });
});

function configFor(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as ConfigService;
}
