import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';

/**
 * The **build-but-never-sign** half of a provider's stake lifecycle, kept on
 * the far side of the `chains/` boundary.
 *
 * ```text
 * ONCHAIN_STAKE_READER    how much is bonded / unbonding                (read)
 * STAKE_INTENT_BUILDER    an UNSIGNED transaction for the PROVIDER      (build only)
 * ```
 *
 * ## The rule this port exists to make structural
 *
 * **The backend never holds a provider's key and never signs these.** It
 * compiles a transaction whose only required signature is the provider's own,
 * hands back the wire bytes, and the provider's wallet signs. That is not a
 * convention this file asks for politely — it is the reason the port has no
 * `send`, no `submit`, no `signature` and no signer parameter anywhere in its
 * surface. There is nothing here for a future call site to reach for.
 *
 * A provider's stake authority is *theirs*: the settlement program's
 * `withdraw_stake` says so in its own comment — *"Only the provider may take
 * their own stake out. The admin key cannot."* A backend that could sign a
 * `withdraw_stake` would be a backend that could move every provider's
 * collateral, and no amount of care at the call sites would take that
 * capability back off.
 *
 * The one place this port builds a transaction the provider does **not** sign
 * is {@link StakeIntentRequest.funder}: a `deposit_stake` funded by the
 * treasury, which is how an overturned executed judgement is compensated. It is
 * still build-only — the treasury's multisig signs it, never this process.
 *
 * ## Why it is a port and not a call into the client
 *
 * ESLint's chain-SDK ban: `@x402/settlement-client` and `@solana/*` are
 * importable only under `src/modules/chains/`, and `yarn lint` is a gate. So
 * the consuming domain declares the interface and `chains/solana/` supplies the
 * implementation — the arrangement `OnChainStakeReaderPort` already has, for
 * the same rule. Adding EVM stake later is another implementation, not a change
 * here.
 *
 * ## Why it is keyed by account rather than by provider
 *
 * Same answer the read port gives: the chain has never heard of an
 * organization UUID. What it knows is a pubkey, and the mapping from a provider
 * to that pubkey is a database fact `providers.stake_authority` holds and
 * the challenge/prove flow writes. Putting the registry lookup in here
 * would make the builder untestable without a database.
 *
 * ## Failure throws
 *
 * An unreachable RPC, an uninitialised program, a mint that does not match the
 * one `Config` names — all of them throw. There is no degraded answer worth
 * returning: a preflight that reported "0 USDC" because the RPC was down would
 * send a provider to a faucet they do not need, and a transaction built against
 * a guessed mint is a transaction the program rejects after the provider has
 * already paid to submit it. The caller turns the throw into a `503`.
 */

/**
 * The four instructions a provider's own wallet signs, and the whole of the
 * lifecycle they cover.
 *
 * ```text
 * OPEN_STAKE   create the ProviderStake PDA. Rent paid by the PROVIDER.
 * DEPOSIT      move USDC from the provider's token account into the vault.
 * UNSTAKE      start the unbonding clock on part of `bonded`.
 * WITHDRAW     take matured unbonding stake back out.
 * ```
 *
 * `OPEN_STAKE` is first and nothing works without it. `open_stake` is a
 * separate instruction and deliberately **not** `init_if_needed` — the
 * program's own comment is *"an initializer that can run on an existing account
 * is the shape reinitialisation attacks are made of"* — and `deposit_stake`
 * requires an already-existing `Account<'info, ProviderStake>`. Without a path
 * to `open_stake` no provider can ever acquire a stake account at all, which
 * would leave `OnChainProviderStakeSource` finding no PDA for anybody and every
 * provider sitting at `STAKE_UNKNOWN` forever.
 */
export enum StakeIntentKind {
  OPEN_STAKE = 'OPEN_STAKE',
  DEPOSIT = 'DEPOSIT',
  UNSTAKE = 'UNSTAKE',
  WITHDRAW = 'WITHDRAW',
}

