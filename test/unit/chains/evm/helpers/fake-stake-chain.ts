import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  recoverAddress,
  toFunctionSelector,
} from 'viem';

import {
  MULTICALL3_ABI,
  X402_STAKE_ABI,
  X402_STAKE_SLASH_ABI,
} from '@modules/chains/evm/abi/x402.abi';
import { evmDomain } from '@modules/chains/evm/eip712/domain';
import { hashSlashAttestation } from '@modules/chains/evm/eip712/slash-attestation';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { EvmSlashClient } from '@modules/chains/evm/evm-slash-executor.service';
import {
  EvmRelayResult,
  EvmRelayedCall,
  EvmRelayerPort,
} from '@modules/chains/evm/ports/evm-relayer.port';
import { AccountId, ChainId, parseAccountId, toAccountId } from '@modules/chains/ports/caip.types';

/**
 * An in-memory `X402Stake` + `Multicall3`, faithful to the parts of
 * `X402Stake.sol` the slash executor relies on:
 *
 * - `proposeSlash` recovers the attestation signer from the EIP-712 digest
 *   and refuses any key that is not the registered verifier; the replay lock
 *   (`SlashAlreadyExists`), `ZeroAmount`, `PenaltyExceedsMaximum`, the
 *   attestation window and the `min(penalty, capAllowance, free)` reservation;
 * - `executeSlash` is permissionless, waits out `executableAt`, pays
 *   `bpsOf(applied, 6000)` to the frozen beneficiary and 3000 bps to the
 *   treasury, and emits `SlashExecuted` with those amounts;
 * - `expireSlash` once the verifier key is revoked or the grace has run;
 * - `aggregate3` with `allowFailure: true`: a failing call is skipped, the
 *   rest commit — and the receipt carries the events of the calls that ran.
 *
 * A revert reaches the caller as an error with the 4-byte selector in `data`,
 * the shape `revertDataOf` reads off `EvmRpcError`.
 */
export const CHAIN: ChainId = 'eip155:46630' as ChainId;
export const STAKE = '0x0aF4D08f97B4FA8Ba3E47Cb025aE8CaD509bc73c' as const;
export const CONFIG = '0xCf6592A3a053d9714D16d176A86fA039Fe7B6a43' as const;
export const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const TREASURY = '0x4246bee428758e8215bA587717d48B8Ef0130388' as const;
export const ADMIN = '0xD9a229c2847929ecAEfc83C17519FCA53Fd20D32' as const;
export const OWNER = '0x7777777777777777777777777777777777777777' as const;
export const FAKE_ARBITER = '0xA4B17E4000000000000000000000000000000001' as const;
export const RELAYER = '0x24A2c5823204150fe1bdc5Ce378A704788B345DB' as const;

export const DEPLOYMENT: EvmDeployment = {
  chainId: CHAIN,
  config: CONFIG,
  stake: STAKE,
  escrow: '0x1D26000000000000000000000000000000000f41',
  asset: '0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3',
  escrowImplementation: '0x1111111111111111111111111111111111111111',
  admin: ADMIN,
  owner: OWNER,
  multicall3: MULTICALL,
};

const SLASH_RECORD_OF = toFunctionSelector('slashRecordOf(bytes32)');
const GRACE = 7n * 86_400n;

interface SlashRecordState {
  provider: `0x${string}`;
  status: number;
  penalty: bigint;
  beneficiary: `0x${string}`;
  proposedAt: bigint;
  verifier: `0x${string}`;
  executableAt: bigint;
  reserved: bigint;
  capAllowance: bigint;
  applied: bigint;
  executedAt: bigint;
  policy: `0x${string}`;
  disputedAt?: bigint;
}

interface Stake {
  bonded: bigint;
  unbonding: bigint;
  pendingSlash: bigint;
  slashedInWindow: bigint;
  slashWindowStartedAt: bigint;
}

