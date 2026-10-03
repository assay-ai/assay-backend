/**
 * The deliberately broken binding the public live demo's right-hand column
 * calls.
 *
 * ```bash
 * yarn demo:broken-binding
 * ```
 *
 * ## What is broken, and why it is the BINDING rather than the query
 *
 * The obvious way to draw the failing column is an empty result set — *"0
 * results, minimum is 1"*. That cannot happen here. `min_one_result` is weighted `0.10`
 * against a `0.70` threshold and so can never fail its policy alone, and the
 * platform's stated position is that **an empty search is a valid, chargeable
 * answer**: an empty collection routes to the empty-result policy rather than
 * failing. Proved by experiment on 2026-09-01 — such a query came
 * back `{ "results": [], "totalHits": 0 }` and was **charged $0.02**.
 *
 * So the fault moves into the binding: *"a real call to a deliberately broken
 * tool"*. This binding is a copy of the healthy
 * `search_wikipedia` one with **one line changed**:
 *
 * ```diff
 * -  "pageId": { "$path": "$.pageid" }
 * +  "pageId": { "$path": "$.ns" }
 * ```
 *
 * `ns` is the MediaWiki namespace. It is present on every search result and is
 * always `0` for a main-namespace article, so every row comes back carrying the
 * same id — which is a provider mapping the wrong field into an identifier, one
 * of the most ordinary bugs there is, and precisely the story the page tells:
 * *you paid for five distinct articles and got the same one five times.*
 *
 * ## The arithmetic, which is not "one minus the failing weight"
 *
 * `score = passedWeight / consideredWeight` against `passThreshold`
 * (`deterministic-stage.ts:119,121`), with `NOT_APPLICABLE` rules removed from
 * **both** sides (`:107`).
 *
 * ```text
 * min_one_result          0.10  PASS   5 >= 1
 * fields_present          0.35  PASS   title and pageId present on every row
 * ids_distinct            0.35  FAIL   five values, all 0
 * wordcount_not_negative  0.20  PASS   real word counts, all >= 0
 *                         ----
 * score = 0.65 / 1.00 = 0.65  <  0.70  ->  DATA_FAIL
 * ```
 *
 * The shortcut "1 minus the failing weight" happens to give the same answer
 * only because these four weights sum to exactly `1.0`. It is wrong on the
 * first policy that does not, so do not carry it forward.
 *
 * **A `pageId` of `0` counts as present.** `evaluateRequiredFields` uses
 * `hasOwnProperty` plus an explicit null check (`evaluate-rules.ts:287,295`),
 * so zero is not read as missing and `fields_present` does not also fail. That
 * matters: if it did, the page would name two broken rules instead of the one
 * it is about.
 *
 * ## Two prerequisites this script asserts rather than assumes
 *
 * Both fail silently and both invert the page's meaning:
 *
 * - **The binding must be `PAID`.** The free/paid fork in
 *   `McpToolCallService.call` branches on the **binding's** `pricingMode`, not
 *   the agent's. A `FREE` binding takes the relay path — no intent, no hold, no
 *   settlement — and the entire money story disappears.
 * - **The policy must be `ACTIVE`.** `effectiveConsequence` gives a `SHADOW`
 *   policy the `PASS` consequence *whatever the verdict is*, so the column
 *   would read "failed our checks, and charged anyway".
 *
 * ## Why a second TOOL rather than a second binding on `search_wikipedia`
 *
 * `RoutingContext` carries only `excludeProviderIds` — deliberately
 * provider-scoped, per its own doc comment — so **nothing can pin a specific
 * binding**. Two `ACTIVE` bindings on one tool would let the router pick either
 * one, which makes the demo non-deterministic *and* exposes real agents calling
 * `search_wikipedia` to a knowingly-broken endpoint. A second tool gives the
 * demo a name to select with, which `McpToolCallService.call(session, name,
 * args)` already takes.
 *
 * The cost, accepted deliberately: this tool is visible in the public
 * catalogue and in `tools/list`, because the catalogue lists every tool with an
 * `ACTIVE` binding and has no exclusion hook. Its `description` is written to
 * be as unattractive as possible to a model choosing a tool, and its tier is
 * `UNVERIFIED`. A real agent that calls it anyway is not charged — the binding
 * fails its checks, which is the point.
 */

import { NestFactory } from '@nestjs/core';

import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';

/** `search_wikipedia` — the healthy tool whose binding this one is copied from. */
const HEALTHY_TOOL_ID = '8fa77325-86d3-5e4a-8c6f-6ec85ccf0b33';

/** `search_wikipedia_demo_broken`, from `catalogue.json`. */
const BROKEN_TOOL_ID = '294afca7-be7c-59d0-a4d2-f7c994c39c45';

