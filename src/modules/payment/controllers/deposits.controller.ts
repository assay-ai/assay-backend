import { Body, Controller, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { TxRef } from '@modules/chains/ports/x402.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { MoneyUtil } from '@shared/utils/money.util';

import { depositAssetFor } from '../domain/deposit-asset';
import {
  assertDepositChainOffersPaidRail,
  resolveDepositChain,
  sessionAccounts,
} from '../domain/deposit-chain';
import { asPayloadChainId } from '../domain/deposit-wire';
import {
  CreateDepositBodyDto,
  CreateDepositResponseDto,
  DEPOSIT_REQUIREMENTS_MODELS,
  BroadcastDepositBodyDto,
  SettleDepositBodyDto,
  SettledDepositDto,
} from '../dto/create-deposit.dto';
import {
  DEPOSIT_REQUIREMENTS_BUILDER,
  DepositRequirementsBuilderPort,
} from '../ports/deposit-requirements.port';
import { DepositService } from '../services/deposit.service';

/**
 * `POST /api/v1/deposits` and `POST /api/v1/deposits/:id/settle`.
 *
 * **The `deposits` prefix is split across two Nest modules on purpose.**
 * `GET /deposits` is `LedgerApiModule`'s (`modules/ledger/controllers/deposits.controller.ts`)
 * because listing is a ledger read; the two writes live here because
 * `DepositService` lives in `payment/` and `PaymentModule` exports it.
 * Nest allows this. A reader grepping for one route will not find the other,
 * so each file names the other — keep both docs in step.
 *
 * ## The two calls
 *
 * ```text
 * POST /deposits          -> intent + everything the browser needs to build the transfer
 *   (the buyer's wallet signs a legacy SPL transfer, leaving the fee-payer slot empty)
 * POST /deposits/:id/settle -> facilitator verifies, signs as fee payer, pays gas, settles
 *   (the ledger is credited for what the chain was OBSERVED to move)
 * ```
 *
 * `DepositService` already implements every step of that and is proved on
 * devnet by `scripts/devnet/deposit.ts`. These two routes are the HTTP surface
 * it never had; they add no engine of their own.
 *
 * ## `POST` on something that writes nothing (the first route)
 *
 * `POST /deposits` persists a `deposit_intents` row, so it is a write —  but
 * it would still be a `POST` if it were not, for the reason
 * `ProviderStakeIntentController` gives: a `GET` is what caches, proxies and
 * browser histories are entitled to keep, and these responses name a
 * particular buyer's deposit.
 *
 * ## Identity
 *
 * `organizationId`, `agentId`, `agentAccount` and `chainId` all come from
 * `@CurrentSession()` — those are four of `CreateDepositInput`'s five fields,
 * and `amount` is the only one a request may supply. A body that could name
 * `agentAccount` would be a body one buyer could point at another buyer's
 * ledger balance.
 */
@ApiTags('Deposits')
// `CreateDepositResponseDto.requirements` is a `oneOf` of `$ref`s, and a `$ref`
// to a class Swagger was never given is a dangling pointer in the emitted
// document — which `yarn openapi:export` reports as a clean exit.
@ApiExtraModels(...DEPOSIT_REQUIREMENTS_MODELS)
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('deposits')
export class DepositsController {
  constructor(
    private readonly deposits: DepositService,
    // The chain-shaped half of this response, behind a token. A blockhash
    // reader used to be injected here directly, which put an RPC read in an
    // HTTP handler and made an SVM primitive a field of a chain-neutral
    // controller. (Its token is not named here either: the whole vocabulary
    // stays inside `chains/solana/`, and
    // `test/unit/architecture/blockhash-stays-in-solana.spec.ts` enforces it.)
    // Both the read and the assembly now live in `chains/solana/`; this
    // controller now knows only that some chain builds the requirements and
    // that the answer is discriminated.
    @Inject(DEPOSIT_REQUIREMENTS_BUILDER)
    private readonly requirementsBuilder: DepositRequirementsBuilderPort,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Open a deposit intent and return everything needed to build the transfer',
    description:
      '`requirements` is a **discriminated union — narrow on `namespace` first**, because the ' +
      "two members describe different transactions. On `solana` it carries the buyer's own " +
      'escrow token account (opened first if it did not already exist), the mint, the ' +
      'fee payer and a **recent blockhash**: the browser builds a legacy SPL transfer from ' +
      'exactly these, signs it as the token owner only, and leaves the fee-payer signature slot ' +
      'empty. (The blockhash is on this response and not inside the x402 requirements on ' +
      'purpose; see `SolanaDepositRequirementsDto`.) On `eip155` it carries a **contract call** ' +
      'and deliberately no destination address: `approve(spender, amount)` on `asset`, then ' +
      '`depositFor(buyer, amount)` on `contract`. A plain ERC-20 transfer into that contract ' +
      'moves the tokens and credits nobody, with no remedy — see `EvmDepositRequirementsDto`.',
  })
  @ApiResponse({ status: 201, type: CreateDepositResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'The amount is not a positive atomic-unit integer, or this buyer can deposit on more ' +
      'than one chain and named none (`PAYMENT_DEPOSIT_CHAIN_REQUIRED`)',
  })
  @ApiResponse({
    status: 409,
    description:
      'This buyer has no linked account on the named chain (`PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED`), ' +
      'the chain offers no paid rail and takes no deposit (`CHAIN_RAIL_NOT_OFFERED`), ' +
      'or had no escrow open and the chain could not confirm opening one',
  })
  @ApiResponse({
    status: 502,
    description: 'The facilitator did not advertise a fee payer or a memo',
  })
  async create(
    @CurrentSession() session: McpSession,
    @Body() body: CreateDepositBodyDto,
  ): Promise<CreateDepositResponseDto> {
    // Which chain, before anything else: inferred while the buyer has one
    // linked account, required once they have two. `sessionAccounts` is the
    // single seam that changes when `agent_accounts` lands.
    const account = resolveDepositChain(sessionAccounts(session), body.chainId);
    // A chain with no paid rail takes no deposit: refused before any escrow work.
    assertDepositChainOffersPaidRail(account.chainId);

    // The asset is not a request field and never will be — a deposit is the
    // chain's DECLARED settlement asset (USDC on the Solana chains, USDG on
    // `eip155:46630`), so it is looked up from the RESOLVED chain rather than
    // the session's. The scale comes from the registry rather than the chain,
    // for the reason `asset-registry.ts` gives: a mint whose on-chain decimals
    // differ from what we registered is a misconfiguration or a spoof, and both
    // are loud.
    const asset = depositAssetFor(account.chainId);
    const { decimals } = getAssetMetadata(asset);

    const { intent, requirements } = await this.deposits.createDeposit({
      organizationId: session.organizationId,
      agentId: session.agentId,
      agentAccount: account.accountId,
      chainId: account.chainId,
      amount: MoneyUtil.of(body.amount, asset, decimals),
    });

    const requirementsDto = await this.requirementsBuilder.build({
      chainId: account.chainId,
      requirements,
      decimals: intent.requestedAmount.decimals,
    });

    return {
      depositId: intent.id,
      expiresAt: intent.expiresAt.toISOString(),
      requirements: requirementsDto,
    };
  }

  @Post(':depositId/settle')
  @ApiOperation({
    summary: 'Hand the signed transaction to the facilitator and credit the ledger',
    description:
      'Verifies the payload is bound to this intent (the memo **is** the deposit id), settles ' +
      'it through the facilitator — which signs as fee payer and pays the gas — and credits ' +
      'the ledger for the amount actually observed on chain, which may exceed what was ' +
      'requested. Idempotent: an already-`SETTLED` intent is returned as-is, with no second ' +
      'facilitator call and no second credit.',
  })
  @ApiResponse({ status: 201, type: SettledDepositDto })
  @ApiResponse({ status: 402, description: 'The intent expired; request a fresh one' })
  @ApiResponse({ status: 404, description: 'No such deposit intent in this organization' })
  @ApiResponse({ status: 409, description: 'A settlement for this intent is already in flight' })
  async settle(
    @CurrentSession() session: McpSession,
    @Param('depositId', ParseUUIDPipe) depositId: string,
    @Body() body: SettleDepositBodyDto,
  ): Promise<SettledDepositDto> {
    // `PaymentPayload.network` is a branded `ChainId`; the body's is a string.
    // Narrowed rather than cast, and deliberately not replaced with the
    // session's chain — `asPayloadChainId` carries the argument.
    const intent = await this.deposits.settleDeposit(session.organizationId, depositId, {
      x402Version: body.x402Version,
      scheme: body.scheme,
      network: asPayloadChainId(body.network),
      payload: body.payload,
    });

    return {
      id: intent.id,
      status: intent.status,
      settledAmount: intent.settledAmount,
      chainTxRef: intent.chainTxRef,
    };
  }

  @Post(':depositId/broadcast')
  @ApiOperation({
    summary: 'Settle a deposit the buyer’s own wallet already broadcast, by its transaction hash',
    description:
      'For wallets that can send a transaction but not sign one without sending it — MetaMask, ' +
      'Rabby and nearly every injected wallet. The buyer sends `approve` and `depositFor` ' +
      'themselves, then posts the `depositFor` hash here. The platform reads the transaction ' +
      'from the chain and credits only an escrow `Deposited` event crediting this intent’s ' +
      'buyer for at least the requested amount; a hash already used by another deposit is ' +
      'refused. Idempotent on an already-`SETTLED` intent. Not offered on chains whose deposits ' +
      'need the platform as fee payer.',
  })
  @ApiResponse({ status: 201, type: SettledDepositDto })
  @ApiResponse({
    status: 400,
    description: 'This chain settles deposits through the facilitator only',
  })
  @ApiResponse({ status: 402, description: 'The intent expired; request a fresh one' })
  @ApiResponse({ status: 409, description: 'The transaction already settled another deposit' })
  @ApiResponse({
    status: 502,
    description: 'No transfer crediting this buyer was found in that transaction',
  })
  async broadcast(
    @CurrentSession() session: McpSession,
    @Param('depositId', ParseUUIDPipe) depositId: string,
    @Body() body: BroadcastDepositBodyDto,
  ): Promise<SettledDepositDto> {
    const intent = await this.deposits.settleDepositByBroadcast(
      session.organizationId,
      depositId,
      body.transactionHash as TxRef,
    );

    return {
      id: intent.id,
      status: intent.status,
      settledAmount: intent.settledAmount,
      chainTxRef: intent.chainTxRef,
    };
  }
}