/** `Window.decay` — linear over 24 h, rounded up, exactly as `libraries/Window.sol`. */
function decay(counter: bigint, startedAt: bigint, now: bigint): bigint {
  if (counter === 0n) return 0n;
  if (now <= startedAt) return counter;
  const elapsed = now - startedAt;
  if (elapsed >= 86_400n) return 0n;
  return (counter * (86_400n - elapsed) + 86_400n - 1n) / 86_400n;
}

class Revert extends Error {
  constructor(
    readonly name: string,
    readonly data: `0x${string}` = toFunctionSelector(`${name}()`) as `0x${string}`,
  ) {
    super(`reverted ${name}`);
  }
}

interface Log {
  address: string;
  data: `0x${string}`;
  topics: readonly `0x${string}`[];
}

interface State {
  records: Map<string, SlashRecordState>;
  stakes: Map<string, Stake>;
  balances: Map<string, bigint>;
  /** `verifierWindows` — internal on chain; no getter. */
  keyWindow: { slashedInWindow: bigint; windowStartedAt: bigint };
}

export class FakeStakeChain {
  now = 1_791_700_000n;
  verifier: `0x${string}`;
  revoked = false;
  /** Further keys `CONFIG.canSign` accepts (a rotation). `revoked` overrides all. */
  readonly alsoRegistered = new Set<string>();
  params = {
    treasury: TREASURY,
    redeemer: RELAYER,
    unbondingPeriodSeconds: 950_400n,
    minimumStake: 100_000_000n,
    penaltyAmount: 1_000_000n,
    verifierDailyCap: 500_000_000n,
    takeRateBps: 1000,
    slashAgentBps: 6000,
    slashPlatformBps: 3000,
    slashCapBps: 1000,
  };
  state: State = {
    records: new Map(),
    stakes: new Map(),
    balances: new Map(),
    keyWindow: { slashedInWindow: 0n, windowStartedAt: 0n },
  };
  /** Test hooks: make the next N RPCs of a kind fail like a flaky node. */
  failNextCalls = 0;
  failReceipts = new Map<string, number>();
  failNextSends = 0;
  readonly sent: { to: string; data: `0x${string}`; gasLimit: bigint; hash: string }[] = [];
  readonly receipts = new Map<
    string,
    { status: 'success'; blockNumber: bigint; gasUsed: bigint; logs: Log[] }
  >();
  /** The upgraded contracts (D-19) are the only ones the backend supports. */
  slashDelay = 72n * 3600n;
  arbiter: `0x${string}` = FAKE_ARBITER;
  readonly blockedAccounts = new Set<string>();
  /** Test hook: run before a sent transaction is applied (to change state under it). */
  beforeSend: ((data: `0x${string}`) => void) | null = null;

  constructor(verifier: `0x${string}`) {
    this.verifier = getAddress(verifier);
  }

  bond(provider: `0x${string}`, bonded: bigint, unbonding = 0n, pendingSlash = 0n): void {
    this.state.stakes.set(getAddress(provider), {
      bonded,
      unbonding,
      pendingSlash,
      slashedInWindow: 0n,
      slashWindowStartedAt: 0n,
    });
  }

  balanceOf(account: string): bigint {
    return this.state.balances.get(getAddress(account)) ?? 0n;
  }

  record(requestId: string): SlashRecordState | undefined {
    return this.state.records.get(norm(requestId));
  }

  // ── EvmSlashClient ────────────────────────────────────────────────────

  readonly client: EvmSlashClient = {
    readContract: async (args) => {
      return this.read(args.address, args.functionName, args.args);
    },
    call: async (args) => {
      if (this.failNextCalls > 0) {
        this.failNextCalls -= 1;
        throw new Error('EVM RPC eth_call failed: HTTP 503');
      }
      const scratch = cloneState(this.state);
      if (getAddress(args.to) === getAddress(MULTICALL)) {
        const results = this.aggregate(scratch, args.data, []);
        return {
          data: encodeFunctionResult({
            abi: MULTICALL3_ABI,
            functionName: 'aggregate3',
            result: [results] as never,
          }),
        };
      }
      this.apply(scratch, args.data, []);
      return { data: '0x' };
    },
    estimateGas: async (args) => {
      if (getAddress(args.to) === getAddress(MULTICALL)) {
        const { args: callArgs } = decodeFunctionData({ abi: MULTICALL3_ABI, data: args.data });
        return 30_000n + 120_000n * BigInt((callArgs[0] as readonly unknown[]).length);
      }
      return 150_000n;
    },
    getTransactionReceipt: async ({ hash }) => {
      const failures = this.failReceipts.get(hash) ?? 0;
      if (failures > 0) {
        this.failReceipts.set(hash, failures - 1);
        throw new Error('EVM RPC eth_getTransactionReceipt failed: HTTP 503');
      }
      const receipt = this.receipts.get(hash);
      if (!receipt) throw new Error(`no receipt for ${hash}`);
      return receipt;
    },
  };

