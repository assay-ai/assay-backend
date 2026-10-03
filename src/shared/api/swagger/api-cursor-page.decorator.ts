import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

import { CursorPageDto, PageInfoDto } from '../dto/cursor-page.dto';

/**
 * Documents a list endpoint's `200` as a cursor page of `item`.
 *
 * Decorators run on the class, not on the type argument, so
 * `@ApiOkResponse({ type: CursorPageDto<ReceiptDto> })` is not expressible —
 * TypeScript erases `T` before Swagger ever sees it, and the generated schema
 * would say `items: object[]`. A generated client built from that has no types
 * for the thing the endpoint actually returns, which defeats generating it.
 *
 * This composes the schema by hand instead: `allOf` the envelope with an
 * `items` array of the concrete model, and `@ApiExtraModels` to make sure the
 * model is emitted even when it appears nowhere else by name.
 *
 * ```ts
 * @Get()
 * @ApiCursorPage(ReceiptDto, 'Calls, newest first')
 * list(@Query() query: ListReceiptsQueryDto) { … }
 * ```
 */
export function ApiCursorPage<TModel extends Type<unknown>>(item: TModel, description?: string) {
  return applyDecorators(
    ApiExtraModels(CursorPageDto, PageInfoDto, item),
    ApiOkResponse({
      description: description ?? `A page of ${item.name}`,
      schema: {
        allOf: [
          {
            properties: {
              items: { type: 'array', items: { $ref: getSchemaPath(item) } },
              pageInfo: { $ref: getSchemaPath(PageInfoDto) },
            },
            required: ['items', 'pageInfo'],
          },
        ],
      },
    }),
  );
}