const BROKEN_POLICY_ID = 'search_wikipedia_demo_broken.default';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppMcpModule, { logger: false });

  try {
    const bindings = app.get(ToolBindingRepository);
    const policies = app.get(VerificationPolicyRepository);

    // `findByTool` rather than a lookup by binding id: the repository is
    // organization-scoped and refuses a bare primary key, and identifying the
    // source by TOOL survives the binding being re-created.
    const served = (await bindings.findByTool(HEALTHY_TOOL_ID)).filter(
      (binding) => binding.status === BindingStatus.ACTIVE,
    );
    if (served.length !== 1) {
      throw new Error(
        `Expected exactly one ACTIVE binding on search_wikipedia, found ${served.length}. ` +
          'This script copies that binding, so an ambiguous source would silently pick one ' +
          'and the two demo columns could differ in more than the single mapping line.',
      );
    }
    const healthy = served[0];

    // ── Prerequisite 1: the source is PAID ───────────────────────────────
    if (healthy.pricingMode !== PricingMode.PAID) {
      throw new Error(
        `The healthy binding is ${healthy.pricingMode}, not PAID. A FREE or FREEMIUM binding ` +
          'takes the relay path — no intent, no hold, no settlement — and the demo has no money ' +
          'story to tell without one. Fix the source binding before seeding the broken copy.',
      );
    }

    // ── Prerequisite 2: the broken tool's policy is ACTIVE ───────────────
    const policy = await policies.findServing(BROKEN_TOOL_ID);
    if (!policy) {
      throw new Error(
        `No serving policy for ${BROKEN_TOOL_ID}. Run \`yarn mcp:policies\` first — a tool with ` +
          'no ACTIVE policy settles UNVERIFIED, so the demo would show no checks at all.',
      );
    }
    if (policy.lifecycle !== 'ACTIVE') {
      throw new Error(
        `Policy ${BROKEN_POLICY_ID} is ${policy.lifecycle}, not ACTIVE. effectiveConsequence() ` +
          'gives a SHADOW policy the PASS consequence whatever the verdict is, so the demo ' +
          'would read "failed our checks, and charged anyway".',
      );
    }

    // ── The copy, with one line changed ──────────────────────────────────
    const responseMapping = JSON.parse(JSON.stringify(healthy.responseMapping)) as Record<
      string,
      unknown
    >;
    const results = responseMapping.results as { $item?: Record<string, unknown> } | undefined;
    if (!results?.$item || !('pageId' in results.$item)) {
      throw new Error(
        'The healthy binding no longer maps results[].pageId, so there is nothing to break in ' +
          'the way this demo depends on. Re-read the mapping before changing this script.',
      );
    }
    results.$item.pageId = { $path: '$.ns' };

    // `srlimit` is pinned rather than passed through from `$.limit`. The row
    // count then depends only on the query, which is the one thing the demo
    // still cannot control — see the row-count guard in the demo service.
    const requestMapping = JSON.parse(JSON.stringify(healthy.requestMapping)) as {
      query?: Record<string, unknown>;
    };
    if (requestMapping.query) {
      requestMapping.query.srlimit = { $const: '5' };
    }

    const existing = (await bindings.findByTool(BROKEN_TOOL_ID)).find(
      (binding) => binding.organizationId === healthy.organizationId,
    );

    const row = existing ?? new ToolBindingEntity();
    Object.assign(row, {
      organizationId: healthy.organizationId,
      toolId: BROKEN_TOOL_ID,
      endpoint: healthy.endpoint,
      requestMapping,
      responseMapping,
      pricingMode: PricingMode.PAID,
      priceAmount: healthy.priceAmount,
      assetId: healthy.assetId,
      // Copied from the binding this one is a broken copy OF.
      // The demo's whole point is that the two differ in one mapping line and
      // nothing else, so the chains it is offered on have to come from the
      // healthy row rather than from a constant that could drift from it.
      settlementChains: healthy.settlementChains,
      slaFailureRate: healthy.slaFailureRate,
      timeoutMs: healthy.timeoutMs,
      status: BindingStatus.ACTIVE,
      // `chk_tool_bindings_active_is_published` refuses an ACTIVE or PAUSED
      // binding that was never published, so the publish state is part of the
      // row rather than something to set afterwards. Seeded at revision 1 —
      // this binding has one mapping and has never been edited, so
      // `mappingVersion` and `publishedVersion` agree and the console shows no
      // unpublished drift.
      mappingVersion: 1,
      publishedVersion: 1,
      publishedAt: new Date(),
    });

    const saved = await bindings.save(row);

    // eslint-disable-next-line no-console
    console.log(
      [
        `binding   ${saved.id} ${existing ? '(updated)' : '(created)'}`,
        `org       ${saved.organizationId}`,
        `tool      ${BROKEN_TOOL_ID} search_wikipedia_demo_broken`,
        `endpoint  ${saved.endpoint}`,
        `pricing   ${saved.pricingMode} ${saved.priceAmount}`,
        `policy    ${BROKEN_POLICY_ID} ${policy.lifecycle}`,
        `broken    results[].pageId <- $.ns  (always 0, so every row shares an id)`,
        `expected  ids_distinct FAILS -> score 0.65 < 0.70 -> DATA_FAIL, not charged`,
      ].join('\n'),
    );
  } finally {
    // `close()` throws looking for an unnamed DataSource on this wiring and would
    // mask whatever the block above raised. Same guard as `scripts/mcp/policies.ts`.
    await app.close().catch(() => undefined);
  }
}

void main()
  .then(() => {
    // Explicit, because the context does not always go quiet: `RedisCacheModule`
    // has no `onModuleDestroy`, so a script can hang here long after its work
    // committed. Exiting on success keeps a seeder that succeeded from looking
    // like one that stalled.
    process.exit(0);
  })
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