  // ── EvmRelayerPort ────────────────────────────────────────────────────

  readonly relayer: EvmRelayerPort = {
    name: 'fake-relayer',
    address: async (chainId: ChainId): Promise<AccountId> => toAccountId(chainId, RELAYER),
    balanceWei: async () => 10n ** 18n,
    sendValue: async () => {
      throw new Error('the slash executor never sends value');
    },
    sendCall: async (call: EvmRelayedCall): Promise<EvmRelayResult> => {
      const hash = `0x${(this.sent.length + 1).toString(16).padStart(64, '0')}`;
      const to = parseAccountId(call.to).address;
      if (this.failNextSends > 0) {
        this.failNextSends -= 1;
        throw new Error('EVM RPC eth_sendRawTransaction failed: HTTP 503');
      }
      this.sent.push({ to, data: call.data, gasLimit: call.gasLimit, hash });
      this.beforeSend?.(call.data);
      const logs: Log[] = [];
      const working = cloneState(this.state);
      try {
        if (getAddress(to) === getAddress(MULTICALL)) this.aggregate(working, call.data, logs);
        else this.apply(working, call.data, logs);
      } catch (error) {
        this.receipts.set(hash, { status: 'success', blockNumber: 1n, gasUsed: 21_000n, logs: [] });
        return {
          hash,
          status: 'REVERTED',
          revertReason: (error as Revert).name,
          gasUsed: 21_000n,
          blockNumber: 1n,
        };
      }
      this.state = working;
      const gasUsed =
        getAddress(to) === getAddress(MULTICALL)
          ? 40_000n + 100_000n * BigInt(logs.length)
          : 140_000n;
      this.receipts.set(hash, { status: 'success', blockNumber: 1n, gasUsed, logs });
      return { hash, status: 'SUCCESS', revertReason: null, gasUsed, blockNumber: 1n };
    },
  };

  // ── The contract ──────────────────────────────────────────────────────

  private read(address: string, functionName: string, args: readonly unknown[]): unknown {
    if (functionName === 'params') return { ...this.params };
    if (functionName === 'admin') return ADMIN;
    if (functionName === 'paused') return false;
    if (['slashDelaySeconds', 'arbiter', 'blocked'].includes(functionName)) {
      if (functionName === 'slashDelaySeconds') return this.slashDelay;
      if (functionName === 'arbiter') return this.arbiter;
      return this.blockedAccounts.has(getAddress(args[0] as string));
    }
    if (functionName === 'owner') return OWNER;
    if (functionName === 'canSign') {
      const key = getAddress(args[0] as string);
      return !this.revoked && (key === this.verifier || this.alsoRegistered.has(key));
    }
    if (functionName === 'stakeOf') {
      const stake = this.state.stakes.get(getAddress(args[0] as string)) ?? {
        bonded: 0n,
        unbonding: 0n,
        pendingSlash: 0n,
      };
      return {
        slashedInWindow: 0n,
        slashWindowStartedAt: 0n,
        ...stake,
        unbondingStartedAt: 0n,
        __gap: 0n,
        totalDeposited: 0n,
        totalWithdrawn: 0n,
        totalSlashed: 0n,
      };
    }
    if (functionName === 'slashRecordOf') return this.recordView(this.state, args[0] as string);
    throw new Error(`fake chain cannot read ${address}.${functionName}`);
  }

