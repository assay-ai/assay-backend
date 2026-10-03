import { createHash } from 'node:crypto';

import { CanonicalJsonError, canonicalJson } from '@shared/crypto/canonical-json';

import { AssetId } from '@modules/chains/ports/caip.types';

import { PaymentErrors } from '../errors/payment.errors';

/**
 * `requestHash` — the field that makes a voucher pay for **one** call.
 *
 * A signature only proves the agent signed *some* struct. It says nothing about
 * whether that struct describes the request we are about to execute. The hash is
 * what closes the gap: it is computed here, from the request as the server
 * actually received it, and compared against the value inside the signed
 * voucher. Anything covered by the hash therefore cannot be altered after
 * signing without invalidating the voucher.
 *
 * ## What is in the hash, and why
 *
 * The rule is: **everything that changes what is bought or what it costs**.
 * This is the payment-binding field list with the reasoning attached.
 *
 * | Field | Why it is in |
 * |---|---|
 * | `method` | `GET /x` and `DELETE /x` are different acts against the provider |
 * | `path` | The resource being called. The whole point of the binding |
 * | `query` | Carries the parameters of most GET-shaped tools — the filter, the symbol, the date range. A voucher for `?rows=1` must not pay for `?rows=100000` |
 * | `body` | Same, for POST-shaped tools. This is where an inference prompt lives |
 * | `toolId` | Two tools can proxy the same upstream path at different prices; the tool is what was priced |
 * | `providerId` | The same tool served by a different provider is a different purchase — different payee, different quality history, different stake at risk |
 * | `amount` | The price quoted at `402` time. Without it a voucher signed against a $0.001 quote settles a re-quoted $1.00 call |
 * | `asset` | `"1000000"` is 1 USDC or 0.001 of a 9-decimal token. An amount without its asset is not a price |
 *
 * ## What is deliberately left out, and why
 *
 * - **Transport headers** — authorization, trace ids, `User-Agent`,
 *   `Content-Length`. They change between the agent signing and us receiving
 *   (proxies rewrite them) without changing what is bought. Hashing them would
 *   turn every retry through a different edge node into a binding failure.
 * - **Timestamps and retry counters** — same reason, and the voucher already
 *   carries its own `expiresAt`.
 * - **`nonce`, `expiresAt`, `payer`, `payTo`, `resource`** — these are voucher
 *   fields, not request fields. They are inside the *signature* already and are
 *   checked field-by-field by `VoucherService`. Hashing them here would bind
 *   them twice and hide which check actually failed.
 *
 * ## Canonicalisation
 *
 * The hash is over a canonical serialisation, not over `JSON.stringify` of
 * whatever object the caller happened to build: key order in JavaScript objects
 * follows insertion order, so the same request assembled by two code paths
 * would otherwise hash differently and reject a perfectly good voucher.
 */

/** The HTTP call a voucher pays for, as the server received it. */
export interface RequestCall {
  /** Case-insensitive; normalised to upper case before hashing. */
  readonly method: string;
  /** Path only — no scheme, host or query string. */
  readonly path: string;
  /** Parsed query parameters, or `null` when there are none. */
  readonly query: unknown;
  /** Parsed JSON body, or `null` when there is none. */
  readonly body: unknown;
}

/** The full pre-image: the call, plus what it costs and who serves it. */
export interface RequestHashInput extends RequestCall {
  readonly toolId: string;
  readonly providerId: string;
  /** Atomic units, as a decimal string — `Money.amount`. */
  readonly amount: string;
  /** CAIP-19 — `Money.asset`. */
  readonly asset: AssetId;
}

/** Self-describing so a stored hash names the algorithm that produced it. */
export const REQUEST_HASH_PREFIX = 'sha256:';

/**
 * `canonicalJson`, with its refusals translated into this module's catalog.
 *
 * The serialiser is shared (`@shared/crypto/canonical-json`) and throws a
 * shared error; a caller that let that error escape would answer a bad voucher
 * pre-image with a 500 instead of `PAYMENT_REQUEST_NOT_CANONICALISABLE`. The
 * `path` and `reason` are carried across unchanged, so the message a client
 * sees is the message it saw before the move.
 */
function canonicalPreImage(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw PaymentErrors.requestNotCanonicalisable({ path: error.path, reason: error.reason });
    }
    throw error;
  }
}

/** Re-exported: `canonicalJson` moved to `shared/` and has two users now. */
export { canonicalJson } from '@shared/crypto/canonical-json';

