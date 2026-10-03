import { PaginationResponseDto } from '@shared/dtos/pagination.dto';

export interface CreatePaginationOptions<T> {
  results: T[];
  page: number;
  limit: number;
  totalItems: number;
}

/**
 * Create pagination response with calculated next/previous pages
 * @param options - Pagination options
 * @returns PaginationResponseDto with auto-calculated next/previous page numbers
 */
export function createPaginationResponse<T>(
  options: CreatePaginationOptions<T>,
): PaginationResponseDto<T> {
  const { results, page, limit, totalItems } = options;

  const totalPages = Math.ceil(totalItems / limit);
  const next = page < totalPages ? page + 1 : null;
  const previous = page > 1 ? page - 1 : null;

  return new PaginationResponseDto<T>({
    results,
    currentPage: page,
    pageSize: limit,
    totalItems,
    next,
    previous,
  });
}
