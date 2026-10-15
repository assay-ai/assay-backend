/**
 * The shared shape of every list endpoint on the REST surface.
 *
 * One pagination style, one filter style, one sort style, one error shape.
 * Import from here rather than reaching into the files — a controller that
 * builds its own paging is the thing this barrel exists to make conspicuous,
 * and `test/unit/shared/api/surface-consistency.spec.ts` fails the build on it.
 */
export { CursorPageDto, PageInfoDto } from './dto/cursor-page.dto';
export {
  ListQueryDto,
  SortDirection,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './dto/list-query.dto';
export { encodeCursor, decodeCursor } from './cursor';
export type { CursorPosition, DecodedCursor } from './cursor';
export {
  paginate,
  toPage,
  resolveSort,
  applyTimeWindow,
  asInstant,
  asExactNumber,
  encodeCompositeCursor,
  decodeCompositeCursor,
} from './keyset';
export type { ListSpec, SortableField } from './keyset';
export { paginateArray } from './paginate-array';
export { ApiCursorPage } from './swagger/api-cursor-page.decorator';
export { ApiErrors, ApiErrorCode } from './errors/api.errors';