/** `sha256:` followed by 64 lower-case hex digits. */
export const REQUEST_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function computeRequestHash(input: RequestHashInput): string {
  // Field order here is irrelevant — `canonicalJson` sorts — but the *set* is
  // the contract. Adding a field to it invalidates every voucher signed under
  // the old set, which is the correct behaviour and the reason the set is
  // documented above rather than inferred from this literal.
  //
  // **Every mandatory field is asserted present, and that is not defensive
  // noise.** `canonicalJson` drops properties whose value is `undefined`,
  // because that is what JSON transport does — correct for anything inside
  // `body` or `query`, and catastrophic here. A missing `path` would not fail:
  // the key would simply vanish from the pre-image, every path would hash the
  // same, and one voucher would authorise the whole tool. The six fixed fields
  // must therefore fail *closed*, which the filter cannot do for them.
  //
  // The failure mode is not hypothetical: the platform is MCP-first, and an MCP
  // tool call has no HTTP method or path of its own. Whoever wires the caller
  // has to invent them, and inventing `undefined` is one keystroke away.
  const canonical = canonicalPreImage({
    method: normaliseMethod(input.method),
    path: requireField(input.path, 'path'),
    // `query` and `body` are genuinely optional — a GET with no parameters has
    // neither — so they normalise to `null`, which is a value in the pre-image
    // rather than an absence from it.
    query: input.query ?? null,
    body: input.body ?? null,
    toolId: requireField(input.toolId, 'toolId'),
    providerId: requireField(input.providerId, 'providerId'),
    amount: requireField(input.amount, 'amount'),
    asset: requireField(input.asset, 'asset'),
  });

  return REQUEST_HASH_PREFIX + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The pre-image for a call the **platform** routes (the MCP server).
 *
 * Identical to {@link RequestHashInput} minus `providerId`, and the omission is
 * the whole point rather than a relaxation.
 *
 * An MCP agent calls `get_weather`. It does not choose a provider, is not shown
 * one, and — because a `SYSTEM_ERROR` fails over — cannot be told one in
 * advance even in principle: the operator that answers may be the third one
 * tried. What the agent authorises is *this tool, these arguments, at this
 * price*, and that is exactly the field set below. Binding a provider into it
 * would bind a value the agent never agreed to and the platform does not know
 * yet.
 *
 * ## Why this is a second function and not an optional field
 *
 * `computeRequestHash` fails closed on every mandatory field precisely because
 * a field that quietly vanishes from the pre-image widens what one signature
 * authorises. Making `providerId` optional there would put that widening one
 * forgotten property away, on the function whose entire job is to stop it. Two
 * named functions make the choice explicit at every call site, and the
 * `scheme` discriminator below makes the two pre-images impossible to confuse:
 * a routed-call digest can never equal a provider-bound digest, so neither can
 * be presented in place of the other.
 *
 * ## What this does not yet secure
 *
 * Nothing signs this hash today. The MCP server has no wallet and no session
 * signer, so the MCP path spends the agent's ledger balance on the strength of
 * its bearer token, and this digest is a record of what the balance was spent
 * on rather than an authorisation of it. When rail B reaches MCP, the voucher
 * signed over this pre-image is what makes it one — and the field set is
 * settled now, while no signature depends on it, for the reason `SignedVoucher`
 * gives: a field added later is a field every already-signed voucher lacks.
 */
export interface RoutedCallHashInput extends RequestCall {
  readonly toolId: string;
  /** Atomic units, as a decimal string — `Money.amount`. The quoted price. */
  readonly amount: string;
  /** CAIP-19 — `Money.asset`. */
  readonly asset: AssetId;
}

/**
 * Domain separation between the two pre-images.
 *
 * Present in the routed-call pre-image and absent from the provider-bound one,
 * so that no `{method, path, query, body, toolId, amount, asset}` can hash to
 * the same digest under both. Versioned because changing the field set later
 * must produce different digests rather than silently re-interpreting stored
 * ones.
 */
export const ROUTED_CALL_HASH_SCHEME = 'x402/routed-call/v1';

export function computeRoutedCallHash(input: RoutedCallHashInput): string {
  const canonical = canonicalPreImage({
    scheme: ROUTED_CALL_HASH_SCHEME,
    method: normaliseMethod(input.method),
    path: requireField(input.path, 'path'),
    query: input.query ?? null,
    body: input.body ?? null,
    toolId: requireField(input.toolId, 'toolId'),
    amount: requireField(input.amount, 'amount'),
    asset: requireField(input.asset, 'asset'),
  });

  return REQUEST_HASH_PREFIX + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * A mandatory field of the pre-image: present, a string, and non-empty.
 *
 * Absence is an error rather than a default, because every default here is a
 * field silently removed from the binding.
 */
function requireField(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw PaymentErrors.requestNotCanonicalisable({ path: `$.${field}`, reason: 'missing' });
  }
  return value;
}

/**
 * HTTP methods are case-sensitive in RFC 9110 but are upper case everywhere in
 * practice. Normalising means an agent that signed over `"get"` and a framework
 * that hands us `"GET"` agree, instead of producing a binding failure that
 * looks like an attack.
 *
 * ASCII letters only, checked *before* the fold. `toUpperCase` is many-to-one
 * over Unicode — `"POſT"` and `"POST"` fold to the same string — so an
 * unrestricted method would let two different values share one digest. HTTP
 * method tokens are ASCII anyway; restricting to them removes the collision
 * rather than reasoning about which of its cases are reachable.
 */
function normaliseMethod(method: string): string {
  if (typeof method !== 'string' || !HTTP_METHOD_RE.test(method)) {
    throw PaymentErrors.requestNotCanonicalisable({
      path: '$.method',
      reason: 'not an ASCII method token',
    });
  }
  return method.toUpperCase();
}

const HTTP_METHOD_RE = /^[A-Za-z]{1,20}$/;
