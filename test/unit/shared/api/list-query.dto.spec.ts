import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListQueryDto, SortDirection } from '@shared/api/dto/list-query.dto';
import { ListOperatorCallDisputesQueryDto } from '@modules/dispute/dto/call-dispute.dto';

/**
 * The sort direction is lower case on the wire, but a client that sends
 * `DESC` / `ASC` must not get a 400: the operator call-dispute list failed
 * that way (the console sent upper case and every request was refused).
 */
describe('ListQueryDto.order', () => {
  async function parse<T extends object>(cls: new () => T, query: Record<string, unknown>) {
    const dto = plainToInstance(cls, query);
    const errors = await validate(dto);
    return { dto, errors };
  }

  it.each([
    ['DESC', SortDirection.DESC],
    ['desc', SortDirection.DESC],
    ['ASC', SortDirection.ASC],
    ['Asc', SortDirection.ASC],
  ])('accepts %s as %s', async (order, expected) => {
    const { dto, errors } = await parse(ListQueryDto, { order });
    expect(errors).toEqual([]);
    expect(dto.order).toBe(expected);
  });

  it('defaults to desc', async () => {
    const { dto, errors } = await parse(ListQueryDto, {});
    expect(errors).toEqual([]);
    expect(dto.order).toBe(SortDirection.DESC);
  });

  it('still refuses a value that is not a direction', async () => {
    const { errors } = await parse(ListQueryDto, { order: 'sideways' });
    expect(errors.map((e) => e.property)).toEqual(['order']);
  });

  it('contract: the operator call-dispute list accepts what the console sends', async () => {
    const { dto, errors } = await parse(ListOperatorCallDisputesQueryDto, {
      limit: '20',
      state: 'OPEN',
      order: 'ASC',
    });
    expect(errors).toEqual([]);
    expect(dto.order).toBe(SortDirection.ASC);
  });
});
