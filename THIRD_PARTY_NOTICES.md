# Third-party notices

This repository's own code is licensed under the PolyForm Strict License 1.0.0 (see `LICENSE`).
It vendors no third-party source code. Dependencies are installed by the package manager
(`yarn install`) from the registries named in `package.json` and `yarn.lock`, and each remains
under its own licence, which ships inside the installed package.

Notable licences among the installed dependencies, as read from their `package.json` fields:

| Package | Version | Licence | Use |
|---|---|---|---|
| `rpc-websockets` | 9.3.10 | LGPL-3.0-only | Runtime, pulled in by `@solana/web3.js`. Used as an unmodified dynamic dependency on the server; this repository does not redistribute it. |
| `pause` | 0.0.1 | none declared in `package.json` | Runtime, pulled in by `passport`. |
| `text-encoding-utf-8` | 1.0.2 | none declared in `package.json` | Runtime, pulled in by `borsh`. |
| `caniuse-lite` | 1.0.30001759 | CC-BY-4.0 | Build and lint tooling data only. |

Kora (the Solana fee-payer relayer, MIT licence, Solana Foundation) is run as a separate external
service. `kora/kora.toml` is this project's own policy file for it; no Kora source is copied here.

Check the licences of the exact versions you install before redistributing anything built from
this repository.