export interface StakeIntentRequest {
  readonly kind: StakeIntentKind;
  /** The provider's CAIP-10 stake authority — `providers.stake_authority`. */
  readonly account: AccountId;
  /**
   * The amount the instruction carries, in the stake asset.
   *
   * `null` **only** for {@link StakeIntentKind.OPEN_STAKE}, which carries no
   * amount at all: `open_stake` takes no arguments and moves no tokens. Every
   * other kind requires one, and an implementation refuses rather than
   * defaulting — a stake instruction that silently became a zero would be a
   * transaction the provider signed and paid for that did nothing.
   */
  readonly amount: Money | null;
  /**
   * Who signs and pays, when that is **not** the provider.
   *
   * `null` (or absent) everywhere except one path: a
   * {@link StakeIntentKind.DEPOSIT} whose money comes from the platform
   * treasury rather than from the provider. `deposit_stake` takes a `funder`
   * that need not be the provider, and a deposit can only ever *increase* what
   * the provider owns — which is what makes this safe to expose and is why the
   * program allows it at all. It is how `S-5` compensates a provider whose
   * executed judgement was later overturned, now that `reverse_slash` is gone.
   *
   * The transaction is still built and never signed: the treasury is a
   * multisig, and this process holds none of its keys. The preflight it comes
   * back with describes the **funder's** balances, because the funder is the
   * account that has to have the money and the gas.
   */
  readonly funder?: AccountId | null;
}

/** The scale and identity every stake balance is quoted in. */
export interface StakeAsset {
  /** CAIP-19, derived from `Config.stake_mint` — never from local config. */
  readonly asset: AssetId;
  readonly decimals: number;
}

/**
 * What the stake screen shows **before** a wallet ever opens.
 *
 * The problem is that staking needs USDC on Solana *and* SOL for gas — a
 * second asset and a second problem — and that today the second requirement is
 * discovered at signature time, where many providers abandon with high
 * probability. Everything on this interface exists so the screen can answer
 * "can I do this right now?" without the provider finding out from a failed
 * transaction.
 */
export interface StakeIntentPreflight {
  /** How much of the stake asset this act moves. Zero for every kind but `DEPOSIT`. */
  readonly requiredStakeAsset: Money;
  /**
   * What the provider's own token account holds right now, or `null` when they
   * have no token account for the stake mint at all.
   *
   * `null` is not zero, and the difference is the whole point on this screen: a
   * provider with no ATA needs one created (which the deposit's own transfer
   * cannot do for them), while a provider with an empty one needs USDC. Same
   * "absent is not zero" discipline `GetProviderStakeResponseDto.hasKnownStake`
   * already applies one screen over.
   */
  readonly stakeAssetBalance: Money | null;
  /** The gas budget, in the chain's native asset. See the implementation for the figure. */
  readonly requiredGas: Money;
  /** What the stake authority holds of the native asset right now. */
  readonly gasBalance: Money;
  /** `requiredStakeAsset` is covered by `stakeAssetBalance`. False when the balance is unknown. */
  readonly hasEnoughStakeAsset: boolean;
  /** `requiredGas` is covered by `gasBalance`. */
  readonly hasEnoughGas: boolean;
  /**
   * Always `false`, and typed as the literal so it cannot quietly become true.
   *
   * The platform sponsors gas for an *agent's* x402 payment through the
   * facilitator — a call the agent did not choose to make on a chain
   * they may not hold SOL on. It does not sponsor this, and
   * {@link gasNotSponsoredReason} is why.
   */
  readonly gasSponsored: false;
  /** The one-sentence reason, so the screen prints the platform's reason and not its own. */
  readonly gasNotSponsoredReason: string;
}

/**
 * The bytes a provider's wallet is handed are now
 * {@link import('@modules/chains/ports/unsigned-chain-transaction').UnsignedChainTransaction}
 * — the same union `EscrowIntentBuilderPort` returns and the same one
 * `POST /deposits` describes its requirements with.
 *
 * `UnsignedStakeTransaction` used to be declared here, field for field
 * identical to `UnsignedEscrowTransaction` two modules away. Both were Solana
 * transactions wearing a domain's name: `transactionBase64`, `feePayer`,
 * `signers`, `blockhash`, `lastValidBlockHeight`. Adding EVM to either copy
 * would have meant adding it to both, and the second copy is the one that gets
 * forgotten.
 *
 * The build-but-never-sign rule is unchanged and is the reason this port still
 * has no `send`, no `submit`, no `signature` and no signer parameter: the union
 * describes what to sign, never a signature.
 */

