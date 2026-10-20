import { assertRailOffered, chainMetadata } from '@modules/chains/chain-metadata';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { PaymentRail, railName } from '@modules/payment/ports/payment.types';
import { AppError } from '@shared/errors/app-errors';

/**
 * The rule: *"`SUPPORTED_RAILS` is per-chain: Solana offers no paid rail
 * today (rail B is off until its program has the tighten-delay rule, rail A is
 * off while B is), 4663 ships B only. The 402 response on 4663 never advertises a rail A scheme, and the
 * router never selects one."*
 *
 * `ChainMetadata.rails` was declared from the start and had **no reader**.
 * This file is where the declaration becomes binding.
 */
describe('each chain is held to its own rails', () => {
  it('eip155:46630 offers rail B only', () => {
    expect(chainMetadata(CHAIN_IDS.ROBINHOOD_TESTNET).rails).toEqual(['B']);
  });

  it('and Solana offers no paid rail, until its program has the tighten-delay rule', () => {
    // Rail B on Solana let a buyer's own transaction kill an admitted voucher,
    // and the platform paid the provider. Off until the Anchor program binds
    // a tightening to already-signed vouchers only after a delay. Rail A
    // spends a ledger mirror the buyer can withdraw from under it, so it is
    // off while B is (review 2026-10-15, C1).
    expect(chainMetadata(CHAIN_IDS.SOLANA_DEVNET).rails).toEqual([]);
    expect(chainMetadata(CHAIN_IDS.SOLANA_MAINNET).rails).toEqual([]);
  });

  it('no intent built for an eip155 chain may name a rail A scheme', () => {
    expect(() =>
      assertRailOffered(CHAIN_IDS.ROBINHOOD_TESTNET, railName(PaymentRail.RAIL_A_PER_CALL)),
    ).toThrow(/rail/i);
  });

  it('refuses with CHAIN_RAIL_NOT_OFFERED, naming the chain and the rail', () => {
    // The refusal has to be actionable. "Rail A" alone sends an operator to
    // read a table; the chain and the rails it DOES offer are what they need.
    let thrown: AppError | null = null;
    try {
      assertRailOffered(CHAIN_IDS.ROBINHOOD_TESTNET, railName(PaymentRail.RAIL_A_PER_CALL));
    } catch (error) {
      thrown = error as AppError;
    }

    expect(thrown?.errorCode).toBe(ChainErrorCode.CHAIN_RAIL_NOT_OFFERED);
    expect(thrown?.context).toMatchObject({
      chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
      rail: 'A',
      offered: ['B'],
    });
  });

  it('allows rail B on eip155:46630', () => {
    // The control that stops `assertRailOffered = () => { throw }`, which passes
    // the refusal test above on its own.
    expect(() =>
      assertRailOffered(CHAIN_IDS.ROBINHOOD_TESTNET, railName(PaymentRail.RAIL_B_VOUCHER)),
    ).not.toThrow();
  });

  it('and Solana refuses both rails with a 4xx that says only free calls are served', () => {
    for (const rail of [PaymentRail.RAIL_A_PER_CALL, PaymentRail.RAIL_B_VOUCHER]) {
      let thrown: AppError | null = null;
      try {
        assertRailOffered(CHAIN_IDS.SOLANA_DEVNET, railName(rail));
      } catch (error) {
        thrown = error as AppError;
      }
      expect(thrown?.errorCode).toBe(ChainErrorCode.CHAIN_RAIL_NOT_OFFERED);
      expect(thrown?.statusCode).toBe(409);
      expect(thrown?.message).toMatch(/only free calls/);
    }
  });

  it('answers a rail the caller picked with a 4xx, not a server fault', () => {
    // Review 2026-10-15 L1: the agent supplies the rail (`assay/rail`, or a
    // voucher), so a refusal is a client error, not one to page someone for.
    let thrown: AppError | null = null;
    try {
      assertRailOffered(CHAIN_IDS.ROBINHOOD_TESTNET, railName(PaymentRail.RAIL_A_PER_CALL));
    } catch (error) {
      thrown = error as AppError;
    }
    expect(thrown?.statusCode).toBe(409);
  });

  it('refuses a chain with no metadata row at all', () => {
    // `eip155:4663` — Robinhood MAINNET — has no row on purpose: the mainnet
    // USDG address is unmeasured (`docs/chain-facts.md` in assay-evm). A rail check
    // that answered "yes" for an undescribed chain would make that refusal
    // reachable only at boot.
    expect(() =>
      assertRailOffered(CHAIN_IDS.ROBINHOOD_MAINNET, railName(PaymentRail.RAIL_B_VOUCHER)),
    ).toThrow(expect.objectContaining({ errorCode: ChainErrorCode.CHAIN_UNSUPPORTED }));
  });

  /**
   * The mapping between the two vocabularies, pinned in both directions.
   *
   * `PaymentRail` is the payment module's enum and `PaymentRailName` is the
   * chain table's; `assertRailOffered` is only as correct as the translation
   * between them, and a transposed pair would make every check answer about the
   * other rail while still throwing and still passing a "must refuse" test.
   */
  describe('railName', () => {
    it('maps RAIL_A_PER_CALL to A and RAIL_B_VOUCHER to B', () => {
      expect(railName(PaymentRail.RAIL_A_PER_CALL)).toBe('A');
      expect(railName(PaymentRail.RAIL_B_VOUCHER)).toBe('B');
    });

    it('covers every member of the enum', () => {
      // So a third rail is a failing test rather than a silent `undefined` that
      // `rails.includes(undefined)` quietly refuses.
      for (const rail of Object.values(PaymentRail)) {
        expect(['A', 'B']).toContain(railName(rail));
      }
    });
  });
});
