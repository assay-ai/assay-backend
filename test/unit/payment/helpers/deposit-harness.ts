import { DepositIntentEntity } from '@database/postgres/entities/deposit-intent.entity';
import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import {
  BuyerEscrowRepository,
  OpenedEscrow,
} from '@database/postgres/repositories/buyer-escrow.repository';
import { CHAIN_IDS, parseAccountId } from '@modules/chains/ports/caip.types';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { BuildRequirementsInput, PaymentRequirements } from '@modules/chains/ports/x402.types';
import { FacilitatorPort } from '@modules/chains/ports/facilitator.port';
import { VaultPort } from '@modules/chains/ports/vault.port';
import { EscrowBalanceReaderPort } from '@modules/ledger/ports/escrow-balance-reader.port';
import { EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';
import { LedgerService } from '@modules/ledger/services/ledger.service';

/**
 * An in-memory stand-in for `DepositIntentRepository`, implementing exactly
 * the three methods `DepositIntentService` calls on it. Real
 * `DepositIntentService`, real transition table, no database — the
 * lifecycle logic under test is `DepositService`'s orchestration, and this
 * is what lets the state machine behave faithfully (a compare-and-swap that
 * actually compares) without a Postgres connection.
 */
export class FakeDepositIntentRepository {
  readonly rows = new Map<string, DepositIntentEntity>();

  async insert(row: Partial<DepositIntentEntity>): Promise<{ identifiers: [{ id: string }] }> {
    this.rows.set(row.id as string, { ...row } as DepositIntentEntity);
    return { identifiers: [{ id: row.id as string }] };
  }

  async findOneBy(
    where: { organizationId: string } & Partial<DepositIntentEntity>,
  ): Promise<DepositIntentEntity | null> {
    // Every key given must match, as TypeORM's `findOneBy` does — a fake that
    // matched on `id` alone would answer a `chainTxRef` lookup with nothing.
    const match = [...this.rows.values()].find((row) =>
      Object.entries(where).every(
        ([key, value]) => row[key as keyof DepositIntentEntity] === value,
      ),
    );
    return match ?? null;
  }

  async transitionIfInStatus(
    organizationId: string,
    id: string,
    from: string,
    to: string,
    patch: Partial<DepositIntentEntity>,
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.organizationId !== organizationId || row.status !== from) {
      return 0;
    }
    Object.assign(row, patch, { status: to });
    return 1;
  }

  asRepository(): DepositIntentRepository {
    return this as unknown as DepositIntentRepository;
  }
}

/**
 * An in-memory stand-in for `BuyerEscrowRepository`, implementing exactly the
 * two methods `DepositService.ensureEscrow` calls: `findByAccount` (has this
 * buyer's escrow already been opened?) and `upsertOpened` (record one that
 * was). `.rows` is a plain array, not the real repository's Postgres-backed
 * shape, so a test can assert on it directly.
 */
export class FakeBuyerEscrowRepository {
  readonly rows: (OpenedEscrow & { id: string })[] = [];

  async findByAccount(
    organizationId: string,
    accountId: string,
  ): Promise<{ escrowAccountId: string; escrowAssetAccountId: string } | null> {
    return (
      this.rows.find(
        (row) => row.organizationId === organizationId && row.accountId === accountId,
      ) ?? null
    );
  }

  /**
   * Mirrors the real `ON CONFLICT ("account_id") DO UPDATE … WHERE
   * organization_id = EXCLUDED.organization_id`: a row owned by another
   * organization is left untouched and the answer is `null`. A fake that
   * overwrote it would pass tests the SQL fails.
   */
  async upsertOpened(row: OpenedEscrow): Promise<(OpenedEscrow & { id: string }) | null> {
    const existingIndex = this.rows.findIndex((r) => r.accountId === row.accountId);
    if (existingIndex >= 0 && this.rows[existingIndex].organizationId !== row.organizationId) {
      return null;
    }
    const next = {
      ...row,
      id: existingIndex >= 0 ? this.rows[existingIndex].id : `escrow-${this.rows.length + 1}`,
    };
    if (existingIndex >= 0) {
      this.rows[existingIndex] = next;
    } else {
      this.rows.push(next);
    }
    return next;
  }

  asRepository(): BuyerEscrowRepository {
    return this as unknown as BuyerEscrowRepository;
  }
}

export function fakeEscrowOpener(overrides: Partial<EscrowOpenerPort> = {}): EscrowOpenerPort {
  return {
    open: jest.fn().mockResolvedValue({
      escrowPda:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:EscrowPda11111111111111111111111111111111',
      escrowTokenAccount:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:EscrowTokenAccount1111111111111111111111111',
      signature: 'OpenEscrowSignature1111111111111111111111111111111111111111111111111111111',
    }),
    ...overrides,
  };
}

