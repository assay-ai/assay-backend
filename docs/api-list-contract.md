# The list contract

Every list endpoint on the REST surface takes the same query envelope, returns
the same page envelope, sorts the same way, and fails the same way. This file is
the contract. If an endpoint you are writing needs to differ from it, that is a
discussion to have before writing it, not a local exception to make quietly.

> **Why it is worth being strict about.** Two pagination styles in one API is a
> cost the frontend pays forever: two list components, two "load more"
> behaviours, two empty states, two ways to be at the end of a collection —
> multiplied by every screen. The endpoint author saves an hour; every client
> author loses one, repeatedly.

## Import surface

Everything comes from `@shared/api`. Do not reach into the files beneath it.

```ts
import {
  ListQueryDto,      // the query envelope — extend this, never replace it
  CursorPageDto,     // the response envelope
  ApiCursorPage,     // Swagger decorator for a page of a concrete DTO
  paginate,          // runs a prepared QueryBuilder as one page
  toPage,            // packages already-fetched rows (non-SQL sources)
  applyTimeWindow,   // applies `from` / `to`
  asInstant,         // cursor serialiser for a timestamptz column
  asExactNumber,     // cursor serialiser for numeric / bigint
  type ListSpec,
} from '@shared/api';
```

## The query envelope

`ListQueryDto` gives every list endpoint:

| Param | Meaning |
|---|---|
| `cursor` | Opaque. From the previous page's `pageInfo.nextCursor`. |
| `limit` | 1–100, default 25. |
| `sort` | A key of the resource's `sortable` map. |
| `order` | `asc` \| `desc`, default `desc`. |
| `from` / `to` | Half-open `[from, to)` on the resource's time column. |
| `search` | Free text over the resource's searchable fields. |

**Resource-specific filters extend it:**

```ts
export class ListVerdictsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: VerdictStatus, isArray: true })
  @IsOptional()
  @IsEnum(VerdictStatus, { each: true })
  @TransformToArray()          // `@shared/decorators` — accepts CSV and repeated params
  status?: VerdictStatus[];
}
```

Filters are **AND**-ed; a repeated value within one filter is **OR**-ed
(`?status=FAIL&status=MISAPPLIED` means either). Do not invent a second
convention for this.

## The response envelope

```jsonc
{
  "data": {
    "items": [ … ],                      // always an array, never null
    "pageInfo": { "nextCursor": "eyJ2Ijox…", "hasMore": true }
  },
  "statusCode": 200,
  "message": "Success"
}
```

`TransformInterceptor` adds the outer wrapper. You return the `CursorPageDto`.

There is **no total count**. A total on a collection that grows while you page
it is stale before it renders, and it costs the full scan cursors exist to
avoid. Screens that need totals read them from a summary endpoint
(`/receipts/summary` and its siblings), which aggregates server-side and can say
what window it counted.

## Writing one

```ts
// 1. Declare how the resource sorts and filters. Next to the repository.
const VERDICT_LIST: ListSpec = {
  alias: 'record',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'record.created_at',
      type: 'timestamptz',
      valueOf: asInstant((r: VerificationRecordEntity) => r.createdAt),
    },
    score: { … },
  },
};

// 2. Build the query — filters, joins, and the organizationId predicate.
async list(organizationId: string, query: ListVerdictsQueryDto) {
  const qb = this.records
    .createQueryBuilder('record')
    .where('record.organizationId = :organizationId', { organizationId });

  applyTimeWindow(qb, query, VERDICT_LIST);
  if (query.status?.length) {
    qb.andWhere('record.verdictStatus IN (:...status)', { status: query.status });
  }

  // 3. Hand it over. Ordering, the keyset bound and the limit are applied here.
  const page = await paginate(qb, query, VERDICT_LIST);
  return page.map((row) => this.toDto(row));
}
```

```ts
// 4. The controller stays thin.
@Get()
@ApiOperation({ summary: 'Verdicts, newest first' })
@ApiCursorPage(VerdictDto)
async list(
  @CurrentSession() session: McpSession,
  @Query() query: ListVerdictsQueryDto,
): Promise<CursorPageDto<VerdictDto>> {
  return this.verdicts.list(session.organizationId, query);
}
```

### Rules that are not negotiable

1. **Every sortable column must be `NOT NULL`.** A row-value comparison
   involving `NULL` is `NULL`, so rows with no value drop out of pagination
   entirely — not mis-ordered, *missing*, and missing without an error. Expose
   the nullable field as a filter and sort on `created_at`.
2. **The sort column needs an index ending in the tiebreak**, i.e.
   `(organization_id, <sort column>, id)`. Without it the keyset seek is a scan
   and the whole exercise was pointless. Add the index in your migration.
3. **`organizationId` comes from `@CurrentSession()` and nowhere else.** Never
   from a query param, a body field or a header. See
   `src/shared/auth/session-auth.guard.ts`.
4. **A cross-organization id is a `404`, never a `403`.** See below.
5. **Use `paginate`.** A controller that slices an array by hand, or a service
   that takes `page`/`offset`, is the thing this document exists to prevent.

## Cross-organization access returns 404

Organization A asking for organization B's resource id gets
`404 <DOMAIN>_NOT_FOUND`. Not `403`.

A `403` says *"this exists, and it is not yours"* — which confirms the resource
exists. That is an information leak on its own: an attacker enumerating ids
learns which are real by the status code alone, without ever reading a body.
`404` says *"there is no such thing here"*, which is both safer and, from the
caller's tenant, true.

This falls out of the architecture rather than needing per-endpoint care:
`OrganizationScopedRepository` constrains every query to the caller's
`organizationId`, so another tenant's row simply is not found, and the service
raises its domain's `notFound`. **What you must not do** is add an ownership
check that raises `Forbidden` — that reintroduces exactly the leak.

```ts
const record = await this.records.findOne({ where: { organizationId, id } });
if (!record) throw VerificationErrors.verdictNotFound({ id });   // 404
```

## Errors

One shape, from `AllExceptionsFilter`. Envelope failures — bad cursor, unknown
sort field, reversed time window — are already raised by `@shared/api` as
`API_*` codes; you do not catch or re-wrap them. Resource failures use your
module's own catalog (`docs/architecture.md` §"Error System").

## Non-SQL sources

A resource backed by a port rather than a table — the config-backed provider
registry, the in-memory tool catalogue — still returns the same envelope. Fetch
`limit + 1` items, sort them yourself, and call `toPage`. The client must not be
able to tell which endpoints are table-backed.
