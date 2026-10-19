/**
 * `yarn devnet:acceptance-fixture` — build the chain-staked witness that
 * `devnet:acceptance` step `0b` requires, on a database that does not have one.
 *
 *     ACCEPTANCE_FIXTURE_PERSON_TOKEN=<token> yarn devnet:acceptance-fixture
 *     # then, as it prints:
 *     ACCEPTANCE_STAKED_PROVIDER_ORG_ID=<id> yarn devnet:acceptance
 *
 * `ACCEPTANCE_FIXTURE_PERSON_TOKEN` is a token of the API server's
 * `MCP_CREDENTIALS_FILE` whose record is marked `"kind": "human"` and names an
 * organization that is not a provider yet: registration and the stake
 * authority proof are person-only routes, and a minted agent credential is
 * refused on them (review N-2). See `adoptConfigPersonIdentity`.
 *
 * ## Why this is needed
 *
 * Step `0b` (`assertStakeSourceIsChain`) refuses to let the suite spend real
 * devnet USDC until it has proved that the stake source is actually reading the
 * chain. It proves that with a **witness**: an organization that is staked on
 * chain and has a proved `stake_authority`.
 *
 * The witness id baked into the suite (`677e6a64…`) came from an earlier manual
 * provider-stake run and lives in the database that run used. On any other database — a fresh local
 * one, for instance — it does not exist, and the suite dies at `0b` with
 * "organization … has no agent row" before step 1 has a chance to create
 * anything. The suite cannot bootstrap its own witness: `0b` runs first, and
 * there is no `--from` or `--skip`.
 *
 * So the witness has to be built out of band. That is this script.
 *
 * ## What it builds, and what it reuses
 *
 * The chain half already exists if `yarn devnet:escrow-rail-b --execute` has
 * run: that harness opens a `ProviderStake` PDA for the keypair at
 * `scripts/devnet/.keys/rail-b-provider.json` and bonds 150 USDC into it. This script
 * therefore builds only the **off-chain half** — an organization, an agent, a
 * credential, a `providers` row, and a proved stake authority pointing at that
 * same keypair — and then verifies, through the API, that the chain reading
 * comes back.
 *
 * Everything except the identity goes through the real HTTP endpoints
 * (`POST /providers`, the stake-authority challenge and proof), so a fixture
 * that succeeds is also evidence those endpoints work. The identity is the
 * config-file person record, its organization and agent rows created if
 * missing by `adoptConfigPersonIdentity`.
 *
 * One run per record: an organization that is already a provider is refused,
 * so a re-run needs a fresh record (and an API restart to load it). Each run
 * prints its own id.
 */

import { join } from 'node:path';

import { getBase58Decoder, signBytes } from '@solana/kit';

import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

import { createApiClient } from './lib/acceptance-http';
import { adoptConfigPersonIdentity, bootIdentityContext } from './lib/acceptance-identity';
import { loadKeypairSigner } from '../settlement/lib/sender';

const API_BASE_URL = process.env.ACCEPTANCE_API_BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * The keypair `devnet:escrow-rail-b` staked. `lib/keystore.ts` persists under
 * `scripts/devnet/.keys/` — **not** `~/.assay-keys`, which holds only the
 * operator's own key and its credentials file. The directory is gitignored.
 */
const PROVIDER_KEYPAIR =
  process.env.ACCEPTANCE_FIXTURE_PROVIDER_KEYPAIR ??
  join(__dirname, '.keys', 'rail-b-provider.json');

interface StakeReading {
  readonly stakeAuthority: string | null;
  readonly chainReadable: boolean;
  readonly hasKnownStake: boolean;
  readonly staked: { readonly amount: string; readonly asset: string } | null;
}

