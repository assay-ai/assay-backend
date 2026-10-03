import {
  VerificationErrorCode,
  VerificationErrors,
} from '@modules/verification/errors/verification.errors';
import { VerifierKeyDirectory } from '@modules/verification/signing/services/verifier-key-directory.service';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { VerifierSigningService } from '@modules/verification/signing/services/verifier-signing.service';

/**
 * `VerifierSigningService.publicKey()` — the active verifier key's address,
 * without a signature.
 *
 * It exists because two of the four slash doors — `execute_slash` and
 * `expire_slash` — carry no attestation and still need the verifier key named
 * as their fee payer. The obvious shortcut, signing an empty payload and
 * reading the address off the result, would put a journal row attesting to
 * nothing against every such submission, in the one log an investigator reads
 * first.
 *
 * What is asserted here is that the shortcut is not what happens, and that the
 * accessor did not become a hole in the gate the directory keeps: it resolves
 * through `VerifierKeyDirectory` like `sign()` does, so a key this process may
 * not use is refused here too. Naming a fee payer the process cannot sign with
 * would build a transaction that can never be sent, and failing at the
 * directory is what says why.
 */
describe('VerifierSigningService.publicKey', () => {
  const PUBLIC_KEY = new Uint8Array(32).fill(7);

  /** `publicKey` names the chain whose verifier key it wants. */
  const SOLANA = CHAIN_IDS.SOLANA_DEVNET;

  /**
   * The four collaborators `publicKey()` must not touch, and the one it must.
   *
   * `signer` is no longer one of them: multichain support moved the choice of custody backend
   * onto `SignableKey`, so the service signs with the backend the DIRECTORY
   * resolved rather than with one it injected. It is still built here, and the
   * assertion below that it was never called still holds — through the
   * directory's own result.
   */
  function build(directory: Partial<VerifierKeyDirectory>) {
    const signer = { sign: jest.fn(), getKey: jest.fn() };
    const journal = { open: jest.fn(), settle: jest.fn(), create: jest.fn(), save: jest.fn() };
    const rateLimiter = { observe: jest.fn() };
    const alerts = { raise: jest.fn() };

    const service = new VerifierSigningService(
      alerts as never,
      {} as never,
      directory as VerifierKeyDirectory,
      rateLimiter as never,
      journal as never,
    );

    return { service, signer, journal, rateLimiter, alerts };
  }

  it('returns the active key material’s public half', async () => {
    const { service } = build({
      resolveSignableKey: jest.fn().mockResolvedValue({
        handle: { keyId: 'verifier-1', publicKey: PUBLIC_KEY },
        row: { keyId: 'verifier-1' },
        registry: {},
        signer: { sign: jest.fn() },
      }),
    });

    await expect(service.publicKey(SOLANA)).resolves.toEqual(PUBLIC_KEY);
  });

  it('resolves through the directory, and signs nothing to do it', async () => {
    const resolveSignableKey = jest.fn().mockResolvedValue({
      handle: { keyId: 'verifier-1', publicKey: PUBLIC_KEY },
      row: { keyId: 'verifier-1' },
      registry: {},
      signer: { sign: jest.fn() },
    });
    const { service, signer, journal, rateLimiter } = build({ resolveSignableKey });

    await service.publicKey(SOLANA);

    expect(resolveSignableKey).toHaveBeenCalledTimes(1);
    // And with the chain it was asked for. A directory call that dropped the
    // argument would resolve `findActive(undefined)` — no rows, or the wrong
    // chain's row — and this is the only place that would say so.
    expect(resolveSignableKey).toHaveBeenCalledWith(SOLANA);
    // The three things `sign()` does and this must not: produce a signature,
    // open a journal row, and spend rate-limit budget.
    expect(signer.sign).not.toHaveBeenCalled();
    expect(journal.open).not.toHaveBeenCalled();
    expect(journal.create).not.toHaveBeenCalled();
    expect(journal.save).not.toHaveBeenCalled();
    expect(rateLimiter.observe).not.toHaveBeenCalled();
  });

  /**
   * The on-chain half of the gate. A key revoked in the registry is refused by
   * `resolveSignableKey`, and the refusal has to reach the caller rather than
   * being swallowed into an address that would build an unsignable transaction.
   */
  it('refuses a key revoked on chain, with the directory’s own error', async () => {
    const { service } = build({
      resolveSignableKey: jest.fn().mockRejectedValue(
        VerificationErrors.signingKeyNotSignable({
          keyId: 'verifier-1',
          reason: 'revoked on-chain at 2026-08-01T00:00:00.000Z',
        }),
      ),
    });

    const error = await service.publicKey(SOLANA).catch((caught: unknown) => caught);

    expect((error as { errorCode?: string }).errorCode).toBe(
      VerificationErrorCode.VERIFICATION_SIGNING_KEY_NOT_SIGNABLE,
    );
    expect((error as Error).message).toMatch(/revoked/i);
  });

  it('refuses when there is no active key at all', async () => {
    const { service } = build({
      resolveSignableKey: jest.fn().mockRejectedValue(VerificationErrors.signingNoActiveKey()),
    });

    const error = await service.publicKey(SOLANA).catch((caught: unknown) => caught);

    expect((error as { errorCode?: string }).errorCode).toBe(
      VerificationErrorCode.VERIFICATION_SIGNING_NO_ACTIVE_KEY,
    );
  });
});
