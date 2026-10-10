import { ValidationPipe } from '@nestjs/common';

import { ListQueueQueryDto } from '@modules/operator/dto/operator-console.dto';

/**
 * Query strings arrive as strings. `@Type(() => Boolean)` runs `Boolean('false')`,
 * which is `true`, so `?mine=false` used to filter to the caller's own cases.
 */
describe('ListQueueQueryDto boolean filters', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const parse = (query: Record<string, string>) =>
    pipe.transform(query, {
      type: 'query',
      metatype: ListQueueQueryDto,
    }) as Promise<ListQueueQueryDto>;

  it.each(['mine', 'unassigned', 'overdue'] as const)('reads %s=false as false', async (key) => {
    await expect(parse({ [key]: 'false' })).resolves.toMatchObject({ [key]: false });
  });

  it.each(['mine', 'unassigned', 'overdue'] as const)('reads %s=true as true', async (key) => {
    await expect(parse({ [key]: 'true' })).resolves.toMatchObject({ [key]: true });
  });

  it('refuses a value that is neither true nor false', async () => {
    await expect(parse({ mine: 'yes' })).rejects.toBeDefined();
  });
});