async function main(): Promise<void> {
  const app = await bootIdentityContext();
  let failed = false;

  try {
    const signer = await loadKeypairSigner(PROVIDER_KEYPAIR);
    console.log(`witness provider keypair: ${signer.address}`);

    const identity = await adoptConfigPersonIdentity(
      app,
      'ACCEPTANCE_FIXTURE_PERSON_TOKEN',
      'stake-witness',
    );
    console.log(`organization:             ${identity.organizationId}`);

    const api = createApiClient(API_BASE_URL, identity.token);

    // ── The provider row ─────────────────────────────────────────────────────
    const suffix = identity.organizationId.slice(0, 8);
    await api.post('/api/v1/providers', {
      legalName: `Stake Witness ${suffix}`,
      technicalContact: { name: 'Witness Bot', email: `tech-${suffix}@example.test` },
      ownerContact: { name: 'Witness Owner', email: `owner-${suffix}@example.test` },
      timezone: 'Europe/Paris',
      acceptedTerms: {
        providerAgreementVersion: process.env.PROVIDER_TERMS_AGREEMENT_VERSION ?? 'v1.0',
        payoutTermsVersion: process.env.PROVIDER_TERMS_PAYOUT_VERSION ?? 'v1.0',
        slashPolicyVersion: process.env.PROVIDER_TERMS_SLASH_POLICY_VERSION ?? 'v1.0',
      },
    });
    console.log('registered:               ok');

    // ── Prove the stake authority ────────────────────────────────────────────
    // The signature is over the challenge's own message, by the very keypair
    // whose `ProviderStake` PDA holds the bond. That equality is the whole
    // point of the witness: without it the reading could have come from config.
    const challenge = await api.post<{ challengeId: string; message: string }>(
      '/api/v1/providers/me/stake-authority/challenge',
      // `{ chainId, address }`, not a CAIP-10 `accountId` — the DTO composes
      // the account id itself and rejects one that is handed to it.
      { chainId: CHAIN_IDS.SOLANA_DEVNET, address: signer.address },
    );
    const signature = getBase58Decoder().decode(
      await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(challenge.message)),
    );
    await api.post('/api/v1/providers/me/stake-authority', {
      challengeId: challenge.challengeId,
      signature,
    });
    console.log('stake authority proved:   ok');

    // ── Read it back the way step 0b will ────────────────────────────────────
    // Asserting here rather than leaving it to the suite: a fixture that
    // reports success while `0b` would still refuse is worse than no fixture,
    // because the next failure looks like the suite's rather than this script's.
    const stake = await api.get<StakeReading>('/api/v1/providers/me/stake');
    const usable =
      Boolean(stake.stakeAuthority) &&
      stake.chainReadable &&
      stake.hasKnownStake &&
      stake.staked !== null &&
      stake.staked.amount !== '0';

    console.log(
      `stake reading:            authority=${stake.stakeAuthority ?? 'null'} ` +
        `chainReadable=${stake.chainReadable} staked=${stake.staked?.amount ?? 'null'}`,
    );

    if (!usable) {
      failed = true;
      console.error(
        '\nThis organization cannot serve as the witness. The usual causes, in order:\n' +
          '  - the ProviderStake PDA does not exist or is empty — run\n' +
          '      yarn devnet:escrow-rail-b --execute\n' +
          '    which opens and bonds it for this same keypair;\n' +
          '  - SOLANA_RPC_URL on the API server cannot reach devnet.\n',
      );
      return;
    }

    console.log(
      `\nReady. Run the suite against this witness:\n\n` +
        `  ACCEPTANCE_STAKED_PROVIDER_ORG_ID=${identity.organizationId} yarn devnet:acceptance\n`,
    );
  } catch (error) {
    failed = true;
    console.error('\nacceptance-fixture failed:', error);
  } finally {
    await app.close().catch(() => undefined);
    // `RedisCacheModule` never closes its client, so the process would hang
    // here with its work already done. Flush first: stdout to a pipe is
    // asynchronous, and `process.exit` discards what is still buffered.
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit(failed ? 1 : 0);
  }
}

void main().catch((error) => {
  console.error('acceptance-fixture failed:', error);
  process.exit(1);
});
