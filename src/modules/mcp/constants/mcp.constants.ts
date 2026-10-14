/**
 * The `x402/*` vocabulary the MCP surface publishes.
 *
 * These strings are the contract with every agent that has ever read our
 * catalogue. Renaming one is a breaking change to clients we cannot see, so
 * they are constants rather than literals scattered through the builders.
 */

/** The price the agent is quoted, and will be charged, for one call. */
export const X402_PRICE = 'x402/price';
/** `unverified` | `verified` | `guaranteed` — the tool's verification tier. */
export const X402_TIER = 'x402/tier';
/** Whether a failed call costs the agent anything. Always `true` today. */
export const X402_REFUND_ON_FAILURE = 'x402/refundOnFailure';
export const X402_P95_LATENCY_MS = 'x402/p95LatencyMs';
export const X402_QUALITY_RATE = 'x402/qualityRate';

/**
 * `FREE` | `FREEMIUM` | `PAID` — `PricingMode`, as published (free tier).
 *
 * It is published alongside `x402/price`'s own `display: "free"`, which already tells a
 * model "this costs nothing" but not *why it might stop*. `x402/pricingMode`
 * is what lets an agent's model distinguish "always free" from "free until a
 * quota", which `x402/freeQuota` alone cannot: a `FREE` tool with a quota and
 * a `FREEMIUM` tool with a quota carry the same annotation otherwise, and only
 * one of them has a paid path to fall through to when it runs out.
 */
export const X402_PRICING_MODE = 'x402/pricingMode';

/**
 * `{ remaining, limit, resetsAt }` for this agent, on this tool (free tier).
 * Present only on a `FREE`/`FREEMIUM` tool with at least one `ACTIVE`
 * binding; a tool with no free path at all publishes no key rather than a
 * zeroed one, matching `x402/p95LatencyMs`'s "measured vs never measured"
 * rule.
 */
export const X402_FREE_QUOTA = 'x402/freeQuota';

/**
 * The paid path past this tool's free quota (free tier).
 *
 * The natural example points a `FREE`-only preview tool at a
 * genuinely different, fuller paid tool (`"search_web_preview"` →
 * `"search_web"`). Nothing in this catalogue's data model records that
 * pairing — `Tool` and `ToolBinding` carry no field naming a sibling tool —
 * so a `FREE`-only tool publishes no `x402/paidAlternative` at all rather than
 * a fabricated one; see `mcp-catalogue.service.ts`'s `describe()` for where
 * that gap is recorded.
 *
 * A `FREEMIUM` tool is the one case this catalogue *can* answer honestly: past
 * the quota, the paid path is simply **the same tool**, at the price
 * `x402/price` already quotes — that transition with no reconfiguration is
 * `FREEMIUM`'s entire commercial point. So a `FREEMIUM` tool's
 * `x402/paidAlternative` is its own name.
 */
export const X402_PAID_ALTERNATIVE = 'x402/paidAlternative';

/**
 * The platform's own id for the tool.
 *
 * Published even though the tool name would suffice to call it: an MCP tool is
 * addressed by `name`, while every receipt, intent and journal entry references the uuid. An
 * agent reconciling its own spend against `assay_list_receipts` (or against the
 * REST API) has no other way to join the two.
 */
export const X402_TOOL_ID = 'x402/toolId';

/**
 * Every chain a routable binding of this tool could settle on, CAIP-2.
 *
 * Published on **every** listed tool, including as an empty array. It is the
 * caveat that makes a price honest: the catalogue is deliberately NOT filtered
 * to the buyer's own chains — *"hiding it makes the platform look like it lacks
 * the tool"* — so a tool the buyer cannot pay for is listed with a price they
 * cannot use unless something says where it settles. Without this key, the
 * first thing an agent learns about the mismatch is
 * `PAYMENT_NO_SETTLEABLE_CHAIN` on a call it already decided to make.
 *
 * Empty means "no routable binding names a chain", which is a fact. It is
 * published rather than omitted for the opposite reason `x402/p95LatencyMs` is
 * omitted when unmeasured: a missing numeric field reads as zero, but a missing
 * *list* reads as "unconstrained", and unconstrained is the one reading that is
 * never true here.
 */
export const X402_SETTLEMENT_CHAINS = 'x402/settlementChains';

/** The receipt reference returned with every result. */
export const X402_RECEIPT = 'x402/receipt';
/** The machine-readable failure, so an agent can branch instead of parsing prose. */
export const X402_ERROR = 'x402/error';
/** The x402 `PaymentRequired` payload returned to an agent with no balance. */
export const X402_PAYMENT_REQUIRED = 'x402/paymentRequired';

/**
 * Request `_meta` (rail B). `x402/rail: "B"` asks for a voucher requirement on
 * a chain that also offers rail A; on a rail-B-only chain an unpaid call gets
 * one anyway.
 */
