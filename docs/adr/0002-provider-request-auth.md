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
- Key hygiene at boot: with `NODE_ENV=production` an empty `CREDENTIAL_VAULT_KEKS` fails the
  boot (like the signer); an all-same-byte key is rejected as a placeholder. A key-check
  value per key id, `HMAC-SHA256(KEK, "assay/kek-check/v1")` truncated to 16 bytes, is stored
  in `vault_kek_checks(kek_id, kcv)` on first use and compared at every boot; a mismatch
  (a key id re-pointed at different bytes) fails the boot with a message naming the key id
  only.
- Deleting the set for the origin of the published endpoint is refused with 409
  `PROVIDER_CREDENTIAL_ORIGIN_LIVE` while the binding is ACTIVE, or published (also PAUSED)
  under an auth mode that needs a key. Resuming such a binding without a set for that origin
  is refused with `PROVIDER_CREDENTIALS_REQUIRED_FOR_AUTH_MODE`, the same check as switching
  the auth mode. Put, remove and prune each write an
  `audit_log_entries` row (`binding_credentials.set|removed|pruned`): actor, binding, origin
  and header names, never values.
- An `API_KEY` or `BOTH` binding needs a set for the origin of its endpoint: publish refuses
  without one (checklist row `API_KEY_CREDENTIALS`), and at call time a missing set for the
  request origin ends the call as `PLATFORM_UNAVAILABLE` ("credentials missing for this
  address") without dialling, so the provider's 401 is not blamed on the provider. The
  tester's credential-less probe is the one deliberate exception.

### 2. Validation

A mapping is rejected when a constant header or a constant query entry (and the endpoint's
own query) has a secret-looking name. The name is lowercased and split into tokens on `-` and
`_`; it is flagged when a token equals or ends with `key`, `token`, `secret`, `password`,
`passwd`, `auth`, `authorization`, `credential`, `signature`, `session` or `cookie` (so
`x-api-key`, `apikey`, `x-goog-api-key` and `ocp-apim-subscription-key` match), or is `sig`.
An allow-list keeps `idempotency-key`, `x-sort-key`, `sort_key`, `cache-key`, `max_tokens`,
`keyword` and `keywords`. Body fields are not checked.
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
- A request mapping declares at most 40 headers (`MAX_MAPPING_HEADERS`): the relay carries
  64, and Assay adds up to 16 (`accept`, `content-type`, the call id, three signature headers
  and up to 10 credential headers), with 8 held as margin. With the relay configured, Save
  also refuses an endpoint the relay cannot carry: not https or an IP literal
  (`PROVIDER_ENDPOINT_NOT_RELAYABLE`), or a port Cloudflare does not proxy
  (`PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED`).

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
  `CREDENTIAL_VAULT_KEKS`, and only they: the invoker, the signer and the vault live in
  `ToolEgressModule`, which only `AppApiModule` (mapping tester, public demo, JWKS) and
  `AppMcpModule` (`tools/call`) import. The `scheduler`, `worker`, `websocket` and
  `facilitator` processes need neither; the scheduler reaches `ToolModule` for quotes but
  never dials a provider. `test/unit/bootstrap/provider-secrets-boot.spec.ts` pins this.
- The MCP process now also sets Express `trust proxy`, from the same
  `API_TRUST_PROXY_HOPS` as the API (both sit behind the same balancer); production
  refuses to start without it.
- Provider endpoints must not redirect. A same-origin redirect re-sends the first-hop
  signature, whose `@path` / `@query` no longer match, and a verifier rejects it.

- Credential headers are not covered by the signature (it covers the method, authority,
  path, query, body digest and call id). TLS is what protects them in transit; endpoints
  must be https in production.

## Operations

- `docs/runbooks/rotate-vault-kek.md` and `docs/runbooks/rotate-request-signing-key.md`.
- `scripts/vault/rewrap-deks.ts` re-wraps DEKs under the active KEK without opening any
  credential.

## Consequences

- A leaked database dump without the KEK reveals only header names and hints.
- Losing every copy of a KEK loses the credentials it wraps; providers must re-enter them.
- A signing key that is removed from the JWKS may still be cached by providers for up to one
  hour. Shortening the JWKS cache lifetime in the verifier SDK is out of scope here and
  belongs to the `assay-provider-verify` repository.
- Rotation of either key needs an ordered, multi-step deploy (see the runbooks).
