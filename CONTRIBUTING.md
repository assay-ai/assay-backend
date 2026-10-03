# Contributing

Thank you for your interest in the GoAssay.AI backend.

## Contributions we can accept

This repository is **source-available, not open source**. It is published under the
[PolyForm Strict License 1.0.0](LICENSE), which does not permit modifications or derivative works.
For that reason **we do not accept external code contributions (pull requests) at this time.**

What is welcome:

- **Bug reports** — open an issue using the bug report template.
- **Questions and discussion** about the design or the code — open an issue using the question
  template.
- **Security reports** — never in a public issue; follow [`SECURITY.md`](SECURITY.md).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

The rest of this document describes how to set up, run and test the backend locally, and the
conventions the maintainers follow. The architecture and code conventions themselves are in
[`docs/architecture.md`](docs/architecture.md).

## Prerequisites

- Node.js **24** or later (`@solana-program/token` requires it; yarn refuses the install on older
  versions).
- Yarn **1.22** (classic). The repository is a yarn workspace: `packages/settlement-client` is a
  workspace package.
- Docker, for the local PostgreSQL 15 and Redis 7 (`docker-compose.yml`).

## Set up

```bash
yarn install
cp .env.example .env
```

`.env.example` documents every variable. For a first local run the defaults are enough, except
that `BULLBOARD_PASSWORD` must be non-empty while `BULLBOARD_ENABLED=true`.

Start PostgreSQL and Redis. `docker-compose.yml` publishes them on the host ports named by
`DATABASE_PORT` and `REDIS_PORT` in `.env` (5432 and 6379 by default — change both in `.env` if
those ports are already taken on your machine):

```bash
docker-compose up -d postgres redis
yarn migration:run
```

## Run

One image runs one process role, chosen by `SERVICE_TYPE` (see
[`docs/architecture.md`](docs/architecture.md) §"Scaling Design"):

```bash
yarn start:dev           # SERVICE_TYPE from .env (default `all`)
yarn start:api:dev       # api only
yarn start:worker:dev    # BullMQ worker only
yarn start:websocket:dev # websocket only
yarn start:scheduler:dev # scheduler only (single instance only)
yarn start:mcp:dev       # MCP server only
```

The API serves Swagger UI at `http://localhost:${API_PORT}/api/docs`. `yarn openapi:export`
writes `openapi.yaml`.

`ENABLED_CHAINS` decides which networks the deployment serves and is required; see
[`docs/runbooks/chains.md`](docs/runbooks/chains.md).

## Test

```bash
yarn test                # unit tests (also builds the settlement client first)
yarn lint                # ESLint + Prettier
yarn build               # production build
yarn client:check        # the generated settlement client matches the vendored IDL
```

The unit suite needs no database, Redis or network.

Integration tests (`test/integration/`) run against a real PostgreSQL and Redis. Start them as in
"Set up", then:

```bash
yarn test:integration
```

Each integration suite creates and migrates its own database (named after `DATABASE_NAME` with a
suffix), so point `.env` at a server where that is acceptable — never at a shared or production
database. `yarn test:integration:reset` drops those test databases.

Scripts under `scripts/devnet/` and `scripts/testnet/` exercise live Solana devnet and Robinhood
Chain testnet deployments. They need funded keys and a running stack and are not part of CI; each
script's header explains what it needs. `scripts/README.md` describes the script set.

## Code style

- TypeScript throughout. ESLint (`eslint.config.mjs`) and Prettier (`.prettierrc`: single quotes,
  trailing commas, 100-character lines, 2-space indentation). `yarn lint:fix` and `yarn format`
  apply them.
- Avoid `any`; prefer precise types.
- File names are kebab-case; classes PascalCase; variables and functions camelCase; constants and
  enum members UPPER_SNAKE_CASE. Database columns are snake_case with an explicit
  `@Column({ name })`.
- Chain SDKs (`@solana/*`, `viem`, the settlement client) may only be imported under
  `src/modules/chains/`; ESLint enforces this.
- Errors are domain-prefixed codes from each module's error catalog, thrown from services — see
  [`docs/architecture.md`](docs/architecture.md) §"Error System".
- Every business table carries `organizationId`, and repositories refuse unscoped queries — see
  [`docs/architecture.md`](docs/architecture.md) §"Multi-Organization Scoping".
- Never sign directly: every key sits behind a signer port — see
  [`docs/architecture.md`](docs/architecture.md) §"Signing Keys".

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint
(`commitlint.config.js`) through the husky `commit-msg` hook:

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. The subject starts lowercase and has no trailing period; the header is at most 100
characters.

## Related repositories

- `assay-frontend` — the web dashboards.
- `assay-solana` — the Solana settlement program (Anchor). The IDL vendored in
  `packages/settlement-client/idl/` is built from it.
- `assay-evm` — the Solidity contracts for EVM chains (Foundry).
