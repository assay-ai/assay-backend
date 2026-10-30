# Security policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**, through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
open the repository's **Security** tab and choose **Report a vulnerability**.

Do not open a public issue, pull request or discussion for a suspected vulnerability.

Helpful details to include:

- the affected component (for example the API, the MCP server, the facilitator, a signer, the
  settlement client) and the commit you looked at;
- the impact you believe it has — in particular anything that could move, freeze or misattribute
  funds or stake, leak key material, or cross an organization boundary;
- steps or a proof of concept to reproduce it.

## Supported versions

Only the `main` branch is supported. There are no released versions, and fixes are made on `main`
only.

## What to expect

This is a small project. We aim to acknowledge a report within a few business days and to keep you
updated as we investigate, but we cannot commit to fixed response or fix times. We will credit
reporters in the advisory unless you ask us not to.

## Scope notes

- Assay's production deployment settles on Robinhood Chain mainnet (`eip155:4663`) in real USDG. The
  dev deployment uses the Robinhood Chain testnet and Solana devnet.
- The on-chain programs and contracts live in the `assay-solana` and `assay-evm` repositories;
  report issues in them through those repositories.
- The code has been reviewed internally and has **not** been independently audited.
