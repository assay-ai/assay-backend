import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * The architecture test behind the dashboard API's central promise: **one** pagination
 * style, **one** filter style, **one** sort style, **one** error shape, across
 * the whole REST surface.
 *
 * A convention documented in `backend/docs/api-list-contract.md` and enforced
 * only by review lasts until the first hurried endpoint. The cost of that
 * endpoint does not land on its author — it lands on every client author, who
 * now needs a second list component, a second "load more", a second empty
 * state, forever. So the rule is executable.
 *
 * This reads source text rather than booting the app on purpose. It has to
 * catch a controller that has been *written* but not yet *registered* in a
 * bootstrap module — which, during a milestone where four endpoint groups land
 * in parallel, is most of them for most of the time.
 */

const SRC = join(__dirname, '../../../../src');

/**
 * Reference material behind `EXAMPLES_ENABLED`, plus the surfaces that are not
 * this REST API.
 *
 * `_examples/` keeps the starter's offset `PaginationDto` deliberately: it is
 * the worked example of the *framework's* patterns, it is off in production,
 * and rewriting it would misrepresent what the starter ships. It is excluded
 * here rather than exempted silently — see the assertion at the bottom, which
 * pins that `PaginationDto` has no other callers.
 */
const EXCLUDED_DIRS = ['_examples', 'chains/facilitator', 'mcp'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALL_TS = walk(SRC);

const isExcluded = (file: string) =>
  EXCLUDED_DIRS.some((dir) => relative(SRC, file).replace(/\\/g, '/').startsWith(dir)) ||
  EXCLUDED_DIRS.some((dir) => relative(SRC, file).replace(/\\/g, '/').includes(`/${dir}/`));

const SURFACE_FILES = ALL_TS.filter((file) => !isExcluded(file));

/**
 * Domain code only.
 *
 * The offset-pagination checks below run over this rather than the whole
 * surface, because `src/shared/` is where the offset DTO is *defined* and where
 * `list-query.dto.ts` explains in prose why product code no longer uses it. A
 * check that cannot tell a definition from a call site reports its own
 * documentation as a violation.
 */
const MODULE_FILES = SURFACE_FILES.filter((file) =>
  relative(SRC, file).replace(/\\/g, '/').startsWith('modules/'),
);

const CONTROLLERS = SURFACE_FILES.filter((file) => file.endsWith('.controller.ts')).filter(
  (file) =>
    // The health check and the error-shape probe are not resource endpoints.
    !file.endsWith('healthcheck.controller.ts') &&
    !file.endsWith('error-shape-probe.controller.ts'),
);

/**
 * Controllers behind **no** guard, on purpose.
 *
 * The `OPERATOR_SURFACE` note above says a controller behind neither guard
 * is a public route — and treats that as a defect, correctly, because until
 * the proof-of-reserves page every route on this surface had an audience with
 * an account.
 * `/public/reserves` is the first that does not, so the category is written
 * down rather than folded into the operator one, which would claim the
 * opposite of what is true about it.
 *
 * The bar for an entry here is not "no guard was convenient". It is:
 *
 * 1. **The payload carries no tenant.** Nothing keyed to an organization,
 *    an account or a caller — only platform-wide aggregates and facts that
 *    are already public elsewhere (an on-chain address, in this case).
 * 2. **There is no caller to scope it to.** Not merely that scoping was
 *    skipped, but that a scoped version would answer a different question.
 * 3. **Anonymity is the feature.** `/public/reserves` exists so a reader
 *    can check that their custodian holds what it owes *without* asking the
 *    custodian to identify them first. A login here would defeat the page.
 *
 * Adding a file is fine. Adding one silently is not, and this list is the
 * conversation — the same bargain the cross-tenant allowlist above strikes.
 *
 * ## Why the value is a route count
 *
 * The exemption is granted to a *file*, but it was argued for a *route*. Nothing
 * stopped a second handler being added to an already-listed controller and
 * inheriting both exemptions — unguarded, and undocumented for bearer auth —
 * with no failing test and no new conversation. On a tenant-boundary allowlist
 * that is the wrong default: silence is how an authenticated read lands on a
 * public controller. So each entry records how many routes its argument covers,
 * and `'covers only the routes it was argued for'` below turns adding one into a
 * red test. The number is not a limit on the controller; it is a receipt for
 * what was reviewed.
 */
const PUBLIC_SURFACE = new Map<string, number>([
  // The public half of the keys that sign outbound provider requests (JWKS).
  // One route, no tenant, nothing secret: a verifier fetches it unauthenticated.
  ['bootstrap/api/request-keys.controller.ts', 1],
  // Proof of reserves. Four aggregates, one already-public vault
  // address, a count, and four rows of the same aggregates.
  ['modules/settlement/controllers/public-reserves.controller.ts', 1],
  // The live demo. **The weakest entry on this list**, and it is here on
  // different terms from the reserves page, so read the difference rather than
  // the membership:
  //
  // - `POST /public/demo/run` genuinely has no tenant — it acts as the demo's
  //   own credential, resolved through `McpSessionPort` like any agent.
  // - `GET /public/demo/verdict/:intentId` **does** reach tenant-scoped rows.
  //   What keeps it safe is not the payload but a check:
  //   `PublicDemoVerdictService` refuses every intent outside the demo
  //   organization and answers 404, so a foreign id is indistinguishable from
  //   one that never existed. If that check is ever removed, this entry stops
  //   being true and the route becomes a reader of anybody's verification
  //   stages.
  //
  // It is also the only public route that SPENDS MONEY, which a per-IP window
  // and the demo agent's spend policy pay for.
  ['modules/mcp/controllers/public-demo.controller.ts', 3],
  // `GET /chains`. Against the three bars above:
  //
  // 1. The payload is four static strings and a number per chain, computed from
  //    `ENABLED_CHAINS` and a hard-coded metadata table. There is no row, no
  //    join and nothing keyed to an organization anywhere in
  //    `ChainDirectoryService`.
  // 2. A scoped version would answer a different question. "Which chains does
  //    this deployment offer" is a property of the deployment; per-org chain
  //    availability does not exist, and if it ever did it would be a second
  //    endpoint, not a filter on this one.
  // 3. Anonymity is not merely tolerable, it is required and it is already the
  //    status quo. Required: the deposit chain picker and the wallet menu are
  //    rendered by a browser that may not have a session yet, and the endpoint
  //    exists precisely so the frontend stops hard-coding the list at build time —
  //    a login-gated endpoint would push it straight back to the hard-coded
  //    copy. Already the status quo: an x402 `402` challenge advertises this
  //    same set to any unauthenticated caller, so nothing here is disclosed
  //    that the protocol does not hand out first.
  ['modules/chains/controllers/chains.controller.ts', 1],
  // Operator sign-in: `challenge`, `verify`, `logout`. Pre-authentication by
  // definition — `verify` is what issues the session `OperatorAuthGuard`
  // checks. Nothing here reads a row on anybody's behalf: the challenge is a
  // nonce for whatever address asked, the verify answers only with the
  // caller's own session (and only after a valid signature by an active
  // operator's wallet), and logout revokes the token it was handed.
  ['modules/operator/controllers/operator-sign-in.controller.ts', 3],
  // `GET /public/features`. Two booleans — whether the two optional public
  // pages above are registered on this deployment — so those pages ask here
  // instead of calling a route that 404s. No row is read, nothing is keyed to
  // a caller, and the readers are the same session-less pages.
  ['bootstrap/api/public-features.controller.ts', 1],
  // The public Explorer's catalogue. The same derivation as the guarded
  // `catalogue.controller.ts`, whose own comment records that the answer is
  // identical for every caller and holds nothing about the caller — but
  // copied through its OWN allowlisted DTOs (`public-catalogue.dto.ts`, key
  // sets pinned in the catalogue spec), so a field added to the signed-in
  // catalogue does not reach anonymous readers. The detail route answers only
  // for providers the public list shows; every other id is the same 404.
  // Cached in process and rate limited per address. The fourth route (T3) is
  // a LISTED tool's published contract versions and changelog: the same
  // documents `tools/list` and `get_tool` send any key, never a draft, never
  // an UNLISTED tool, and nothing about a caller.
  ['modules/catalogue/controllers/public-catalogue.controller.ts', 4],
  // The Explorer's "not charged" feed. Platform-wide paid calls that ended
  // without a charge, and 30-day totals. The payload is tool, provider name,
  // listed price, a reason and a UTC day; no intent, call, buyer, agent, hold
  // or transaction identifier is selected, and the spec pins the key set.
  // Rows are at least 24 h old, each tool's published rows come from at least
  // five established buyers, totals cover complete days only, and only
  // publicly listed providers are named — see `PublicNotChargedService`.
  ['modules/catalogue/controllers/public-not-charged.controller.ts', 1],
  // The toolset catalogue (design spec §7.9): listed tool sets, one listed
  // tool set's page and versions, one version it serves (with a diff between
  // two served ones), a public name's profile, the categories, and the
  // link-only page by token. Only PUBLIC, LISTED tool sets answer by name, at
  // the newest version published while shared — never the Draft, never a
  // version `/@…` does not serve — and everything else is the same 404 as a
  // missing slug. A toolset id appears only where that path serves it. The by-token route
  // takes the token in a POST body (never a URL, so never a log line) and
  // answers only while that token serves `/u/`. Fields are copied through
  // their own allowlisted DTOs (`public-toolsets.dto.ts`); no owner,
  // reporter or buyer id is selected, and figures are the weekly k = 5 table.
  // Cached in process and rate limited per address.
  ['modules/toolset/controllers/public-toolsets.controller.ts', 7],
]);

/**
 * Every query-builder predicate in a file that constrains the tenant column
 * **without binding it to anything** — i.e. every cross-tenant read.
 *
 * ## Why this is not a substring match any more
 *
 * It used to be `/organizationId\s+IS\s+NOT\s+NULL/i.test(read(file))`, and
 * that answered a different question than its own name — the recurring defect
 * this repo already tracks. Measured, both directions:
 *
 * - **False positive.** A doc comment *stating that a method does not use the
 *   idiom* tripped the gate and reddened a correct change. The gate could not
 *   tell a predicate from prose about a predicate.
 * - **False negative, and this is the serious one.**
 *   `.where('e.organizationId = e.organizationId')` reads **every tenant's**
 *   rows, satisfies `OrganizationScopedRepository`'s runtime guard (the
 *   generated SQL does mention the column), and never matched the regex. A
 *   tenant-boundary gate passed the exact thing it exists to refuse. So would
 *   `organization_id IS NOT NULL` in snake_case builder SQL, or
 *   `organizationId IS DISTINCT FROM NULL`.
 *
 * ## What it computes now
 *
 * Comments are stripped first, so prose is never a predicate. Then, of the
 * string literals passed to `.where(…)` / `.andWhere(…)` / `.orWhere(…)`, a
 * predicate counts as cross-tenant when it names the tenant column and either
 *
 * - compares that column **to itself** (the tautology — no rows are excluded), or
 * - binds **no parameter at all** (`:name`, `:...names`, `$1`), which is what
 *   `IS NOT NULL`, `IS DISTINCT FROM NULL` and `= ANY('{}')` have in common:
 *   a predicate that mentions the tenant and takes no tenant as input cannot
 *   be scoped to one.
 *
 * It is still a text check and still cannot see a predicate assembled from a
 * constant in another file. What it can no longer do is disagree with its own
 * name on either of the two spellings that have actually occurred.
 */
function crossTenantPredicates(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, '');

  const PREDICATE = /\.(?:and|or)?[wW]here\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  const MENTIONS_TENANT = /\borganization_?[Ii]d\b/;
  // A TypeORM named parameter, a spread parameter, or a positional one.
  const BINDS_A_PARAMETER = /(?<!:):(?:\.\.\.)?[A-Za-z_]\w*|\$\d+/;
  // `x.organizationId = x.organizationId`, with the alias captured on both
  // sides so a genuine two-alias join predicate is NOT flagged.
  const SELF_COMPARISON = /(?:(\w+)\.)?(organization_?[Ii]d)\s*=\s*(?:(\w+)\.)?\2\b/;

  const found: string[] = [];
  for (const match of code.matchAll(PREDICATE)) {
    const predicate = match[2];
    if (!MENTIONS_TENANT.test(predicate)) continue;

    const self = SELF_COMPARISON.exec(predicate);
    if (self && (self[1] ?? '') === (self[3] ?? '')) {
      found.push(predicate);
      continue;
    }
    if (!BINDS_A_PARAMETER.test(predicate)) found.push(predicate);
  }
  return found;
}