export const X402_RAIL = 'x402/rail';
/**
 * Request `_meta` (rail B): `{ voucher, signature, providerId }` — the signed
 * voucher built from an `x402/paymentRequired`, plus the `providerId` that
 * requirement named so the retry is routed to the payee the voucher signs.
 */
export const X402_VOUCHER = 'x402/voucher';

/**
 * Why the price and the receipt are published **twice** — in `annotations` and
 * again in `_meta`.
 *
 * They belong in `annotations`, and that is
 * where they are on the wire. But the MCP specification types `annotations` as
 * a closed object of behavioural hints, and the reference SDK enforces that:
 * its zod schema **strips** every key it does not know before the client sees
 * the result. An agent built on the official SDK would therefore receive a tool
 * list with no prices at all, which is the one failure this feature exists to
 * prevent.
 *
 * `_meta` is specified as an open record and survives that validation, so it is
 * the copy an SDK client actually reads. Both are written because they serve
 * different readers: `annotations` for anything reading raw JSON-RPC or the
 * published catalogue, `_meta` for the SDKs.
 *
 * Verified against `@modelcontextprotocol/sdk` 1.30.0 — `ToolSchema.annotations`
 * is `$strip`, `ToolSchema._meta` is `Record<string, unknown>`. Do not "clean
 * this up" by dropping either copy without re-checking that both are still
 * true.
 *
 * `McpCatalogueService`'s `describe()` copies the whole `annotations` object
 * into `_meta` (`_meta: { ...annotations }`) rather than this array driving
 * the copy — this list documents *which* keys the duplication exists for and
 * is what `mcp-catalogue.spec.ts` asserts against, so a key added to
 * `annotations` without a line here is a key nobody has confirmed still
 * survives the SDK. `x402/pricingMode`, `x402/freeQuota` and
 * `x402/paidAlternative` are on this list for that reason,
 * even though the copy that saves them is unconditional today.
 */
export const DUPLICATED_INTO_META = [
  X402_PRICE,
  X402_TIER,
  X402_TOOL_ID,
  X402_SETTLEMENT_CHAINS,
  X402_PRICING_MODE,
  X402_FREE_QUOTA,
  X402_PAID_ALTERNATIVE,
] as const;

/** Written to `status_reason` when the MCP server hands a call to the router. */
export const MCP_FORWARDED_REASON = 'mcp: forwarded to the provider router';

/**
 * Written to `status_reason` on `PROVIDER_EXECUTING → VERIFYING` for a
 * `DATA_RESULT` handed to the asynchronous verification worker.
 * Greppable, so every intent forwarded this way is findable independent of
 * which verdict the worker eventually reaches.
 */
export const MCP_FORWARDED_TO_VERIFICATION_REASON = 'mcp: forwarded to asynchronous verification';

/**
 * Written to `status_reason` on `VERIFYING → REFUNDED` when a `DATA_RESULT`'s
 * payload did not survive the tool's own `outputSchema`.
 *
 * Refunded synchronously rather than handed to the worker: the schema layer
 * — the deterministic rules, which run on every call — already decided
 * this one inside `mapResponse`. See the doc comment on
 * `McpToolCallService.resolveDataResult`.
 */
export const MCP_SCHEMA_CONTRACT_VIOLATION_REASON =
  'mcp: refunded — the provider response failed the tool outputSchema';

/** Written when the provider's outcome earns no charge. */
export const MCP_VOIDED_REASON = 'mcp: provider outcome was not a DATA_RESULT';

/** Written when nothing could be routed, so no provider outcome exists at all. */
export const MCP_UNROUTABLE_REASON = 'mcp: no provider outcome — the call never reached one';

/**
 * Written when failover exhausted every provider and each one dialled answered
 * `SYSTEM_ERROR`. Its own reason rather than {@link MCP_UNROUTABLE_REASON}: the
 * call did reach providers, and the row names the last one tried.
 */
export const MCP_ALL_PROVIDERS_FAILED_REASON =
  'mcp: voided — every provider tried returned SYSTEM_ERROR';

/**
 * Written on `PROVIDER_EXECUTING → VOIDED` when the call was served correctly
 * but by a provider the platform cannot pay.
 *
 * Its own reason rather than `MCP_VOIDED_REASON`, because the two describe
 * opposite situations and one of them is a defect worth counting: the ordinary
 * void is *"the provider's outcome earns no charge"*, and this is *"the outcome
 * earned a charge and we cannot collect it"*. Greppable, so the size of the
 * free-binding-on-a-paid-tool hole is a query rather than an estimate.
 */
export const MCP_UNPAYABLE_PROVIDER_REASON =
  'mcp: voided — the serving provider has no proved payout account';

/** `Authorization: Bearer <token>` — the only credential the server accepts. */
export const MCP_BEARER_PREFIX = 'Bearer ';
