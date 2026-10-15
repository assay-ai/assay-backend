import * as chainMetadata from '@modules/chains/chain-metadata';

/**
 * Re-opens rail B on Solana for the suite that calls it.
 *
 * Rail B is switched off on Solana in `chain-metadata.ts` until the Anchor
 * program binds a buyer's tightening to already-signed vouchers only after a
 * delay (no-platform-debt design, step 3). The Solana rail-B code is kept for
 * when it is switched back on, and the suites that pin it — real ed25519 over
 * the real `SolanaChainAdapter` — still run it: only the rail table's answer
 * for `solana:* / B` is changed, every other chain and rail goes through the
 * real `assertRailOffered`.
 *
 * Registers its own `beforeAll`/`afterAll`; call it inside a `describe`.
 */
export function offerSolanaRailBInThisSuite(): void {
  let spy: jest.SpyInstance | null = null;
  beforeAll(() => {
    const actual = chainMetadata.assertRailOffered;
    spy = jest.spyOn(chainMetadata, 'assertRailOffered').mockImplementation((chainId, rail) => {
      if (chainId.startsWith('solana:') && rail === 'B') return;
      actual(chainId, rail);
    });
  });
  afterAll(() => spy?.mockRestore());
}
