import { decodeFunctionData, getAddress, hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { X402_ESCROW_ABI } from '@modules/chains/evm/abi/x402.abi';
import { evmDomain } from '@modules/chains/evm/eip712/domain';
import { hashAuthorizeDelegate } from '@modules/chains/evm/eip712/delegation';
import {
  EvmEscrowIntentBuilder,
  EvmEscrowIntentClient,
} from '@modules/chains/evm/evm-escrow-intent-builder.service';
import {
  EvmRelayedEscrowIntentSubmitter,
  EvmRelayedIntentClient,
} from '@modules/chains/evm/evm-relayed-escrow-intent.service';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import { EvmRelayerPort, EvmRelayResult } from '@modules/chains/evm/ports/evm-relayer.port';
import { CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import { Eip155TypedDataRequest } from '@modules/chains/ports/unsigned-chain-transaction';
import {
  EscrowDelegationKind,
  EscrowDelegationStatus,
} from '@modules/settlement/ports/escrow-delegation.port';
import { RelayedEscrowIntent } from '@modules/settlement/ports/relayed-escrow-intent.port';

import { deployment } from './evm-fixtures';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);
const payerKey = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const PAYER = payerKey.address;
const PAYER_ACCOUNT = toAccountId(TESTNET, PAYER);
const DELEGATE = getAddress('0x5555555555555555555555555555555555555555');
const DELEGATE_ACCOUNT = toAccountId(TESTNET, DELEGATE);
const RELAYER = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';
const SIGNATURE = `0x${'ab'.repeat(64)}1b`;

const NOW_SECONDS = 1_800_000_000;

const ARMED_ESCROW = {
  balance: 20_000_000n,
  seqHigh: 0n,
  authNonce: 3n,
  maxVoucherAmount: 1_000_000n,
  maxPerWindow: 10_000_000n,
  spentInWindow: 0n,
  windowStartedAt: 0n,
  withdrawRequested: 0n,
  withdrawAvailableAt: 0n,
  totalRedeemed: 0n,
  totalWithdrawn: 0n,
  totalFunded: 20_000_000n,
};

const NO_GRANT = {
  maxVoucherAmount: 0n,
  maxPerWindow: 0n,
  spentInWindow: 0n,
  windowStartedAt: 0n,
  validUntil: 0n,
  listPosition: 0,
  revoked: false,
};

function builderWith(reads: Record<string, (args: readonly unknown[]) => unknown>) {
  const client: EvmEscrowIntentClient = {
    readContract: async (args) => {
      const read = reads[args.functionName];
      if (!read) throw new Error(`unexpected read of ${args.functionName}`);
      return read(args.args);
    },
    getTransactionCount: async () => 0,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 50_000n,
    getBlock: async () => ({ timestamp: BigInt(NOW_SECONDS) }),
  };
  return new EvmEscrowIntentBuilder(
    new Map([[TESTNET, client]]),
    new Map([[TESTNET, DEPLOYMENT]]),
    {
      now: () => NOW_SECONDS * 1000,
    },
  );
}

const TERMS = {
  delegate: DELEGATE_ACCOUNT,
  maxVoucherAmount: 500_000n,
  maxPerWindow: 5_000_000n,
  validUntil: BigInt(NOW_SECONDS + 30 * 86_400),
};

describe('agent payment delegation — the relayed EVM doors', () => {
  describe('EvmEscrowIntentBuilder.authorizeIntent', () => {
    const builder = builderWith({ escrowOf: () => ARMED_ESCROW, delegationOf: () => NO_GRANT });

    it('issues AuthorizeDelegate at the escrow’s authNonce, on the chain’s clock, relayed', async () => {
      const tx = (await builder.authorizeIntent(PAYER_ACCOUNT, TERMS)) as Eip155TypedDataRequest;
      expect(tx).toMatchObject({
        namespace: 'eip155',
        kind: 'typed-data',
        primaryType: 'AuthorizeDelegate',
        relayed: true,
        domain: { name: 'Assay Settlement', version: '2', chainId: '46630' },
      });
      expect(tx.message).toEqual({
        payer: PAYER,
        delegate: DELEGATE,
        maxVoucherAmount: 500_000n,
        maxPerWindow: 5_000_000n,
        validUntil: TERMS.validUntil,
        nonce: 3n,
        deadline: BigInt(NOW_SECONDS + EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS),
      });
    });

    it('is the exact digest the contract will check, and a wallet signature recovers to the payer', async () => {
      const tx = (await builder.authorizeIntent(PAYER_ACCOUNT, TERMS)) as Eip155TypedDataRequest;
      const domain = evmDomain(TESTNET, getAddress(DEPLOYMENT.escrow));
      const typed = {
        domain,
        types: tx.types,
        primaryType: 'AuthorizeDelegate',
        message: tx.message,
      } as unknown as Parameters<typeof hashTypedData>[0];
      expect(hashTypedData(typed)).toBe(hashAuthorizeDelegate(tx.message as never, domain));
      const signature = await payerKey.signTypedData(typed as never);
      expect(await recoverTypedDataAddress({ ...(typed as object), signature } as never)).toBe(
        PAYER,
      );
    });

    it.each([
      ['the payer itself as delegate', { delegate: PAYER_ACCOUNT }, 'DelegateIsPayer'],
      [
        'a delegate on another chain',
        { delegate: toAccountId(CHAIN_IDS.BASE_SEPOLIA, DELEGATE) },
        'address on',
      ],
      ['a zero per-voucher cap', { maxVoucherAmount: 0n }, 'DelegateCapsInvalid'],
      ['a zero window cap', { maxPerWindow: 0n }, 'DelegateCapsInvalid'],
      [
        'a per-voucher cap above the window cap',
        { maxVoucherAmount: 6_000_000n },
        'DelegateCapsInvalid',
      ],
      [
        'a per-voucher cap above the escrow’s',
        { maxVoucherAmount: 1_000_001n },
        'DelegateCapsExceedEscrowLimits',
      ],
      [
        'a window cap above the escrow’s',
        { maxPerWindow: 10_000_001n },
        'DelegateCapsExceedEscrowLimits',
      ],
      ['a horizon in the past', { validUntil: BigInt(NOW_SECONDS) }, 'DelegateValidUntilInvalid'],
      [
        'a horizon more than a year out',
        { validUntil: BigInt(NOW_SECONDS + EVM_CONSTANTS.MAX_DELEGATION_LIFETIME_SECONDS + 1) },
        'DelegateValidUntilInvalid',
      ],
    ])('refuses %s before the payer is asked to sign', async (_name, patch, reason) => {
      await expect(
        builder.authorizeIntent(PAYER_ACCOUNT, { ...TERMS, ...patch }),
      ).rejects.toMatchObject({
        errorCode: 'SETTLEMENT_DELEGATION_INVALID',
        message: expect.stringContaining(reason),
      });
    });

    it('refuses on an unarmed escrow, telling the payer to set limits first', async () => {
      const unarmed = builderWith({
        escrowOf: () => ({ ...ARMED_ESCROW, maxVoucherAmount: 0n, maxPerWindow: 0n }),
        delegationOf: () => NO_GRANT,
      });
      await expect(unarmed.authorizeIntent(PAYER_ACCOUNT, TERMS)).rejects.toMatchObject({
        errorCode: 'SETTLEMENT_DELEGATION_INVALID',
        message: expect.stringContaining('set the escrow limits first'),
      });
    });

    /**
     * "Edit limits" (BUG-D1-04) re-authorises the same key: the contract
     * UPDATES a standing grant (`DelegateUpdated`, window counter kept) and
     * refuses only an identical one (`DelegationUnchanged`), which is refused
     * here first so the payer is not asked to sign it.
     */
    it('builds an update of a standing grant, and refuses an identical one', async () => {
      const standing = {
        ...NO_GRANT,
        maxVoucherAmount: TERMS.maxVoucherAmount,
        maxPerWindow: TERMS.maxPerWindow,
        validUntil: TERMS.validUntil,
        spentInWindow: 1_049_681n,
        listPosition: 1,
      };
      const editing = builderWith({ escrowOf: () => ARMED_ESCROW, delegationOf: () => standing });

      await expect(editing.authorizeIntent(PAYER_ACCOUNT, TERMS)).rejects.toMatchObject({
        errorCode: 'SETTLEMENT_DELEGATION_INVALID',
        message: expect.stringContaining('DelegationUnchanged'),
      });
      const tx = (await editing.authorizeIntent(PAYER_ACCOUNT, {
        ...TERMS,
        maxVoucherAmount: 50_000n,
      })) as Eip155TypedDataRequest;
      expect(tx.primaryType).toBe('AuthorizeDelegate');
      expect(tx.message).toMatchObject({ maxVoucherAmount: 50_000n, nonce: 3n });
    });
  });

  describe('EvmEscrowIntentBuilder.revokeIntent', () => {
    it('issues RevokeDelegate at the authNonce for a listed delegate', async () => {
      const builder = builderWith({
        escrowOf: () => ARMED_ESCROW,
        delegationOf: () => ({ ...NO_GRANT, listPosition: 1, validUntil: 1n }),
      });
      const tx = (await builder.revokeIntent(
        PAYER_ACCOUNT,
        DELEGATE_ACCOUNT,
      )) as Eip155TypedDataRequest;
      expect(tx.primaryType).toBe('RevokeDelegate');
      expect(tx.message).toEqual({
        payer: PAYER,
        delegate: DELEGATE,
        nonce: 3n,
        deadline: BigInt(NOW_SECONDS + EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS),
      });
    });

    it('refuses when there is nothing to revoke', async () => {
      const builder = builderWith({ escrowOf: () => ARMED_ESCROW, delegationOf: () => NO_GRANT });
      await expect(builder.revokeIntent(PAYER_ACCOUNT, DELEGATE_ACCOUNT)).rejects.toMatchObject({
        errorCode: 'SETTLEMENT_DELEGATION_NOT_ACTIVE',
      });
    });
  });

  describe('EvmEscrowIntentBuilder.list', () => {
    it('reads delegatesOf then each delegationOf, decays the window and marks lapsed ones', async () => {
      const other = getAddress('0x6666666666666666666666666666666666666666');
      const builder = builderWith({
        delegatesOf: () => [DELEGATE, other],
        delegationOf: (args) =>
          getAddress(args[1] as string) === DELEGATE
            ? {
                ...NO_GRANT,
                maxVoucherAmount: 400_000n,
                maxPerWindow: 1_000_000n,
                spentInWindow: 600_000n,
                windowStartedAt: BigInt(NOW_SECONDS - EVM_CONSTANTS.SLASH_WINDOW_SECONDS / 2),
                validUntil: BigInt(NOW_SECONDS + 10),
                listPosition: 1,
              }
            : {
                ...NO_GRANT,
                maxVoucherAmount: 1n,
                maxPerWindow: 1n,
                validUntil: BigInt(NOW_SECONDS - 1),
                listPosition: 2,
              },
      });
      expect(await builder.list(PAYER_ACCOUNT)).toEqual([
        {
          delegate: DELEGATE_ACCOUNT,
          maxVoucherAmount: 400_000n,
          maxPerWindow: 1_000_000n,
          spentInWindow: 300_000n,
          validUntil: BigInt(NOW_SECONDS + 10),
          status: EscrowDelegationStatus.ACTIVE,
        },
        {
          delegate: toAccountId(TESTNET, other),
          maxVoucherAmount: 1n,
          maxPerWindow: 1n,
          spentInWindow: 0n,
          validUntil: BigInt(NOW_SECONDS - 1),
          status: EscrowDelegationStatus.EXPIRED,
        },
      ]);
    });
  });

  describe('EvmEscrowIntentBuilder.list failures', () => {
    it('fails on a revert: the backend assumes the upgraded escrow', async () => {
      const builder = builderWith({
        delegatesOf: () => {
          throw Object.assign(new Error('reverted'), {
            name: 'ContractFunctionExecutionError',
            cause: { name: 'ContractFunctionRevertedError' },
          });
        },
      });
      await expect(builder.list(PAYER_ACCOUNT)).rejects.toThrow('reverted');
    });

    it('still fails on an outage', async () => {
      const builder = builderWith({
        delegatesOf: () => {
          throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
        },
      });
      await expect(builder.list(PAYER_ACCOUNT)).rejects.toThrow('fetch failed');
    });
  });

  describe('EvmRelayedEscrowIntentSubmitter', () => {
    function buildSubmitter() {
      const sendCall = jest.fn(
        async (): Promise<EvmRelayResult> => ({
          hash: '0x1e23e27f81ba84a1a27b0b58b3f4dc5049dd54016c734e94549f4951ecc3f6c9',
          status: 'SUCCESS',
          revertReason: null,
          gasUsed: 120_000n,
          blockNumber: 7n,
        }),
      );
      const relayer: EvmRelayerPort = {
        name: 'test-relayer',
        address: async (chainId: ChainId) => toAccountId(chainId, RELAYER),
        balanceWei: async () => 10n ** 18n,
        sendCall: sendCall as unknown as EvmRelayerPort['sendCall'],
        sendValue: jest.fn() as unknown as EvmRelayerPort['sendValue'],
      };
      const client: EvmRelayedIntentClient = { estimateGas: async () => 100_000n };
      return {
        sendCall,
        submitter: new EvmRelayedEscrowIntentSubmitter(
          new Map([[TESTNET, client]]),
          new Map([[TESTNET, DEPLOYMENT]]),
          relayer,
        ),
      };
    }

    it('encodes authorizeDelegateBySig from the session’s payer and the signed fields only', async () => {
      const { submitter, sendCall } = buildSubmitter();
      await submitter.submit({
        kind: EscrowDelegationKind.AUTHORIZE_DELEGATE,
        account: PAYER_ACCOUNT,
        delegate: DELEGATE.toLowerCase(),
        maxVoucherAmount: 500_000n,
        maxPerWindow: 5_000_000n,
        validUntil: 1_900_000_000n,
        nonce: 3n,
        deadline: 1_800_000_300n,
        signature: SIGNATURE,
      } as RelayedEscrowIntent);

      const call = (sendCall.mock.calls[0] as unknown[])[0] as { to: string; data: `0x${string}` };
      expect(call.to).toBe(toAccountId(TESTNET, getAddress(DEPLOYMENT.escrow)));
      const decoded = decodeFunctionData({ abi: X402_ESCROW_ABI, data: call.data });
      expect(decoded.functionName).toBe('authorizeDelegateBySig');
      expect(decoded.args).toEqual([
        PAYER,
        DELEGATE,
        500_000n,
        5_000_000n,
        1_900_000_000n,
        3n,
        1_800_000_300n,
        SIGNATURE,
      ]);
    });

    it('encodes revokeDelegateBySig', async () => {
      const { submitter, sendCall } = buildSubmitter();
      await submitter.submit({
        kind: EscrowDelegationKind.REVOKE_DELEGATE,
        account: PAYER_ACCOUNT,
        delegate: DELEGATE,
        nonce: 4n,
        deadline: 1_800_000_300n,
        signature: SIGNATURE,
      } as RelayedEscrowIntent);
      const call = (sendCall.mock.calls[0] as unknown[])[0] as { data: `0x${string}` };
      const decoded = decodeFunctionData({ abi: X402_ESCROW_ABI, data: call.data });
      expect(decoded.functionName).toBe('revokeDelegateBySig');
      expect(decoded.args).toEqual([PAYER, DELEGATE, 4n, 1_800_000_300n, SIGNATURE]);
    });

    it('refuses a delegate that is not an address, before any RPC', async () => {
      const { submitter, sendCall } = buildSubmitter();
      await expect(
        submitter.submit({
          kind: EscrowDelegationKind.REVOKE_DELEGATE,
          account: PAYER_ACCOUNT,
          delegate: 'not-an-address',
          nonce: 4n,
          deadline: 1n,
          signature: SIGNATURE,
        } as RelayedEscrowIntent),
      ).rejects.toMatchObject({ errorCode: 'SETTLEMENT_RELAYED_INTENT_MALFORMED' });
      expect(sendCall).not.toHaveBeenCalled();
    });
  });
});