/**
 * What makes a deposit a compensation (review M-3): it was funded by this
 * account (the settlement treasury), and its transaction landed strictly after
 * this instant (the slash's `executed_at`). Deposits by any other funder are
 * not counted, and a transaction at or before `after`, or with no known time,
 * answers `null`. Without these, the provider's own earlier stake deposit
 * passed as the treasury paying them back.
 */
export interface ConfirmedDepositExpectation {
  readonly funder: AccountId;
  readonly after: Date;
}

export interface StakeIntentBuilderPort {
  /**
   * `Config.stake_mint` as a CAIP-19 asset plus its scale.
   *
   * Read from the chain rather than from `PLATFORM_STAKE_ASSET_ID`, because a
   * local copy is a value that can silently disagree with the mint the program
   * will actually accept — and the failure mode of disagreeing is a provider
   * signing a transfer of the wrong token.
   */
  stakeAsset(chain: ChainId): Promise<StakeAsset>;

  /**
   * Whether a provider on this chain must sign {@link StakeIntentKind.OPEN_STAKE}
   * before anything else.
   *
   * `true` on Solana, where the stake is a PDA that `open_stake` has to create
   * and the provider pays rent for. `false` on eip155, where `X402Stake` keys a
   * mapping on the provider's address and the first `depositStake` writes the
   * row — there is no account to open and no transaction that could open one.
   *
   * A property of the chain, stated by the chain's own implementation, so the
   * provider domain never learns which namespaces have accounts.
   */
  needsOpenStake(chain: ChainId): boolean;

  /** {@link StakeIntentPreflight} alone, for the paths that will not build a transaction. */
  preflight(request: StakeIntentRequest): Promise<StakeIntentPreflight>;

  /**
   * What a **confirmed** transaction deposited into one provider's stake, or
   * `null` if it deposited nothing there.
   *
   * The other half of {@link StakeIntentRequest.funder}. This port builds a
   * transaction and never signs it, so the only way it can learn that the
   * treasury's multisig actually signed and landed one is to be handed the
   * signature and go and look. That read is what turns "an operator says they
   * paid the provider back" into a fact the case row is allowed to record.
   *
   * `null` is a first-class answer with three causes that must not be told
   * apart here: the signature is unknown to the cluster, the transaction
   * failed, or it landed but contains no `deposit_stake` against **this**
   * provider's stake account. The caller refuses all three the same way, and
   * distinguishing them would only invite a caller to accept two of them.
   *
   * The amount comes off the instruction's own argument, decoded from the
   * transaction — never from what the caller asked for. A transaction that
   * deposited less than the compensation owed is exactly the case this check
   * exists to catch.
   */
  confirmedDeposit(
    signature: string,
    account: AccountId,
    expected: ConfirmedDepositExpectation,
  ): Promise<Money | null>;

  /**
   * The unsigned transaction, plus the preflight taken in the same pass.
   *
   * Both together because the balances and the blockhash come from one round
   * of RPC calls; a caller that needs only the preflight calls
   * {@link preflight} instead of throwing half the answer away.
   */
  buildIntent(
    request: StakeIntentRequest,
  ): Promise<{ transaction: UnsignedChainTransaction; preflight: StakeIntentPreflight }>;
}

/**
 * Gas is deliberately not sponsored, and the screen says why in one sentence:
 * sponsoring an intentional financial act invites griefing.
 *
 * Held here, in the port, so that the sentence a provider reads and the rule
 * the platform applies cannot drift apart — and so that a second chain
 * implementation states the same reason rather than inventing one.
 */
export const GAS_NOT_SPONSORED_REASON =
  'You pay the network fee yourself: sponsoring an intentional financial act invites griefing.';

/** DI token for the bound {@link StakeIntentBuilderPort}. */
export const STAKE_INTENT_BUILDER = 'STAKE_INTENT_BUILDER';
