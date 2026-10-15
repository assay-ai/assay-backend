import * as chainMetadata from '@modules/chains/chain-metadata';

/**
 * Re-opens one rail on Solana for the suite that calls it.
 *
 * Solana offers no paid rail in `chain-metadata.ts` today. Rail B is off until
 * the Anchor program binds a buyer's tightening to already-signed vouchers only
 * after a delay (no-platform-debt design, step 3), and rail A is off while
 * rail B is, because it spends a ledger mirror the buyer can withdraw from
 * under it (review 2026-10-15, C1). The code for both is kept for when they
 * are switched back on, and the suites that pin it still run it: only the rail
 * table's answer for `solana:* / <rail>` is changed, every other chain and
 * rail goes through the real `assertRailOffered` / `offersRail`.
 *
 * Registers its own `beforeAll`/`afterAll`; call it inside a `describe`.
 */
export function offerSolanaRailsInThisSuite(...opened: chainMetadata.PaymentRailName[]): void {
  const spies: jest.SpyInstance[] = [];
  beforeAll(() => {
    const actualAssert = chainMetadata.assertRailOffered;
    const actualOffers = chainMetadata.offersRail;
    const isOpened = (chainId: string, rail: chainMetadata.PaymentRailName): boolean =>
      chainId.startsWith('solana:') && opened.includes(rail);
    spies.push(
      jest.spyOn(chainMetadata, 'assertRailOffered').mockImplementation((chainId, rail) => {
        if (isOpened(chainId, rail)) return;
        actualAssert(chainId, rail);
      }),
      jest
        .spyOn(chainMetadata, 'offersRail')
        .mockImplementation(
          (chainId, rail) => isOpened(chainId, rail) || actualOffers(chainId, rail),
        ),
    );
  });
  afterAll(() => spies.splice(0).forEach((spy) => spy.mockRestore()));
}

/** Re-opens rail B on Solana for this suite. See {@link offerSolanaRailsInThisSuite}. */
export function offerSolanaRailBInThisSuite(): void {
  offerSolanaRailsInThisSuite('B');
}

/** Re-opens rail A on Solana for this suite. See {@link offerSolanaRailsInThisSuite}. */
export function offerSolanaRailAInThisSuite(): void {
  offerSolanaRailsInThisSuite('A');
}
