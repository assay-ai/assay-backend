# Provider request authentication: credential vault and request signing

**Status:** accepted
**Date:** 2026-10-18

The platform calls a provider's HTTP endpoint on behalf of an agent. Until now it could
neither give the endpoint a credential the provider owns, nor let the endpoint tell that a
request really came from the platform; an IP allowlist was the only (weak) answer. This
record covers what replaced it.

## Decision

### 1. Credential vault

Provider credentials are stored envelope-encrypted in `binding_credentials`, one set per
`(binding, origin)`; an origin is `new URL(endpoint).origin`.

- Each set is a JSON list of headers, encrypted with a fresh AES-256-GCM data key (DEK).
- The DEK is wrapped with AES-256-GCM under a key-encryption key (KEK) from the environment
  variable `CREDENTIAL_VAULT_KEKS` (JSON array of `{keyId, key}`, 64 hex chars; the first
  entry is active). The variable is read once at boot and removed from `process.env`.
  Moving the KEK to a KMS later changes only where `wrapped_dek` is wrapped.
- The additional authenticated data is `assay/binding-credentials/v1/<organizationId>/<bindingId>/<origin>`
  for both the DEK wrap and the payload, so a row copied to another organization, binding or
  origin does not open.
- The API is write-only: `GET/PUT/DELETE providers/me/tool-bindings/:id/credentials`. Reads
  return header names and a hint (last 4 characters, only when the value is at least 16
  characters). A PUT's origin must be the draft endpoint's or the published revision's;
  publishing prunes sets for origins no longer in use. The binding detail carries
  `publishedEndpoint`.
- A row that cannot be opened (KEK not loaded, authentication failure) makes the call fail
  closed with `credentialVaultUnavailable`, never an unauthenticated call.

### 2. Validation

A mapping is rejected when it contains a credential-like query key (`key`, `api_key`,
`token`, `secret`, `password`, `signature`, ...; case-insensitive, `-` read as `_`) or a
constant header that looks like a secret (`authorization`, `cookie`, `x-api-key`, ...).
Credential header names must be RFC 9110 tokens and may not be reserved (`host`,
`content-length`, `signature`, anything `x-assay-*`, ...). `auth_mode`
(NONE / API_KEY / SIGNATURE / BOTH) states what the endpoint expects and is not versioned.

### 3. Request signing

Every outbound provider request is signed with Ed25519 in the style of RFC 9421, label
`assay`. Covered components in order: `@method`, `@authority`, `@path`, `@query`,
`content-digest` (only when the request has a body), `x-assay-call-id`. Parameters:
`created`, `expires` (created + 300 s), `nonce`, `keyid`, `alg="ed25519"`,
`tag="assay-request"`. The body digest is `Content-Digest: sha-256=:<base64>:`.

- Keys come from `PROVIDER_REQUEST_SIGNING_KEYS` (`{keyId, secretKey}`), first entry
  signs. Production refuses to start without it.
- Public keys of every listed key are published as a JWKS at
  `GET /.well-known/assay-request-keys.json` (outside `/api/v1`, `Cache-Control: public,
  max-age=3600`).
- Exact test vectors are in `test/fixtures/request-signing/v1.json`. Provider-side
  verification libraries live in the separate public repository
  `assay-ai/assay-provider-verify`.
- Outbound header order: defaults, mapping headers, credential headers, `x-assay-call-id`,
  then `Content-Digest` / `Signature-Input` / `Signature`. Credentials are per origin, so a
  binding whose endpoint moves does not leak the old origin's secrets to the new one.

### 4. Outcomes and the tester

Failures that are the platform's (vault unavailable, signing failure) end a call as
`PLATFORM_UNAVAILABLE` and never count against the provider's SLA. The endpoint tester
sends credentialed and signed probes and warns when the endpoint also accepts
unauthenticated calls.

### 5. Removed

The IP allowlist is gone: IPs are shared and spoofable behind proxies, and a signature
proves origin without any network coupling. The in-memory ledger writer is removed too.

## Deployment

- BOTH the `api` and `mcp` processes need `PROVIDER_REQUEST_SIGNING_KEYS` and
  `CREDENTIAL_VAULT_KEKS`: the MCP process imports `ToolModule` and is the one that
  actually dials providers.
- The MCP process now also sets Express `trust proxy`, from the same
  `API_TRUST_PROXY_HOPS` as the API (both sit behind the same balancer); production
  refuses to start without it.
- Provider endpoints must not redirect. A same-origin redirect re-sends the first-hop
  signature, whose `@path` / `@query` no longer match, and a verifier rejects it.

## Operations

- `docs/runbooks/rotate-vault-kek.md` and `docs/runbooks/rotate-request-signing-key.md`.
- `scripts/vault/rewrap-deks.ts` re-wraps DEKs under the active KEK without opening any
  credential.

## Consequences

- A leaked database dump without the KEK reveals only header names and hints.
- Losing every copy of a KEK loses the credentials it wraps; providers must re-enter them.
- Rotation of either key needs an ordered, multi-step deploy (see the runbooks).
