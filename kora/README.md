# Kora — the facilitator's fee payer

Kora is the Solana Foundation's MIT-licensed fee-payer relayer
([solana-foundation/kora](https://github.com/solana-foundation/kora)). This
directory holds only the policy config; Kora itself is installed separately —
it is not a Node dependency and is not vendored into this repository.

`kora.toml` is **the second layer beneath our application checks**: our own
`X402SvmVerifierService` already enforces the six SVM `exact` rules before it
ever asks Kora to sign anything. Kora's policy is independent enforcement of
the same boundary, so a bug in our verifier does not become an unbounded
fee-payer drain.

## Install

```bash
cargo install kora-rpc --version 1.0.3 --locked
```

Installs `kora-rpc` (the JSON-RPC 2.0 server) and `kora-openapi` (an OpenAPI
dumper — needs a running config to succeed; see "Known issues" below) to
`~/.cargo/bin`.

## Run against devnet

```bash
cd kora
export KORA_PRIVATE_KEY="$(node -e '
  const bytes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(require("bs58").encode(Buffer.from(bytes)));
' /path/to/devnet-keypair.json)"

kora-rpc --rpc-url https://api.devnet.solana.com --config kora.toml --port 8080
```

Kora wants a **base58-encoded** secret key, not the JSON array format
`solana-keygen` writes — the one-liner converts a keypair file.

**Use `KORA_PRIVATE_KEY`, not `--private-key`.** Both work, but a command-line
argument is visible in `ps` to every user on the host, so the fee-payer secret
would leak to anyone with a shell there. That is a needless exposure for a
value that has an environment form.

Kora also supports Turnkey, Privy and Vault-backed signers natively
(`kora-rpc --help`). See "Known issues" for the state of the Privy signer in
1.0.3.

### A raw private key is for development only

Running Kora with `KORA_PRIVATE_KEY` is suitable for devnet and local work. It
is not the production answer, and one property makes that easy to forget:

> `LocalKeypairFeePayerSigner`'s `NODE_ENV=production` guard **does not cover
> this configuration.** That guard fires when *our* process holds the key. Here
> `FEE_PAYER_SIGNER=kora` and the raw key sits in **Kora's** process instead —
> from our side the signer is "kora", so nothing objects. Kora's `getConfig`
> reports `fee_payer` and `validation_config` and **not** the signer type, so
> the backend cannot detect this either.

So this is an operational prerequisite rather than an enforced one: **before
any mainnet deployment, run Kora with a managed signer** — Vault or Turnkey work
on 1.0.3; Privy needs a newer Kora (see below).

Confirm it is alive:

```bash
curl -s http://127.0.0.1:8080/liveness
curl -s -X POST http://127.0.0.1:8080 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getConfig","params":{}}'
```

The `getConfig` response's `result.fee_payer` is the address this facilitator
will advertise in `GET /supported`'s `extra.feePayer`.

## Point the facilitator at it

```bash
# .env
FEE_PAYER_SIGNER=kora
KORA_RPC_URL=http://127.0.0.1:8080
```

## Known issues

`kora-openapi` panics in our environment
(`thread 'main' panicked ... called Result::unwrap() on an Err value: Os {
code: 2, kind: NotFound, message: "No such file or directory" }`) rather than
producing a spec, with or without a running `kora-rpc` node alongside it. The
method names and shapes used by `KoraFeePayerSigner`
(`src/modules/chains/facilitator/signing/kora-fee-payer.signer.ts`) were
instead read directly from the `kora-rpc` 1.0.3 crate's source (`src/rpc.rs` and
`src/method/*.rs`) — Kora ships no published TypeScript/OpenAPI client for this
version.

Kora 1.0.3's signer options are a local `--private-key`, Turnkey, Privy, or
HashiCorp Vault. There is no AWS KMS signer in this version.

**Kora 1.0.3's Privy signer does not work for this flow.** Kora 1.0.3 ships one
(the `kora-privy` crate, wired in `kora-lib/src/signer/init.rs::init_privy_signer`).
`kora-lib/src/transaction/transaction.rs` signs with

```rust
let signature = signer.sign_solana(&transaction.message_data()).await?;
```

— it passes the **message bytes**, while `kora-privy`'s own doc comment on
`sign_solana` says: *"The transaction parameter should be a fully serialized
Solana transaction (including empty signature placeholders), not just the
message bytes."* Privy's API signs a transaction, not arbitrary bytes, so it
rejects what Kora hands it. The Memory, Vault and Turnkey signers are
unaffected because they sign raw bytes, which is exactly what a message is.

Observed against a Privy app on devnet:

```
# 1. Kora with --with-privy-signer: getConfig resolves the wallet,
#    and GET /supported advertises it. Then POST /settle:
{"code":"FACILITATOR_SIGNER_UNAVAILABLE",
 "message":"signAndSendTransaction: Signing error: API error: 400"}

# 2. The same transaction, sent to Privy directly as a FULL serialized tx — works:
{"method":"signTransaction","data":{"signed_transaction":"…"}}

# 3. The same transaction's message_data(), i.e. exactly what kora-lib passes:
{"error":"Error deserializing Solana transaction: Transaction message version 41
          deserialization is not supported","code":"invalid_solana_transaction"}
```

In 1.0.3, `PrivyError::ApiError(status)` does not carry the response body,
which is why the failure surfaces only as "400".

Newer Kora releases (2.2.0-beta.8) move signing to `solana-keychain` 1.2.0,
whose Privy signer is `async fn sign_transaction(&self, tx: &mut Transaction)` —
taking a `Transaction` rather than `&[u8]` avoids this. The options are
therefore: use the local/Vault/Turnkey signer on 1.0.3, take a beta dependency
on the money path, or carry a one-line patch to 1.0.3.

```bash
kora-rpc \
  --rpc-url https://api.devnet.solana.com \
  --with-privy-signer \
  --privy-app-id "$PRIVY_APP_ID" \
  --privy-app-secret "$PRIVY_APP_SECRET" \
  --privy-wallet-id "$PRIVY_WALLET_ID" \
  --config kora.toml --port 8080
```

**Nothing in the backend changes when the signer changes.** Kora is a separate
process and `KoraFeePayerSigner` talks to it over JSON-RPC, so which signer Kora
resolves to is a launch flag, not a code path on our side. `GET /supported`
picks up the new `extra.feePayer` automatically — it reads Kora's `getConfig`.

What Privy signing buys and costs, so the choice is made with both in view:

- **Buys:** no private key in any process we operate; the credential is an app
  secret, which is revocable and rotatable without moving funds. Privy
  *policies* attach to the wallet (`policy_ids` on the wallet record), so the
  fee-payer spend cap becomes a third enforcement layer under our verifier and
  `kora.toml`.
- **Costs:** signing becomes a network call to `api.privy.io` on the `/settle`
  path — latency inside the ~60s blockhash window, and a hard dependency. A
  Privy outage would then stop rail-A deposits as well as logins, which changes
  the platform's failure isolation.
- **Unchanged:** the v0-transaction limitation. `kora-privy`'s `sign_solana`
  deserializes Privy's response with `bincode::deserialize::<Transaction>` —
  legacy-only, the same constraint as Kora's own decoder. Switching signers
  does not change it.