const read = (file: string) => readFileSync(file, 'utf8');
const name = (file: string) => relative(SRC, file).replace(/\\/g, '/');

describe('REST surface consistency', () => {
  it('has controllers to check, so a passing run is not a vacuous one', () => {
    expect(CONTROLLERS.length).toBeGreaterThan(0);
  });

  describe('one pagination style', () => {
    // The offset DTO paginates by walking and discarding rows, and shifts every
    // row by one when an item is inserted at the head mid-paging — which on a
    // spend history reads as a double charge.
    it.each([
      ['PaginationDto', /\bPaginationDto\b/],
      ['PaginationResponseDto', /\bPaginationResponseDto\b/],
      ['createPaginationResponse', /\bcreatePaginationResponse\b/],
    ])('no domain module uses the offset %s', (_label, pattern) => {
      const offenders = MODULE_FILES.filter((file) => pattern.test(read(file))).map(name);

      expect(offenders).toEqual([]);
    });

    it('no endpoint invents its own page/offset/skip query parameter', () => {
      const offenders = CONTROLLERS.filter((file) =>
        /@Api(Property|Query)\w*\(\s*\{[^}]*\b(name|description)\b[^}]*\b(page|offset|skip)\b/i.test(
          read(file),
        ),
      ).map(name);

      expect(offenders).toEqual([]);
    });

    /**
     * The rule this milestone learned the hard way.
     *
     * `@shared/api` originally exposed `toPage` but not `paginateArray`, so two
     * endpoint groups independently wrote the in-memory keyset arithmetic for
     * their port-backed lists — and the two copies already differed (one sorted
     * ascending then reversed, the other folded direction into the comparator).
     * Neither was wrong yet. Nothing would have kept them agreeing.
     *
     * Cursor arithmetic lives in exactly one place. A module that needs a page
     * from something that is not a query builder calls `paginateArray`.
     */
    it('no module implements its own cursor arithmetic', () => {
      const offenders = MODULE_FILES.filter((file) =>
        /\b(encodeCursor|decodeCursor)\b/.test(read(file)),
      ).map(name);

      expect(offenders).toEqual([]);
    });
  });

  describe('one query envelope', () => {
    /** Query DTOs that are used by a list endpoint, i.e. paired with a page. */
    const listQueryDtos = SURFACE_FILES.filter((file) => file.includes('/dto/')).flatMap((file) => {
      const source = read(file);
      const declarations = [...source.matchAll(/export class (\w*Query\w*Dto)\s+extends\s+(\w+)/g)];
      return declarations.map(([, cls, base]) => ({ file: name(file), cls, base }));
    });

    /**
     * One spelling convention for query parameters.
     *
     * The receipt summary endpoint shipped `group_by` / `compare_to` because the
     * UI wrote them that way and it was the only endpoint of its kind. The
     * dashboard API added around forty parameters, all camelCase, and a later endpoint copied the
     * snake_case pair — which is how a local exception becomes a second
     * convention. A client cannot tell which spelling an unfamiliar parameter
     * uses, so it guesses.
     *
     * Property names on a query DTO *are* the wire names here: nothing on this
     * surface uses `@Expose({ name })`, deliberately, since an alias would mean
     * accepting both spellings forever.
     */
    it('no query DTO declares a snake_case parameter', () => {
      const offenders = SURFACE_FILES.filter((file) => file.includes('/dto/')).flatMap((file) => {
        const source = read(file);
        const inQueryDto = /export class \w*Query\w*Dto/.test(source);
        if (!inQueryDto) return [];

        return [...source.matchAll(/^\s{2}([a-z]+_[a-z_]+)[?!]?:/gm)].map(
          ([, property]) => `${name(file)}: ${property}`,
        );
      });

      expect(offenders).toEqual([]);
    });

    it('every *QueryDto that extends something extends ListQueryDto or another query DTO', () => {
      const known = new Set(['ListQueryDto', ...listQueryDtos.map((d) => d.cls)]);
      const offenders = listQueryDtos
        .filter((d) => !known.has(d.base))
        .map((d) => `${d.file}: ${d.cls} extends ${d.base}`);

      expect(offenders).toEqual([]);
    });
  });

  describe('one response envelope', () => {
    it('every handler returning a page documents it with @ApiCursorPage', () => {
      const offenders = CONTROLLERS.filter((file) => {
        const source = read(file);
        return source.includes('CursorPageDto<') && !source.includes('@ApiCursorPage(');
      }).map(name);

      expect(offenders).toEqual([]);
    });

    it('every handler documented with @ApiCursorPage actually returns a page', () => {
      const offenders = CONTROLLERS.filter((file) => {
        const source = read(file);
        return source.includes('@ApiCursorPage(') && !source.includes('CursorPageDto');
      }).map(name);

      expect(offenders).toEqual([]);
    });
  });

  describe('the tenant boundary', () => {
    // `SessionAuthGuard` is the only thing that resolves `organizationId`. A
    // controller reading it from anywhere else lets a caller with a valid token
    // name a different tenant and read their money.
    /**
     * The operator console adds a second guard, and the rule has to name it explicitly rather
     * than accept any guard at all.
     *
     * `OperatorAuthGuard` resolves an *operator* — an internal human with no
     * tenant of their own — and the routes behind it read across organizations
     * by construction: an adjudication queue that had to enumerate tenants
     * would miss the next provider onboarded. That is the opposite of what
     * `SessionAuthGuard` guarantees, which is exactly why it is a different
     * guard on a different route prefix rather than a flag on this one.
     *
     * The list is closed on purpose. A controller behind neither guard is a
     * public route, and a controller behind `OperatorAuthGuard` that was meant
     * to be tenant-scoped is a data leak — so a new file appears here only by
     * somebody adding it, which is the conversation this test exists to force.
     */
    const OPERATOR_SURFACE = new Set([
      // `A-9`/`A-10`, the account blocklist. The subject of a block is never the
      // caller, and a blocked tenant must not be the one who can lift it.
      // The arbiter page (D-19): records disputed on chain and the unsigned
      // rulings and blocks the arbiter's wallet signs. Nobody's tenant.
      // The two-person approvals inbox: actions queued by one operator for
      // another, across tenants like the actions themselves.
      'modules/operator/controllers/operator-approvals.controller.ts',
      'modules/operator/controllers/operator-arbiter.controller.ts',
      'modules/operator/controllers/operator-blocks.controller.ts',
      'modules/operator/controllers/operator-cases.controller.ts',
      // `A-15`–`A-23`: delisting and taking down tool sets and public names,
      // renames and reassignments, and the reports queue. The subject is a
      // publisher who is never the caller.
      'modules/operator/controllers/operator-moderation.controller.ts',
      // `P-10`–`P-12`, the standard contract editor. A STANDARD tool is the
      // platform's: nobody's tenant.
      'modules/operator/controllers/operator-contracts.controller.ts',
      // `A-12`–`A-14`, the operator directory. Operators have no tenant.
      'modules/operator/controllers/operator-operators.controller.ts',
      'modules/operator/controllers/operator-override-log.controller.ts',
      // `V-7`, the only writer of `providers.verified`. Its subject is a
      // provider who is never the caller, so it belongs with the rest of the
      // operator surface rather than behind `SessionAuthGuard`.
      'modules/operator/controllers/operator-providers.controller.ts',
      'modules/operator/controllers/operator-reference.controller.ts',
      // The tool-request triage queue. Same shape as the adjudication queue above: a
      // worklist of tickets filed by tenants, read by an operator who has none.
      // Note the split — the provider's own `tool-requests.controller.ts` is
      // behind `SessionAuthGuard` and is not here, so filing and triaging are
      // two surfaces rather than one route with a role flag.
      'modules/tool-request/controllers/operator-tool-requests.controller.ts',
      // The Prometheus scrape endpoint and the operator dashboard
      // that renders the same numbers. Neither has a tenant — every series is
      // a platform-wide aggregate, the same shape `operator-reference.controller.ts`
      // already serves at `GET /operator/health`.
      'modules/observability/controllers/metrics.controller.ts',
      'modules/observability/controllers/observability-dashboard.controller.ts',
    ]);

    it('every surface controller is behind SessionAuthGuard', () => {
      const offenders = CONTROLLERS.filter(
        (file) => !OPERATOR_SURFACE.has(name(file)) && !PUBLIC_SURFACE.has(name(file)),
      )
        .filter((file) => !read(file).includes('SessionAuthGuard'))
        .map(name);

      expect(offenders).toEqual([]);
    });

    it('a public controller declares no guard at all, rather than a weaker one', () => {
      // The failure this guards against is subtler than a missing entry above:
      // a route that IS meant to be public but picks up `OperatorAuthGuard` on
      // the way past, and then 401s every reader while still looking exempt
      // here.
      const offenders = CONTROLLERS.filter((file) => PUBLIC_SURFACE.has(name(file)))
        .filter((file) => /@UseGuards\(/.test(read(file)))
        .map(name);

      expect(offenders).toEqual([]);
    });

    it('a public controller covers only the routes it was argued for', () => {
      // `PUBLIC_SURFACE` exempts a FILE from two gates, but each entry argues
      // for the routes that were on the controller when it was written. A
      // handler added later inherits the exemption in silence — which on this
      // list means an unguarded route nobody discussed. Counting them makes
      // that a red test, and the fix is to extend the entry's prose and the
      // number together, which is the conversation the list exists to force.
      //
      // Read from disk by path rather than filtered out of `CONTROLLERS`,
      // because `EXCLUDED_DIRS` drops `mcp/` — so the demo entry is checked
      // here and nowhere else.
      const offenders = [...PUBLIC_SURFACE.entries()]
        .map(([file, argued]) => {
          const source = read(join(SRC, file));
          const routes = (source.match(/@(Get|Post|Put|Patch|Delete|All)\(/g) ?? []).length;
          return { file, argued, routes };
        })
        .filter(({ argued, routes }) => argued !== routes)
        .map(({ file, argued, routes }) => `${file}: argued for ${argued}, declares ${routes}`);

      expect(offenders).toEqual([]);
    });

    it('every operator controller is behind OperatorAuthGuard, and none is behind both', () => {
      const offenders = [...OPERATOR_SURFACE].filter((file) => {
        // Read the `@UseGuards(...)` call, not the whole file. A guard named in
        // a comment is prose, and failing a build over prose teaches people to
        // stop writing it.
        const guards = read(join(SRC, file)).match(/@UseGuards\(([^)]*)\)/s)?.[1] ?? '';
        // Both guards on one controller would mean two different answers to
        // "whose rows are these", decided by whichever ran last.
        return !guards.includes('OperatorAuthGuard') || /\bSessionAuthGuard\b/.test(guards);
      });

      expect(offenders).toEqual([]);
    });

    /**
     * `organizationId IS NOT NULL` is a real predicate with a real use, and it
     * is also the exact shape that defeats the tenant guard.
     *
     * `OrganizationScopedRepository` checks that a query *mentions*
     * `organization_id`, not that it binds it to the caller — its own docs say
     * so: "it stops the accident, not the deliberate act". `IS NOT NULL`
     * satisfies the check while reading every tenant's rows.
     *
     * The provider reports need exactly that. A provider's traffic is spread
     * across the buyer organizations that called it, so scoping those queries
     * to the *caller's* organization would return nothing. The reads are
     * correct, their projections carry no buyer identity, and each service
     * documents the choice.
     *
     * What must not happen is a *new* one appearing without anybody noticing.
     * So the idiom is allowlisted by file: adding a cross-tenant read is fine,
     * adding one silently is not, and this test is the conversation.
     */
    it('every cross-tenant read is on the allowlist and says so', () => {
      const ALLOWED = new Set([
        'modules/provider/services/provider-traffic.service.ts',
        'modules/provider/services/provider-quality.service.ts',
        'modules/provider/services/provider-earnings.service.ts',
        'modules/provider/services/provider-payouts.service.ts',
        'modules/provider/services/provider-sla-windows.service.ts',
        // The verdict feed and the call-class
        // reconciliation, the seventh and eighth services on this idiom. A
        // provider's verdicts and calls are spread across every buying
        // organization; scoping either to the caller's own tenant returns
        // nothing, which is the same gap the evidence pack closed.
        'modules/provider/services/provider-verdict.service.ts',
        'modules/provider/services/provider-reconciliation.service.ts',
        // Disputes. `DisputeService.assertSubjectExists` is the one
        // entry here that is not a report: it tries the payer-scoped lookup
        // first and only falls through to `provider_id` on a miss, so the
        // cross-tenant read is the *second* attempt rather than the query. A
        // provider disputing a call they served is found no other way.
        'modules/dispute/services/dispute.service.ts',
        // The per-call export lives on the repository rather than a
        // provider service — `PaymentIntentRepository.exportQueryBuilder` is
        // the sixth cross-tenant read, same justification as the five above.
        'database/postgres/repositories/payment-intent.repository.ts',
        // The hourly payout batch runs once per deployment, not once per
        // tenant: `ProviderRepository.findAllProviders` and
        // `ProviderPayoutRepository.findResumable` both consider every
        // organization in one pass, the same shape as the five provider
        // report services above.
        'database/postgres/repositories/provider.repository.ts',
        'database/postgres/repositories/provider-payout.repository.ts',
        // The binding catalogue read. Routing is the one operation in the system
        // that is *about* comparing tenants: an agent asks for `search_web`
        // and the router weighs every provider who implements it, so
        // `ToolBindingRepository.findByTool` cannot be scoped to the caller
        // without meaning "route me to myself".
        'database/postgres/repositories/tool-binding.repository.ts',
        // The evidence pack, and the sharpest case of the idiom yet: the
        // tenant on an `evidence_packs` row is the **buying** organization,
        // while the party the verdict charges is the provider. Scoping
        // `findByVerdictIdForProvider` to the caller's own organization would
        // not narrow the answer, it would return nothing — which defeats the
        // evidence pack's whole justification: that a provider can see why they
        // were charged. The projection the controller
        // returns drops `seq` and `prev_hash`, so the buyer's chain position —
        // a count of their verdicts — never crosses the boundary.
        'database/postgres/repositories/evidence-pack.repository.ts',
        // The retention sweep is the platform's promise, not a tenant's: a
        // sweep that had to be told which organizations exist would keep a body
        // forever the first time a new tenant was missed.
        'database/postgres/repositories/evidence-body.repository.ts',
        // The other half of the same sweep. `verification_records` holds the
        // ORIGINAL bodies — `evidence_bodies` is only the sealed copy — so a
        // retention pass that stopped at the copy would leave the platform
        // holding every request body it ever received while a test asserting
        // "the body is gone" passed. `scrubBodiesOlderThan` writes nulls across
        // tenants and reads nothing back.
        'database/postgres/repositories/verification-record.repository.ts',
        // The free-tier call records, and the third sweep of the same shape:
        // a `ToolCallRecord` is kept 30 days, and that is the platform's retention promise rather than any
        // one tenant's. `deleteExpired` is the only cross-tenant read on the
        // table; every quota count beside it is scoped to an agent.
        'database/postgres/repositories/tool-call-record.repository.ts',
        // The credential-expiry sweep — the fourth sweep of the same shape,
        // and the first that lives on a service rather than a repository:
        // `AgentCredentialRepository` takes no new methods outside
        // `notification*.repository.ts`, so the query builder call sits in
        // `CredentialExpirySweepService.sweep` instead. `agent_credentials`
        // has never had a sweeper, and warning every organization before its
        // own credential lapses is the platform's promise, not any one
        // tenant's query.
        'modules/account/services/credential-expiry-sweep.service.ts',
        // Slash proposals. The adjudication queue, the two due-process
        // sweepers and the execution pass all run without a calling tenant:
        // two of them are scheduler ticks, and the third serves an operator
        // who has no organization of their own. `findQueue` is the sharpest
        // case — a queue scoped to the caller would be empty for every
        // adjudicator, since none of them is a provider.
        'database/postgres/repositories/slash-proposal.repository.ts',
        // The co-failure count, and it is cross-tenant for the reason it is
        // wanted at all: "show me every other binding that
        // failed at the same minute" is a question *about* comparing tenants,
        // and scoping it to one would answer a different question.
        'database/postgres/repositories/slash-case-read.repository.ts',
        // The operator console's platform-health tiles. Every figure on them — intents per
        // minute, verification backlog, our own false-positive rate — is a
        // platform number by definition; a per-tenant version would be a
        // different, less useful measurement that nobody asks for.
        'database/postgres/repositories/platform-metrics.repository.ts',
        // The buyer catalogue, and the sharpest instance yet of the
        // pattern `provider-verification.service.ts` already established: the
        // tenant on an `sla_windows` row is the **provider being measured**,
        // while the caller is a buyer who is by definition somebody else.
        // `qualityByProvider` scoped to the caller's own organization would not
        // narrow the answer, it would return nothing — a buyer has no windows.
        // The projection is two integers per provider: no window id, no
        // deadline, no strike, and no buyer identity. Closed windows only, so
        // what crosses the boundary is a settled figure rather than one still
        // moving. `CatalogueService` composes this and writes no SQL of its
        // own, deliberately, so that this list stays the whole conversation.
        'database/postgres/repositories/sla-window.repository.ts',
        // The public proof-of-reserves page. The `Accounts` tile sits
        // beside a platform-wide vault balance, so the count it needs is the
        // platform's: scoping `countFundedCustomerAccounts` to a tenant would
        // not narrow the answer, it would answer a different question, and the
        // page has no caller identity to scope to — it is served with no guard
        // and no session. The projection is a single integer: no account id, no
        // balance, no tenant. `sumLiabilities` on this same file has always read
        // across tenants for the same reason and reached the guard the other
        // way, through `COUNT(DISTINCT organization_id)`; this entry is what
        // finally puts that behaviour on the register too.
        'database/postgres/repositories/account-balance.repository.ts',
        // The live demo's compensation strip. The agent's share of an executed
        // slash is on no column of `slash_proposals` and cannot be derived by
        // subtraction — the provider retains a tenth, so `applied − platform`
        // is wrong by exactly that. It is summed from the ledger's
        // SLASH_DISTRIBUTION credits, which belong to whichever buyers were
        // harmed; there is no single tenant to scope to, and the projection is
        // one integer naming nobody.
        'database/postgres/repositories/ledger-entry.repository.ts',
        // The EVM gas-grant ledger, and the two reads on it are cross-tenant
        // for two different reasons that both have to be said.
        //
        // `hasGranted` is the once-ever bound, and the bound is on an ADDRESS.
        // An organization-scoped read cannot see a row another tenant wrote, so
        // scoping it would hand an attacker who can create organizations one
        // grant per organization to the same address — which is the whole
        // control, gone. `uniq_evm_gas_grants_account` carries no
        // `organization_id` for the same reason.
        //
        // `grantedWeiSince` is the daily cap, and the cap bounds the RELAYER's
        // float. The float is one pot shared by every tenant; summing one
        // tenant's share of it would measure something nobody asked about.
        //
        // Neither read projects a row: one returns a boolean, the other a sum.
        'database/postgres/repositories/evm-gas-grant.repository.ts',
      ]);

      const found = SURFACE_FILES.filter(
        (file) => crossTenantPredicates(read(file)).length > 0,
      ).map(name);

      const unlisted = found.filter((file) => !ALLOWED.has(file));
      expect(unlisted).toEqual([]);

      // And each one explains itself, so the next reader does not have to
      // reconstruct why the tenant predicate is absent.
      const undocumented = found.filter(
        (file) =>
          !/deliberately cross-organization|cross-organization/i.test(read(join(SRC, file))),
      );
      expect(undocumented).toEqual([]);
    });

    /**
     * Controls for the gate above, because a detector nobody has tried in both
     * directions is a detector nobody knows the direction of — and this one has
     * been wrong in both.
     *
     * These are synthetic sources rather than repository files on purpose: the
     * fixture is the point, and pointing at a real file would make the control
     * fail the day that file is refactored for unrelated reasons.
     */
    describe('the cross-tenant detector, controlled', () => {
      it('flags the canonical escape hatch', () => {
        expect(
          crossTenantPredicates(`qb.where('provider.organizationId IS NOT NULL')`),
        ).toHaveLength(1);
      });

      it('flags the tautology that used to pass — the false negative that motivated this', () => {
        // Measured by review: this reads EVERY tenant's rows, satisfies
        // `OrganizationScopedRepository`'s runtime SQL guard, and the old
        // substring gate stayed green on it.
        expect(
          crossTenantPredicates(`qb.where('e.organizationId = e.organizationId')`),
        ).toHaveLength(1);
      });

      it.each([
        ['snake_case null test', `qb.andWhere('e.organization_id IS NOT NULL')`],
        ['IS DISTINCT FROM NULL', `qb.andWhere('e.organizationId IS DISTINCT FROM NULL')`],
        ['unqualified tautology', `qb.orWhere('organizationId = organizationId')`],
      ])('flags %s', (_label, source) => {
        expect(crossTenantPredicates(source)).toHaveLength(1);
      });

      it('does NOT flag a correctly scoped predicate', () => {
        expect(
          crossTenantPredicates(
            `qb.where('e.organizationId = :organizationId', { organizationId })`,
          ),
        ).toEqual([]);
        expect(crossTenantPredicates(`qb.where('e.organizationId IN (:...ids)', { ids })`)).toEqual(
          [],
        );
      });

      it('flags the tautology even when the predicate also binds a parameter', () => {
        // This is why the self-comparison rule captures the alias on both sides
        // instead of leaning on "binds nothing": a tautology hidden beside a
        // real bound predicate still excludes no tenant, and it is the shape a
        // deliberate escape hatch would take.
        expect(
          crossTenantPredicates(
            `qb.where('e.organizationId = e.organizationId AND e.id = :id', { id })`,
          ),
        ).toHaveLength(1);
      });

      it('does NOT flag a two-alias correlation beside a bound tenant predicate', () => {
        // `a.organizationId = b.organizationId` correlates two tables; it is the
        // bound half beside it that names the tenant. Alone and unbound it IS
        // flagged — a join predicate that takes no tenant as input constrains
        // no caller — which is the conservative direction for this gate.
        expect(
          crossTenantPredicates(
            `qb.where('a.organizationId = b.organizationId AND a.organizationId = :orgId', { orgId })`,
          ),
        ).toEqual([]);
        expect(
          crossTenantPredicates(`qb.where('a.organizationId = b.organizationId')`),
        ).toHaveLength(1);
      });

      it('does NOT flag prose — the false positive that reddened a correct change', () => {
        // A doc comment saying the method does *not* use the idiom tripped the
        // old gate. Both comment forms are covered.
        expect(
          crossTenantPredicates(
            `/**\n * Deliberately not the organizationId IS NOT NULL idiom.\n */\n` +
              `// organizationId IS NOT NULL would read every tenant.\n` +
              `qb.where('e.organizationId IN (:...ids)', { ids });`,
          ),
        ).toEqual([]);
      });

      it('does NOT flag a predicate on some other column', () => {
        expect(crossTenantPredicates(`qb.where('e.bindingId IS NOT NULL')`)).toEqual([]);
      });
    });

    it('no controller accepts organizationId as input', () => {
      const offenders = CONTROLLERS.filter((file) =>
        /@(Query|Body|Param|Headers)\(\s*['"]organizationId['"]/.test(read(file)),
      ).map(name);

      expect(offenders).toEqual([]);
    });

    /**
     * The rule stops a tenant-scoped response echoing the tenant back — a field
     * a client could compare, or worse, learn a foreign id from.
     *
     * The operator override log is the one place where the organization is not the
     * *reader's* tenant but the **subject** of an intervention: "we suspended
     * this proposal, and it belonged to that provider". An operator reading the
     * register with the tenant stripped out would see a list of actions with no
     * way to tell whose money they touched, which is the opposite of what an
     * audit register is for. The field is nullable there precisely because a
     * platform-wide action has no subject tenant.
     *
     * Allowlisted by file rather than by field name, so a second
     * `organizationId` appearing in the same DTO file still needs somebody to
     * decide it belongs.
     */
    const TENANT_IS_THE_SUBJECT = new Set([
      'modules/operator/dto/operator-console.dto.ts',
      // The tool-request queue row, for the same reason: an operator has no tenant of
      // their own and a worklist that could not say whose ticket each row is
      // would be untriageable. Only the operator row carries it — the
      // provider-facing `ToolRequestDto` in the same file does not, because a
      // tenant reading its own ticket learns nothing from being told its own id.
      'modules/tool-request/dto/tool-request.dto.ts',
    ]);

    it('no DTO on the surface declares an organizationId field', () => {
      const offenders = SURFACE_FILES.filter((file) => file.includes('/dto/'))
        .filter((file) => !TENANT_IS_THE_SUBJECT.has(name(file)))
        .filter((file) => /^\s+organizationId[?!]?:/m.test(read(file)))
        .map(name);

      expect(offenders).toEqual([]);
    });

    /**
     * A cross-tenant id must answer 404, never 403 — a 403 confirms the
     * resource exists, which is the leak.
     *
     * The rule is **not** "no 403 anywhere". A 403 is right when the caller is
     * authenticated, the resource is theirs, and they still may not do the
     * thing: `PROVIDER_SUSPENDED`, and `SETTLEMENT_WITHDRAWAL_SIGNATURE_REQUIRED`
     * whose whole point is that a session token authenticates but never moves
     * value. Those leak nothing, because the caller already knows the resource
     * exists.
     *
     * What must never be a 403 is a *lookup*. So this bans the framework
     * escape hatch outright, and bans a 403 on any code that names
     * finding/owning a resource. The behaviour itself is proven end-to-end in
     * the cross-organization integration test.
     */
    it('no surface code throws the framework ForbiddenException', () => {
      const offenders = SURFACE_FILES.filter((file) => /ForbiddenException/.test(read(file))).map(
        name,
      );

      expect(offenders).toEqual([]);
    });

    it('no lookup-shaped error code carries a 403', () => {
      const LOOKUP_SHAPED = /_(NOT_FOUND|NOT_YOURS|ACCESS_DENIED|NOT_OWNED|WRONG_ORGANIZATION)\b/;

      const offenders = SURFACE_FILES.filter((file) => file.endsWith('.errors.ts')).flatMap(
        (file) => {
          const source = read(file);
          // Each catalog entry: `code: X.CODE_NAME,` followed by `statusCode: n,`
          return [...source.matchAll(/code:\s*[\w.]*\.(\w+),\s*\n\s*statusCode:\s*(\d+)/g)]
            .filter(([, code, status]) => LOOKUP_SHAPED.test(code) && status === '403')
            .map(([, code]) => `${name(file)}: ${code}`);
        },
      );

      expect(offenders).toEqual([]);
    });
  });

  describe('one error shape', () => {
    it('no controller throws — errors come from services, via a domain catalog', () => {
      const offenders = CONTROLLERS.filter((file) => /^\s+throw\s+/m.test(read(file))).map(name);

      expect(offenders).toEqual([]);
    });

    it('no second global exception filter is registered', () => {
      const offenders = SURFACE_FILES.filter(
        (file) =>
          /useGlobalFilters/.test(read(file)) &&
          !/useGlobalFilters\(new AllExceptionsFilter\(\)\)/.test(read(file)),
      ).map(name);

      expect(offenders).toEqual([]);
    });
  });

  describe('documentation is a deliverable', () => {
    it('every controller tags itself, so the docs page groups rather than sprawls', () => {
      const offenders = CONTROLLERS.filter((file) => !read(file).includes('@ApiTags(')).map(name);

      expect(offenders).toEqual([]);
    });

    it('every handler carries an @ApiOperation summary', () => {
      const offenders = CONTROLLERS.filter((file) => {
        const source = read(file);
        const handlers = (source.match(/@(Get|Post|Patch|Put|Delete)\(/g) ?? []).length;
        const documented = (source.match(/@ApiOperation\(/g) ?? []).length;
        return handlers !== documented;
      }).map(name);

      expect(offenders).toEqual([]);
    });

    it('every controller declares bearer auth, so “Try it out” can authenticate', () => {
      // Except the public ones, which take no token — declaring bearer auth on
      // `/public/reserves` would put a padlock and a token field on the one
      // route whose whole claim is that it needs neither.
      const offenders = CONTROLLERS.filter((file) => !PUBLIC_SURFACE.has(name(file)))
        .filter((file) => !read(file).includes('@ApiBearerAuth'))
        .map(name);

      expect(offenders).toEqual([]);
    });
  });

  /**
   * A controller that exists but is not reachable.
   *
   * This file's own header says it reads source text rather than booting *"to
   * catch a controller that has been written but not yet registered in a
   * bootstrap module"* — and then never checked registration, so the hole it
   * names stayed open. Every gate above asks whether a controller is *correct*;
   * none asks whether anything serves it. A perfectly guarded, perfectly
   * documented controller in an `*-api.module.ts` that `app.module.ts` does not
   * import is 404 in production and green here.
   *
   * Source text, not reflection, and for a hard reason rather than a stylistic
   * one: importing `AppApiModule` under `test/jest-unit.json` fails to compile
   * before any assertion runs — `src/bull-board/bull-board.module.ts` is
   * `TS2349: This expression is not callable` on `basicAuth(...)`, a namespace
   * import that needs `esModuleInterop`, which ts-jest does not apply here. So
   * `Reflect.getMetadata('imports', AppApiModule)` is genuinely unavailable and
   * a grep is what is left. It is weaker — it cannot tell an import from a
   * mention in a comment — but it fails on the thing that actually happens,
   * which is a module written and never wired.
   */
  describe('every api module is reachable', () => {
    const API_MODULES = ALL_TS.filter((file) => file.endsWith('-api.module.ts'));
    const BOOTSTRAP = read(join(SRC, 'bootstrap/api/app.module.ts'));

    it('has api modules to check, so a passing run is not a vacuous one', () => {
      expect(API_MODULES.length).toBeGreaterThan(10);
    });

    const exportedClasses = (file: string) =>
      [...read(file).matchAll(/export class (\w+)/g)].map((match) => match[1]);
    const mentions = (source: string, cls: string) => new RegExp(`\\b${cls}\\b`).test(source);

    it('is imported by the API bootstrap, or it is a 404 nobody notices', () => {
      // Reachability is one hop, not zero. `_examples/` nests `DemoApiModule`
      // and `PostsApiModule` inside `ExamplesApiModule`, which the bootstrap
      // imports — they are reachable, and a rule that only reads
      // `app.module.ts` would report a working composition as broken. One hop
      // covers that and still fails the case that actually happens: a module
      // written and imported by nothing at all.
      const hosts = API_MODULES.filter((file) =>
        exportedClasses(file).some((cls) => mentions(BOOTSTRAP, cls)),
      ).map(read);

      const offenders = API_MODULES.flatMap((file) => {
        const exported = exportedClasses(file);
        // A file with no exported class is not an api module in the sense that
        // matters; a file with several must have at least one of them wired.
        if (exported.length === 0) return [];
        const reachable = exported.some(
          (cls) => mentions(BOOTSTRAP, cls) || hosts.some((host) => mentions(host, cls)),
        );
        return reachable ? [] : [`${name(file)} (${exported.join(', ')})`];
      });

      expect(offenders).toEqual([]);
    });
  });

  describe('the excluded reference module stays excluded', () => {
    // If `_examples` ever stops being the only user of the offset DTO, the
    // exclusion above is hiding a real divergence rather than describing one.
    it('the offset PaginationDto has no callers outside _examples', () => {
      const callers = ALL_TS.filter((file) => /\bPaginationDto\b/.test(read(file)))
        .map(name)
        // The reference module, which keeps it deliberately.
        .filter((file) => !file.includes('_examples'))
        // Where it is defined, and where the replacement documents why.
        .filter((file) => !file.startsWith('shared/dtos/'))
        .filter((file) => !file.startsWith('shared/utils/pagination.util'))
        .filter((file) => !file.startsWith('shared/api/'));

      expect(callers).toEqual([]);
    });
  });
});
