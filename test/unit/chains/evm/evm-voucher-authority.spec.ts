import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';

import {
  ERC1271_MAGIC_VALUE,
  EVM_PAYER_CODE_CACHE_MAX_ENTRIES,
  EvmVoucherAuthority,
  EvmVoucherAuthorityClient,
  isRevert,
} from '@modules/chains/evm/evm-voucher-authority';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import { CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import {
  VoucherAuthorityKind,
  VoucherAuthorityRefusal,
} from '@modules/chains/ports/voucher-authority.types';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const ESCROW = '0x1D2625efD87c2fc10b8563f3F0890072845Fcf41' as const;
const NOW = 1_790_000_000;

const payerKey = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const delegateKey = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const strangerKey = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
const WALLET = '0x00000000000000000000000000000000000ca11e' as const;

const DIGEST = keccak256(toBytes('a voucher digest'));

const sign = (account: typeof payerKey) => account.sign({ hash: DIGEST });

interface Grant {
  maxVoucherAmount: bigint;
  maxPerWindow: bigint;
  spentInWindow: bigint;
  windowStartedAt: bigint;
  validUntil: bigint;
  listPosition: number;
  revoked: boolean;
}

const NONE: Grant = {
  maxVoucherAmount: 0n,
  maxPerWindow: 0n,
  spentInWindow: 0n,
  windowStartedAt: 0n,
  validUntil: 0n,
  listPosition: 0,
  revoked: false,
};

const ACTIVE: Grant = {
  maxVoucherAmount: 400_000n,
  maxPerWindow: 1_000_000n,
  spentInWindow: 600_000n,
  windowStartedAt: BigInt(NOW - EVM_CONSTANTS.SLASH_WINDOW_SECONDS / 2),
  validUntil: BigInt(NOW + 3600),
  listPosition: 1,
  revoked: false,
};

function revertError(): Error {
  const inner = Object.assign(new Error('execution reverted'), {
    name: 'ContractFunctionRevertedError',
  });
  return Object.assign(new Error('call reverted'), {
    name: 'ContractFunctionExecutionError',
    cause: inner,
  });
}

function outage(): Error {
  const inner = Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
  return Object.assign(new Error('call failed'), { name: 'CallExecutionError', cause: inner });
}

class FakeChain implements EvmVoucherAuthorityClient {
  grants = new Map<string, Grant>();
  code = new Map<string, `0x${string}`>();
  wallet: 'magic' | 'other' | 'revert' | 'outage' = 'other';
  delegationFails: 'revert' | 'outage' | null = null;
  reads = { delegationOf: 0, getCode: 0, isValidSignature: 0 };

  async getCode({ address }: { address: `0x${string}` }) {
    this.reads.getCode += 1;
    return this.code.get(address.toLowerCase()) ?? undefined;
  }

  async readContract(args: {
    address: `0x${string}`;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown> {
    if (args.functionName === 'delegationOf') {
      this.reads.delegationOf += 1;
      expect(args.address).toBe(ESCROW);
      if (this.delegationFails === 'revert') throw revertError();
      if (this.delegationFails === 'outage') throw outage();
      const [payer, delegate] = args.args as string[];
      return this.grants.get(`${payer.toLowerCase()}:${delegate.toLowerCase()}`) ?? NONE;
    }
    if (args.functionName === 'isValidSignature') {
      this.reads.isValidSignature += 1;
      if (this.wallet === 'revert') throw revertError();
      if (this.wallet === 'outage') throw outage();
      return this.wallet === 'magic' ? ERC1271_MAGIC_VALUE : '0xffffffff';
    }
    throw new Error(`unexpected ${args.functionName}`);
  }

  grant(payer: string, delegate: string, grant: Grant): void {
    this.grants.set(`${payer.toLowerCase()}:${delegate.toLowerCase()}`, grant);
  }
}

describe('EvmVoucherAuthority — X402Escrow._voucherAuthority, off chain', () => {
  let chain: FakeChain;
  let clockMs: number;
  let authority: EvmVoucherAuthority;

  beforeEach(() => {
    chain = new FakeChain();
    clockMs = NOW * 1000;
    authority = new EvmVoucherAuthority(CHAIN, chain, ESCROW, { nowMs: () => clockMs });
  });

  describe('(a) the payer’s own key', () => {
    it('is PAYER, and costs no chain read at all', async () => {
      const answer = await authority.authorize(payerKey.address, DIGEST, await sign(payerKey), NOW);
      expect(answer).toEqual({ kind: VoucherAuthorityKind.PAYER });
      expect(chain.reads).toEqual({ delegationOf: 0, getCode: 0, isValidSignature: 0 });
    });
  });

  describe('(b) a delegate the payer authorised on chain', () => {
    it('is DELEGATE, with the grant and its window decayed to now', async () => {
      chain.grant(payerKey.address, delegateKey.address, ACTIVE);
      const answer = await authority.authorize(
        payerKey.address,
        DIGEST,
        await sign(delegateKey),
        NOW,
      );
      expect(answer).toEqual({
        kind: VoucherAuthorityKind.DELEGATE,
        delegate: toAccountId(CHAIN, delegateKey.address),
        terms: {
          maxVoucherAmount: 400_000n,
          maxPerWindow: 1_000_000n,
          carriedInWindow: 300_000n, // half the window elapsed: ceil(600k / 2)
          validUntil: NOW + 3600,
          redeemGraceSeconds: EVM_CONSTANTS.REDEEM_GRACE_SECONDS,
        },
      });
    });

    it('is valid through validUntil and expired one second after, as the contract decides', async () => {
      chain.grant(payerKey.address, delegateKey.address, ACTIVE);
      const sig = await sign(delegateKey);
      const at = Number(ACTIVE.validUntil);
      expect((await authority.authorize(payerKey.address, DIGEST, sig, at)).kind).toBe(
        VoucherAuthorityKind.DELEGATE,
      );
      expect(await authority.authorize(payerKey.address, DIGEST, sig, at + 1)).toEqual({
        kind: 'REFUSED',
        reason: VoucherAuthorityRefusal.DELEGATE_EXPIRED,
        signer: toAccountId(CHAIN, delegateKey.address),
      });
    });

    it('names a revoked delegate as revoked', async () => {
      chain.grant(payerKey.address, delegateKey.address, { ...ACTIVE, revoked: true });
      expect(
        await authority.authorize(payerKey.address, DIGEST, await sign(delegateKey), NOW),
      ).toEqual({
        kind: 'REFUSED',
        reason: VoucherAuthorityRefusal.DELEGATE_REVOKED,
        signer: toAccountId(CHAIN, delegateKey.address),
      });
    });

    it('refuses a key nobody authorised as NOT_PAYER', async () => {
      expect(
        await authority.authorize(payerKey.address, DIGEST, await sign(strangerKey), NOW),
      ).toEqual({
        kind: 'REFUSED',
        reason: VoucherAuthorityRefusal.NOT_PAYER,
        signer: toAccountId(CHAIN, strangerKey.address),
      });
    });

    it('never lets one payer’s delegate sign for another payer', async () => {
      chain.grant(payerKey.address, delegateKey.address, ACTIVE);
      const answer = await authority.authorize(
        strangerKey.address,
        DIGEST,
        await sign(delegateKey),
        NOW,
      );
      expect(answer).toMatchObject({ kind: 'REFUSED', reason: VoucherAuthorityRefusal.NOT_PAYER });
    });

    it('reads an escrow without the delegation surface (a revert) as having no delegates', async () => {
      chain.delegationFails = 'revert';
      expect(
        await authority.authorize(payerKey.address, DIGEST, await sign(delegateKey), NOW),
      ).toMatchObject({ kind: 'REFUSED', reason: VoucherAuthorityRefusal.NOT_PAYER });
    });

    it('fails CLOSED when the delegation cannot be read', async () => {
      chain.delegationFails = 'outage';
      await expect(
        authority.authorize(payerKey.address, DIGEST, await sign(delegateKey), NOW),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE' });
    });

    /**
     * REGRESSION (review S3-6). The delegation used to be cached for 3 s: a
     * redemption landing inside that window left a stale window counter beside
     * a pending sum that no longer held the redeemed voucher, under-counting the
     * window; and a revocation went unseen. It is read fresh for every decision.
     */
    it('reads the delegation fresh for every decision, so a revocation is seen at once', async () => {
      chain.grant(payerKey.address, delegateKey.address, ACTIVE);
      const sig = await sign(delegateKey);
      expect((await authority.authorize(payerKey.address, DIGEST, sig, NOW)).kind).toBe(
        VoucherAuthorityKind.DELEGATE,
      );
      chain.grant(payerKey.address, delegateKey.address, { ...ACTIVE, revoked: true });
      expect(await authority.authorize(payerKey.address, DIGEST, sig, NOW)).toMatchObject({
        kind: 'REFUSED',
        reason: VoucherAuthorityRefusal.DELEGATE_REVOKED,
      });
      chain.grant(payerKey.address, delegateKey.address, { ...ACTIVE, spentInWindow: 999_999n });
      const fresh = await authority.authorize(payerKey.address, DIGEST, sig, NOW);
      expect(fresh.kind === VoucherAuthorityKind.DELEGATE && fresh.terms.carriedInWindow).toBe(
        500_000n,
      );
      expect(chain.reads.delegationOf).toBe(3);
    });
  });

  describe('(c) the payer’s EIP-1271 wallet', () => {
    beforeEach(() => {
      chain.code.set(WALLET, '0x6080');
    });

    it('is ERC1271 when the wallet answers the magic value', async () => {
      chain.wallet = 'magic';
      expect(await authority.authorize(WALLET, DIGEST, await sign(strangerKey), NOW)).toEqual({
        kind: VoucherAuthorityKind.ERC1271,
      });
    });

    it.each(['other', 'revert'] as const)(
      'refuses when the wallet answers %s, as SignatureChecker does',
      async (mode) => {
        chain.wallet = mode;
        expect(
          await authority.authorize(WALLET, DIGEST, await sign(strangerKey), NOW),
        ).toMatchObject({
          kind: 'REFUSED',
          reason: VoucherAuthorityRefusal.NOT_PAYER,
        });
      },
    );

    it('fails CLOSED when the wallet cannot be asked', async () => {
      chain.wallet = 'outage';
      await expect(
        authority.authorize(WALLET, DIGEST, await sign(strangerKey), NOW),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE' });
    });

    it('with allowErc1271: false, names the wallet path and never asks the wallet', async () => {
      chain.wallet = 'magic';
      expect(
        await authority.authorize(WALLET, DIGEST, await sign(strangerKey), NOW, {
          allowErc1271: false,
        }),
      ).toEqual({
        kind: 'REFUSED',
        reason: VoucherAuthorityRefusal.ERC1271_NOT_ACCEPTED,
        signer: toAccountId(CHAIN, strangerKey.address),
      });
      expect(chain.reads.isValidSignature).toBe(0);
    });

    it('with allowErc1271: false, still accepts the payer’s own key and an active delegate', async () => {
      chain.grant(WALLET, delegateKey.address, ACTIVE);
      expect(
        (
          await authority.authorize(WALLET, DIGEST, await sign(delegateKey), NOW, {
            allowErc1271: false,
          })
        ).kind,
      ).toBe(VoucherAuthorityKind.DELEGATE);
    });

    it('is never asked for a payer without code', async () => {
      chain.wallet = 'magic';
      expect(
        await authority.authorize(strangerKey.address, DIGEST, await sign(delegateKey), NOW),
      ).toMatchObject({ kind: 'REFUSED' });
      expect(chain.reads.isValidSignature).toBe(0);
    });

    it('falls through to the wallet for a revoked delegate, and keeps the revocation as the reason', async () => {
      chain.grant(WALLET, delegateKey.address, { ...ACTIVE, revoked: true });
      chain.wallet = 'other';
      expect(await authority.authorize(WALLET, DIGEST, await sign(delegateKey), NOW)).toMatchObject(
        {
          kind: 'REFUSED',
          reason: VoucherAuthorityRefusal.DELEGATE_REVOKED,
        },
      );
      chain.wallet = 'magic';
      expect(await authority.authorize(WALLET, DIGEST, await sign(delegateKey), NOW)).toEqual({
        kind: VoucherAuthorityKind.ERC1271,
      });
    });

    it('fails CLOSED when the payer’s code cannot be read', async () => {
      const noCode = new EvmVoucherAuthority(
        CHAIN,
        {
          readContract: chain.readContract.bind(chain),
          getCode: async () => Promise.reject(outage()),
        },
        ESCROW,
      );
      await expect(
        noCode.authorize(WALLET, DIGEST, await sign(strangerKey), NOW),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE' });
    });
  });

  describe('signatures that are not 65 bytes', () => {
    it.each(['', '0x', '0x1234', `0x${'00'.repeat(64)}`, `0x${'00'.repeat(66)}`])(
      'refuses %p without a single read',
      async (signature) => {
        chain.code.set(WALLET, '0x6080');
        chain.wallet = 'magic';
        expect(await authority.authorize(WALLET, DIGEST, signature, NOW)).toEqual({
          kind: 'REFUSED',
          reason: VoucherAuthorityRefusal.NOT_PAYER,
          signer: null,
        });
        expect(chain.reads).toEqual({ delegationOf: 0, getCode: 0, isValidSignature: 0 });
      },
    );

    it('treats a malleated (high-s) twin as unrecovered, never as the payer', async () => {
      const sig = await sign(payerKey);
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const s = BigInt(`0x${sig.slice(66, 130)}`);
      const v = parseInt(sig.slice(130, 132), 16);
      const twin = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
      expect(await authority.authorize(payerKey.address, DIGEST, twin, NOW)).toMatchObject({
        kind: 'REFUSED',
        signer: null,
      });
    });
  });

  describe('the payer-code cache', () => {
    it('is bounded: the oldest payer is dropped once the bound is reached (review S3-7)', async () => {
      const sig = await sign(strangerKey);
      for (let i = 0; i <= EVM_PAYER_CODE_CACHE_MAX_ENTRIES; i += 1) {
        const payer = `0x${i.toString(16).padStart(40, '0')}` as `0x${string}`;
        await authority.authorize(payer, DIGEST, sig, NOW, { allowErc1271: false });
      }
      const before = chain.reads.getCode;
      await authority.authorize(`0x${'0'.repeat(40)}`, DIGEST, sig, NOW, { allowErc1271: false });
      expect(chain.reads.getCode).toBe(before + 1);
    });
  });

  describe('isRevert', () => {
    it('tells a contract answer from an outage', () => {
      expect(isRevert(revertError())).toBe(true);
      expect(
        isRevert({
          name: 'ContractFunctionExecutionError',
          cause: { name: 'ContractFunctionZeroDataError' },
        }),
      ).toBe(true);
      expect(isRevert(outage())).toBe(false);
      expect(isRevert(new Error('timeout'))).toBe(false);
    });
  });
});
