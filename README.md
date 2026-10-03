# GoAssay.AI backend

The backend for **GoAssay.AI**, a platform that lets AI agents pay for tool calls with x402
payments, and withholds payment for results that fail verification. Providers
list their HTTP APIs as tools and stake collateral; agents call those tools through an MCP server;
every call is verified, and a provider whose responses fail verification can be slashed through
an on-chain, timelocked, disputable process.

This repository is a NestJS application that runs as several cooperating processes:

- **API** — REST surface for the buyer, provider and operator dashboards (Swagger at `/api/docs`).
- **MCP server** — the endpoint agents call (`tools/list` with prices, `tools/call`).
- **Facilitator** — a self-hosted x402 SVM facilitator (`/verify`, `/settle`, `/supported`) in its
  own process, so its fee-payer key never sits in the API process.
- **Worker** and **scheduler** — verification, reconciliation, voucher redemption, stake monitoring
  and other background work (BullMQ on Redis).
- **WebSocket** — real-time updates to the dashboards.

Settlement runs on **Solana** (an Anchor program, through the generated client in
`packages/settlement-client`) and on **EVM chains** (Robinhood Chain), behind a single chain
boundary in `src/modules/chains/`.

## Status

**Experimental. Not production-ready, and not deployed with real funds.**

- The backend is developed against Solana devnet and the Robinhood Chain testnet only; no deployment from this repository is published.
- The backend and the on-chain programs have been reviewed internally; they have **not** been
  independently audited.
- Signing keys are currently provisioned through environment variables behind signer ports; a
  KMS-backed signer is the production target (see [`docs/architecture.md`](docs/architecture.md)
  §"Signing Keys").
- Interfaces, database schema and configuration may change without notice.

## Quick start

Prerequisites: Node.js 24+, Yarn 1.22, Docker.

```bash
yarn install
cp .env.example .env                    # defaults are enough for a first run
docker-compose up -d postgres redis     # PostgreSQL 15 and Redis 7
yarn migration:run
yarn start:dev                          # all process roles in one process
```

Then open `http://localhost:3000/api/docs`.

`.env.example` documents every variable. `ENABLED_CHAINS` is required (the example enables Solana
devnet); see [`docs/runbooks/chains.md`](docs/runbooks/chains.md).

## Tests

```bash
yarn test               # unit tests — no database, Redis or network needed
yarn lint
yarn build
yarn client:check       # generated settlement client matches the vendored IDL
yarn test:integration   # integration tests — need PostgreSQL and Redis (see CONTRIBUTING.md)
```

## Repository layout

```
src/
  bootstrap/          one entry point per process role (SERVICE_TYPE)
  modules/            domain modules: payment, ledger, tool, provider, verification,
                      settlement, slash, mcp, operator, ... and chains/ (the chain boundary)
  database/postgres/  entities, repositories, migrations, organization-scope guard
  shared/             errors, filters, guards, egress client, alerting, observability
packages/
  settlement-client/  generated @solana/kit client for the Solana settlement program
test/
  unit/               unit tests (yarn test)
  integration/        integration tests against PostgreSQL and Redis
scripts/              operator and developer tooling (devnet, testnet, demo seeds, verifier keys)
kora/                 policy config for the Kora fee-payer relayer
docs/                 architecture, ADRs, runbooks, API conventions
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — architecture and code conventions
- [`docs/api-list-contract.md`](docs/api-list-contract.md) — the list/pagination contract
- [`docs/mapping-format.md`](docs/mapping-format.md) — the binding mapping format
- [`docs/runbooks/`](docs/runbooks/) — operational runbooks
- [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md) — per-chain acceptance criteria
- [`kora/README.md`](kora/README.md) — running the Kora fee payer. `kora/kora.toml` allows only the default devnet USDC mint; a deployment that overrides `SOLANA_DEVNET_USDC_MINT` must add its mint there.
- [`scripts/README.md`](scripts/README.md) — the script set

## Related repositories

- `assay-frontend` — the web dashboards
- `assay-solana` — the Solana settlement program (Anchor)
- `assay-evm` — the EVM contracts (Foundry)

## Contributing and security

External code contributions are not accepted at this time; bug reports and questions are welcome.
See [`CONTRIBUTING.md`](CONTRIBUTING.md). Report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md).

## License

Source-available, not open source. You may read it and use it for noncommercial purposes under the
PolyForm Strict License 1.0.0; redistribution, modification and commercial use are not permitted.
Questions and licensing enquiries: open an issue or discussion in this repository (GitHub Issues). Security reports go through private vulnerability reporting, see [`SECURITY.md`](SECURITY.md).

The license applies to the first-party code in this repository only. Third-party dependencies
installed through `package.json` remain under their own licenses. See [`LICENSE`](LICENSE).