export function fakeEscrowBalanceReader(
  overrides: Partial<EscrowBalanceReaderPort> = {},
): EscrowBalanceReaderPort {
  return {
    read: jest.fn(),
    readMany: jest.fn(),
    escrowAddresses: jest.fn().mockResolvedValue({
      escrowPda:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:EscrowPda11111111111111111111111111111111',
      escrowTokenAccount:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:EscrowTokenAccount1111111111111111111111111',
    }),
    ...overrides,
  } as EscrowBalanceReaderPort;
}

export function fakeChainAdapter(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    namespace: 'solana' as ChainAdapter['namespace'],
    supportedChains: [],
    // Solana's answer, because that is the chain this fake stands in for. A
    // test that wants the EVM shape overrides it — and a fake that defaulted to
    // `false` would let `resolveRequirementDeps` stop calling the facilitator
    // without any of the fee-payer assertions here noticing.
    requiresFeePayer: true,
    isValidAddress: jest.fn(),
    toAccountId: jest.fn(),
    parseAccountId: jest.fn(),
    /**
     * `payTo` is ECHOED from the input, not hardcoded.
     *
     * It used to be the constant `'EscrowTokenAccount111…'`, which made
     * `expect(requirements.payTo).toBe(…)` an assertion about this mock rather
     * than about `DepositService`: the service could have passed the pooled
     * vault, the escrow owner, or nothing at all and the test would still have
     * been green. Swapping the two mapped fields in `ensureEscrow` was
     * invisible for exactly this reason. A real adapter derives the ATA from
     * `payTo` unless `payToIsTokenAccount`, and this fake reproduces that much:
     * whatever address the service decided on comes back out.
     */
    buildPaymentRequirements: jest.fn(
      (input: BuildRequirementsInput): Promise<PaymentRequirements> =>
        Promise.resolve({
          scheme: 'exact' as const,
          network: CHAIN_IDS.SOLANA_DEVNET,
          amount: '5000000',
          asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          payTo: parseAccountId(input.payTo).address,
          resource: 'deposit:test',
          maxTimeoutSeconds: 60,
          extra: { feePayer: 'FeePayer111111111111111111111111111111111', memo: 'test' },
        }),
    ),
    assertPayloadBoundToIntent: jest.fn(),
    extractSettledAmount: jest.fn(),
    observeTransfer: jest.fn(),
    buildVoucherMessage: jest.fn(),
    verifyVoucherSignature: jest.fn(),
    voucherResourceHash: jest.fn(),
    buildPayoutProofMessage: jest.fn(),
    payoutProofTypedData: jest.fn(),
    verifyPayoutProofSignature: jest.fn(),
    buildStakeAuthorityMessage: jest.fn(),
    stakeAuthorityTypedData: jest.fn(),
    verifyStakeAuthoritySignature: jest.fn(),
    getVaultAccount: jest.fn(),
    getVaultBalance: jest.fn(),
    ...overrides,
  };
}

export function fakeFacilitator(overrides: Partial<FacilitatorPort> = {}): FacilitatorPort {
  return {
    name: 'fake',
    supports: jest.fn().mockResolvedValue(true),
    verify: jest.fn().mockResolvedValue({ isValid: true }),
    settle: jest.fn(),
    getFeePayer: jest
      .fn()
      .mockResolvedValue(
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:FeePayer111111111111111111111111111111111',
      ),
    ...overrides,
  };
}

/**
 * Kept for the one assertion that documents an invariant rather than exercises
 * a dependency: `DepositService` no longer takes a `VaultPort` at all
 * (deposits point at the buyer's own escrow, never the pooled vault), so
 * this fake is never wired into the service under test. A spec still builds
 * one and asserts `getVaultOwner` was never called, as a regression guard a
 * reader can find without knowing the constructor changed.
 */
export function fakeVaultPort(overrides: Partial<VaultPort> = {}): VaultPort {
  return {
    getVaultOwner: jest
      .fn()
      .mockResolvedValue(
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:VaultOwner11111111111111111111111111111111',
      ),
    getVaultAccount: jest.fn(),
    getVaultBalance: jest.fn(),
    getVaultBalanceAt: jest.fn(),
    assertVaultControl: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function fakeLedger(overrides: Partial<LedgerService> = {}): LedgerService {
  return {
    append: jest.fn(),
    appendNow: jest.fn(),
    flush: jest.fn(),
    readJournal: jest.fn().mockResolvedValue([]),
    getBalance: jest.fn(),
    rebuildBalance: jest.fn(),
    verifySnapshots: jest.fn(),
    createHold: jest.fn(),
    releaseHold: jest.fn(),
    commitHold: jest.fn(),
    getHold: jest.fn(),
    ...overrides,
  } as unknown as LedgerService;
}
