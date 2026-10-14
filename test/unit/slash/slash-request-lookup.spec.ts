import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  LookupSlashRequestsBodyDto,
  SLASH_REQUEST_LOOKUP_MAX,
} from '@modules/slash/dto/slash-request-lookup.dto';
import { SlashRequestLookupService } from '@modules/slash/services/slash-request-lookup.service';

const ORG = '08773f92-21cd-4e53-8348-d3ef1dcc8378';
const CASE_ID = 'a'.repeat(64);
const PART_ID = 'b'.repeat(64);
const UNKNOWN = 'c'.repeat(64);

function build() {
  const proposals = {
    findOwnByChainRequestIds: jest.fn(async (_org: string, ids: readonly string[]) =>
      ids.includes(CASE_ID) ? [{ id: 'proposal-1', chainRequestId: CASE_ID }] : [],
    ),
  };
  const parts = {
    findOwnByChainRequestIds: jest.fn(async (_org: string, ids: readonly string[]) =>
      ids.includes(PART_ID)
        ? [{ id: 'part-1', proposalId: 'proposal-2', chainRequestId: PART_ID }]
        : [],
    ),
  };
  const service = new SlashRequestLookupService(proposals as never, parts as never);
  return { service, proposals, parts };
}

describe('SlashRequestLookupService', () => {
  it('answers a case id and a part id, and leaves an unknown one out', async () => {
    const { service } = build();

    const { matches } = await service.lookup(ORG, [`0x${PART_ID}`, `0x${UNKNOWN}`, `0x${CASE_ID}`]);

    // In the order asked; the part names its case.
    expect(matches).toEqual([
      { requestId: `0x${PART_ID}`, proposalId: 'proposal-2', partId: 'part-1' },
      { requestId: `0x${CASE_ID}`, proposalId: 'proposal-1' },
    ]);
  });

  it('matches in any case and asks once per id, scoped to the caller', async () => {
    const { service, proposals, parts } = build();

    const { matches } = await service.lookup(ORG, [`0x${CASE_ID.toUpperCase()}`, `0x${CASE_ID}`]);

    expect(matches).toEqual([{ requestId: `0x${CASE_ID}`, proposalId: 'proposal-1' }]);
    expect(proposals.findOwnByChainRequestIds).toHaveBeenCalledWith(ORG, [CASE_ID]);
    expect(parts.findOwnByChainRequestIds).toHaveBeenCalledWith(ORG, [CASE_ID]);
  });

  it('answers an empty list for an empty question', async () => {
    const { service } = build();
    await expect(service.lookup(ORG, [])).resolves.toEqual({ matches: [] });
  });
});

describe('LookupSlashRequestsBodyDto', () => {
  const errorsFor = async (body: unknown) =>
    validate(plainToInstance(LookupSlashRequestsBodyDto, body));

  it('accepts up to the maximum of 0x-prefixed bytes32, in any case', async () => {
    const ids = Array.from(
      { length: SLASH_REQUEST_LOOKUP_MAX },
      (_, i) => `0x${i.toString(16).padStart(64, 'A')}`,
    );
    expect(await errorsFor({ requestIds: ids })).toEqual([]);
    expect(SLASH_REQUEST_LOOKUP_MAX).toBe(200);
  });

  it('refuses one id more than the maximum', async () => {
    const ids = Array.from({ length: SLASH_REQUEST_LOOKUP_MAX + 1 }, () => `0x${CASE_ID}`);
    expect(await errorsFor({ requestIds: ids })).not.toEqual([]);
  });

  it.each([CASE_ID, `0x${CASE_ID.slice(1)}`, `0x${'g'.repeat(64)}`, `0x${CASE_ID}00`, 42])(
    'refuses %p',
    async (id) => {
      expect(await errorsFor({ requestIds: [id] })).not.toEqual([]);
    },
  );

  it('refuses a body with no list', async () => {
    expect(await errorsFor({})).not.toEqual([]);
  });
});