  private recordView(state: State, requestId: string) {
    const record = state.records.get(norm(requestId));
    return record
      ? { ...record, __gap: 0, __gap2: 0, disputedAt: record.disputedAt ?? 0n }
      : {
          provider: '0x0000000000000000000000000000000000000000',
          status: 0,
          penalty: 0n,
          beneficiary: '0x0000000000000000000000000000000000000000',
          proposedAt: 0n,
          __gap: 0,
          verifier: '0x0000000000000000000000000000000000000000',
          executableAt: 0n,
          __gap2: 0,
          reserved: 0n,
          capAllowance: 0n,
          applied: 0n,
          executedAt: 0n,
          policy: `0x${'00'.repeat(32)}`,
          disputedAt: 0n,
        };
  }

  private aggregate(state: State, data: `0x${string}`, logs: Log[]) {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    const calls = args[0] as readonly {
      target: string;
      allowFailure: boolean;
      callData: `0x${string}`;
    }[];
    return calls.map((call) => {
      const callLogs: Log[] = [];
      const scratch = cloneState(state);
      try {
        if (call.callData.startsWith(SLASH_RECORD_OF)) {
          const { args: readArgs } = decodeFunctionData({
            abi: X402_STAKE_ABI,
            data: call.callData,
          });
          const view = this.recordView(state, readArgs[0] as string);
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: X402_STAKE_ABI,
              functionName: 'slashRecordOf',
              result: view as never,
            }),
          };
        }
        this.apply(scratch, call.callData, callLogs);
        Object.assign(state, scratch);
        logs.push(...callLogs);
        return { success: true, returnData: '0x' as `0x${string}` };
      } catch (error) {
        if (!call.allowFailure) throw error;
        return { success: false, returnData: (error as Revert).data };
      }
    });
  }

  private apply(state: State, data: `0x${string}`, logs: Log[]): void {
    const decoded = decodeFunctionData({ abi: X402_STAKE_SLASH_ABI, data });
    switch (decoded.functionName) {
      case 'proposeSlash':
        return this.propose(
          state,
          decoded.args[0] as never,
          decoded.args[1] as `0x${string}`,
          logs,
        );
      case 'executeSlash':
        return this.execute(state, decoded.args[0] as `0x${string}`, logs);
      case 'expireSlash':
        return this.expire(state, decoded.args[0] as `0x${string}`, logs);
      case 'disputeSlashBatch':
        for (const id of decoded.args[0] as readonly `0x${string}`[]) this.dispute(state, id, logs);
        return;
      default:
        throw new Revert('NotAdmin');
    }
  }

  private propose(
    state: State,
    a: {
      requestId: `0x${string}`;
      provider: `0x${string}`;
      beneficiary: `0x${string}`;
      status: number;
      penalty: bigint;
      policy: `0x${string}`;
      issuedAt: bigint;
      expiresAt: bigint;
    },
    sig: `0x${string}`,
    logs: Log[],
  ): void {
    if (a.penalty === 0n) throw new Revert('ZeroAmount');
    if (BigInt(a.beneficiary) === 0n) throw new Revert('MissingBeneficiary');
    if (a.status !== 3) throw new Revert('StatusDoesNotSlash');
    if (state.records.has(norm(a.requestId))) throw new Revert('SlashAlreadyExists');
    if (a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > GRACE)
      throw new Revert('InvalidAttestationWindow');
    if (a.issuedAt > this.now) throw new Revert('AttestationNotYetValid');
    if (this.now > a.expiresAt) throw new Revert('AttestationExpired');
    // recoverAddress is async in viem; the digest check is done synchronously
    // through the pre-recorded signer map populated by `trustSignature`.
    const digest = hashSlashAttestation(a, evmDomain(CHAIN, STAKE));
    const signer = this.recovered.get(`${digest}:${sig}`);
    if (!signer || this.revoked || getAddress(signer) !== this.verifier) {
      throw new Revert('VerifierNotRegistered');
    }
    if (a.penalty > this.params.penaltyAmount) throw new Revert('PenaltyExceedsMaximum');
    const stake = state.stakes.get(getAddress(a.provider));
    const atRisk = stake ? stake.bonded + stake.unbonding : 0n;
    if (atRisk === 0n) throw new Revert('NothingToSlash');
    const capAllowance = (atRisk * BigInt(this.params.slashCapBps)) / 10_000n;
    const free = atRisk > stake!.pendingSlash ? atRisk - stake!.pendingSlash : 0n;
    let reserved = a.penalty;
    if (reserved > capAllowance) reserved = capAllowance;
    if (reserved > free) reserved = free;
    if (reserved === 0n) throw new Revert('NothingToSlash');
    stake!.pendingSlash += reserved;
    const record: SlashRecordState = {
      provider: getAddress(a.provider),
      status: 1,
      penalty: a.penalty,
      beneficiary: getAddress(a.beneficiary),
      proposedAt: this.now,
      verifier: this.verifier,
      executableAt: this.now + this.slashDelay,
      reserved,
      capAllowance,
      applied: 0n,
      executedAt: 0n,
      policy: a.policy,
    };
    state.records.set(norm(a.requestId), record);
    logs.push(
      event('SlashProposed', {
        requestId: a.requestId,
        provider: record.provider,
        verifier: record.verifier,
        beneficiary: record.beneficiary,
        policy: a.policy,
        penalty: a.penalty,
        reserved,
        capAllowance,
        pendingSlash: stake!.pendingSlash,
        proposedAt: this.now,
        executableAt: record.executableAt,
      }),
    );
  }

  private execute(state: State, requestId: `0x${string}`, logs: Log[]): void {
    const rec = state.records.get(norm(requestId));
    if (!rec || rec.status !== 1) throw new Revert('SlashNotPending');
    if (this.now < rec.executableAt) throw new Revert('SlashNotYetExecutable');
    if (this.now >= rec.executableAt + GRACE) throw new Revert('SlashExecutionWindowClosed');
    if (this.revoked) throw new Revert('VerifierRevoked');
    const stake = state.stakes.get(rec.provider)!;
    // All or wait (assay-evm 9f036a3): `applied == reserved`, or revert while
    // either rolling window cannot take all of it.
    const providerCarried = decay(stake.slashedInWindow, stake.slashWindowStartedAt, this.now);
    const keyCarried = decay(
      state.keyWindow.slashedInWindow,
      state.keyWindow.windowStartedAt,
      this.now,
    );
    const applied = rec.reserved;
    if (
      providerCarried + applied > rec.capAllowance ||
      keyCarried + applied > this.params.verifierDailyCap
    ) {
      throw new Revert('SlashWindowNotDrained');
    }
    const agentAmount = (applied * BigInt(this.params.slashAgentBps)) / 10_000n;
    const platformAmount = (applied * BigInt(this.params.slashPlatformBps)) / 10_000n;
    if (agentAmount + platformAmount === 0n) throw new Revert('PenaltyTooSmallToSplit');
    stake.pendingSlash -= rec.reserved;
    stake.bonded -= agentAmount + platformAmount;
    stake.slashedInWindow = providerCarried + applied;
    stake.slashWindowStartedAt = this.now;
    state.keyWindow = { slashedInWindow: keyCarried + applied, windowStartedAt: this.now };
    rec.applied = applied;
    rec.executedAt = this.now;
    rec.status = 2;
    state.balances.set(rec.beneficiary, (state.balances.get(rec.beneficiary) ?? 0n) + agentAmount);
    state.balances.set(
      getAddress(TREASURY),
      (state.balances.get(getAddress(TREASURY)) ?? 0n) + platformAmount,
    );
    logs.push(
      event('SlashExecuted', {
        requestId,
        provider: rec.provider,
        verifier: rec.verifier,
        beneficiary: rec.beneficiary,
        policy: rec.policy,
        penalty: rec.penalty,
        applied,
        agentAmount,
        platformAmount,
        providerAmount: applied - agentAmount - platformAmount,
        slashAgentBps: this.params.slashAgentBps,
        slashPlatformBps: this.params.slashPlatformBps,
        released: rec.reserved,
        pendingSlash: stake.pendingSlash,
        bonded: stake.bonded,
        unbonding: stake.unbonding,
        executedAt: this.now,
        proposedAt: rec.proposedAt,
      }),
    );
  }

  /** `_dispute` — no sender check here; the intent tests read records, they never send. */
  private dispute(state: State, requestId: `0x${string}`, logs: Log[]): void {
    const rec = state.records.get(norm(requestId));
    if (!rec || rec.status !== 1) throw new Revert('SlashNotPending');
    if (this.now >= rec.executableAt) throw new Revert('DisputeWindowClosed');
    rec.status = 4;
    rec.disputedAt = this.now;
    void logs;
  }

  /** Test hook: put a record in the `Disputed` state, as the provider's `disputeSlash` would. */
  markDisputed(requestId: string, at: bigint = this.now): void {
    const rec = this.state.records.get(norm(requestId));
    if (!rec) throw new Error(`no record ${requestId}`);
    rec.status = 4;
    rec.disputedAt = at;
  }

  /** Test hook: the arbiter's `upholdSlash` — `Pending` again from `executableAt`. */
  markUpheld(requestId: string, executableAt: bigint = this.now): void {
    const rec = this.state.records.get(norm(requestId));
    if (!rec) throw new Error(`no record ${requestId}`);
    rec.status = 1;
    rec.executableAt = executableAt;
  }

  private expire(state: State, requestId: `0x${string}`, logs: Log[]): void {
    const rec = state.records.get(norm(requestId));
    if (!rec || (rec.status !== 1 && rec.status !== 4)) throw new Revert('SlashNotPending');
    const timedOut =
      rec.status === 4
        ? this.now >= (rec.disputedAt ?? 0n) + 30n * 86_400n
        : this.now >= rec.executableAt + GRACE;
    if (!this.revoked && !timedOut) throw new Revert('SlashNotExpired');
    const stake = state.stakes.get(rec.provider)!;
    stake.pendingSlash -= rec.reserved;
    const wasDisputed = rec.status === 4;
    rec.status = 3;
    logs.push(
      event('SlashCancelled', {
        requestId,
        provider: rec.provider,
        reason: this.revoked ? 2 : wasDisputed ? 3 : 1,
        released: rec.reserved,
        pendingSlash: stake.pendingSlash,
        cancelledAt: this.now,
      }),
    );
  }

  /**
   * `ecrecover` stand-in. viem's `recoverAddress` is async and the contract
   * path here is synchronous, so the signer of every attestation the test
   * signer produces is recovered once, for real, and remembered.
   */
  readonly recovered = new Map<string, `0x${string}`>();

  async trustSignature(digest: `0x${string}`, signature: `0x${string}`): Promise<void> {
    this.recovered.set(`${digest}:${signature}`, await recoverAddress({ hash: digest, signature }));
  }
}

function event(
  eventName: 'SlashProposed' | 'SlashExecuted' | 'SlashCancelled',
  args: Record<string, unknown>,
): Log {
  const definition = X402_STAKE_SLASH_ABI.find(
    (entry) => entry.type === 'event' && entry.name === eventName,
  ) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({
    abi: X402_STAKE_SLASH_ABI,
    eventName,
    args: Object.fromEntries(
      definition.inputs
        .filter((input) => input.indexed)
        .map((input) => [input.name, args[input.name]]),
    ) as never,
  }) as `0x${string}`[];
  const data = encodeAbiParameters(
    definition.inputs.filter((input) => !input.indexed) as never,
    definition.inputs.filter((input) => !input.indexed).map((input) => args[input.name]) as never,
  );
  return { address: STAKE, data, topics };
}

function cloneState(state: State): State {
  return {
    records: new Map([...state.records].map(([key, value]) => [key, { ...value }])),
    stakes: new Map([...state.stakes].map(([key, value]) => [key, { ...value }])),
    balances: new Map(state.balances),
    keyWindow: { ...state.keyWindow },
  };
}

function norm(requestId: string): string {
  return (requestId.startsWith('0x') ? requestId.slice(2) : requestId).toLowerCase();
}
