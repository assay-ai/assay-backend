import { ApiProperty } from '@nestjs/swagger';

/**
 * Where the caller is in the collection, and whether there is more of it.
 *
 * Two fields, and no total. See `ListQueryDto` for why a total is not here;
 * the short version is that on a collection which grows while you page it, a
 * total is a number that is wrong by the time it renders, bought with the same
 * full scan cursors exist to avoid.
 */
export class PageInfoDto {
  @ApiProperty({
    description:
      'Pass as `cursor` to fetch the next page. `null` on the last page — which is the ' +
      'only correct end-of-list signal: a short page does not mean the end, since filters ' +
      'are applied before the limit.',
    nullable: true,
    example:
      'eyJ2IjoxLCJrIjoiMjAyNi0wOC0xNVQxMDowMDowMC4wMDBaIiwiaSI6Ijk5OSIsInMiOiJjcmVhdGVkQXQ6ZGVzYyJ9',
  })
  nextCursor: string | null;

  @ApiProperty({
    description: 'Whether a further page exists. Equivalent to `nextCursor !== null`.',
    example: true,
  })
  hasMore: boolean;
}

/**
 * The response body of every list endpoint on this surface.
 *
 * `items` is always an array and never `null`; an empty collection is `[]` with
 * `hasMore: false`, so a client never branches on absence.
 *
 * This class is generic at the type level but **not** at the Swagger level —
 * decorators cannot see `T`. `@ApiCursorPage(ItemDto)` supplies the concrete
 * item schema to OpenAPI; see that decorator.
 */
export class CursorPageDto<T> {
  @ApiProperty({ isArray: true, description: 'The page. Empty array, never null.' })
  items: T[];

  @ApiProperty({ type: PageInfoDto })
  pageInfo: PageInfoDto;

  constructor(items: T[], nextCursor: string | null) {
    this.items = items;
    this.pageInfo = { nextCursor, hasMore: nextCursor !== null };
  }

  /** An empty page, for the branch where a query is answerable without a round trip. */
  static empty<T>(): CursorPageDto<T> {
    return new CursorPageDto<T>([], null);
  }

  /** Maps the items, preserving the page's position. */
  map<U>(fn: (item: T, index: number) => U): CursorPageDto<U> {
    return new CursorPageDto<U>(this.items.map(fn), this.pageInfo.nextCursor);
  }
}
