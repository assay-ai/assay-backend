import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import {
  DEPOSIT_INTENT_TTL_MS,
  depositIntentTtlMs,
} from '@modules/payment/constants/deposit-intent.constants';
import { DepositIntentService } from '@modules/payment/services/deposit-intent.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { FakeDepositIntentRepository } from './helpers/deposit-harness';

/**
 * The deposit intent lifetime is per chain namespace (BUG-PROD-DEPOSIT-01):
 * Solana keeps its blockhash-bounded 90 s, eip155 gets 10 minutes for the
 * buyer's two wallet prompts.
 */
describe('depositIntentTtlMs', () => {
  it.each([
    ['solana devnet', CHAIN_IDS.SOLANA_DEVNET, 90 * 1000],
    ['solana mainnet', CHAIN_IDS.SOLANA_MAINNET, 90 * 1000],
    ['robinhood testnet', CHAIN_IDS.ROBINHOOD_TESTNET, 10 * 60 * 1000],
    ['base sepolia', CHAIN_IDS.BASE_SEPOLIA, 10 * 60 * 1000],
  ])('%s: %p lives %p ms', (_label, chainId, expected) => {
    expect(depositIntentTtlMs(chainId)).toBe(expected);
  });

  it('keeps Solana inside its blockhash bound and gives EVM the longer window', () => {
    expect(DEPOSIT_INTENT_TTL_MS.solana).toBe(90 * 1000);
    expect(DEPOSIT_INTENT_TTL_MS.eip155).toBe(10 * 60 * 1000);
  });

  it('refuses a namespace with no lifetime rather than guessing one', () => {
    expect(() => depositIntentTtlMs('cosmos:cosmoshub-4' as ChainId)).toThrow(
      /No deposit intent lifetime is defined for chain namespace "cosmos"/,
    );
  });
});

describe('DepositIntentService.create — expiresAt', () => {
  const NOW = new Date('2026-10-25T13:42:58.000Z');

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick'] });
  });
  afterEach(() => jest.useRealTimers());

  function create(
    service: DepositIntentService,
    chainId: ChainId,
    asset: AssetId,
    agentAccount: AccountId,
    expiresAt?: Date,
  ) {
    return service.create({
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount,
      requestedAmount: MoneyUtil.of(5_000_000n, asset, 6),
      chainId,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }

  const SOLANA_ASSET =
    `${CHAIN_IDS.SOLANA_DEVNET}/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` as AssetId;
  const SOLANA_ACCOUNT =
    `${CHAIN_IDS.SOLANA_DEVNET}:AgentPubkey111111111111111111111111111111111` as AccountId;
  const EVM_ASSET =
    `${CHAIN_IDS.ROBINHOOD_TESTNET}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac` as AssetId;
  const EVM_ACCOUNT =
    `${CHAIN_IDS.ROBINHOOD_TESTNET}:0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` as AccountId;

  it('expires a Solana intent 90 s after it is created', async () => {
    const service = new DepositIntentService(new FakeDepositIntentRepository().asRepository());

    const intent = await create(service, CHAIN_IDS.SOLANA_DEVNET, SOLANA_ASSET, SOLANA_ACCOUNT);

    expect(intent.expiresAt.getTime() - NOW.getTime()).toBe(90 * 1000);
  });

  it('expires an EVM intent 10 minutes after it is created', async () => {
    const service = new DepositIntentService(new FakeDepositIntentRepository().asRepository());

    const intent = await create(service, CHAIN_IDS.ROBINHOOD_TESTNET, EVM_ASSET, EVM_ACCOUNT);

    expect(intent.expiresAt.getTime() - NOW.getTime()).toBe(10 * 60 * 1000);
  });

  it('keeps an explicit expiresAt over the chain default', async () => {
    const service = new DepositIntentService(new FakeDepositIntentRepository().asRepository());
    const explicit = new Date(NOW.getTime() + 5_000);

    const intent = await create(
      service,
      CHAIN_IDS.ROBINHOOD_TESTNET,
      EVM_ASSET,
      EVM_ACCOUNT,
      explicit,
    );

    expect(intent.expiresAt).toEqual(explicit);
  });
});
