import {
  agentLabelOf,
  agentPhrase,
  formatNoticeTime,
  toolNameOf,
} from '@modules/notification/domain/notice-text';

describe('notice-text', () => {
  it('writes a time as "Oct 14, 00:00 UTC", never ISO', () => {
    expect(formatNoticeTime(new Date('2026-10-14T00:00:00.000Z'))).toBe('Oct 14, 00:00 UTC');
    expect(formatNoticeTime(new Date('2026-01-03T09:05:59.000Z'))).toBe('Jan 3, 09:05 UTC');
  });

  it('names an agent by its label, or "Your agent"', () => {
    expect(agentPhrase('My first agent')).toBe('"My first agent"');
    expect(agentPhrase('  ')).toBe('Your agent');
    expect(agentPhrase(null)).toBe('Your agent');
  });

  it('reads the agent label inside its organization only', async () => {
    const findOne = jest.fn().mockResolvedValue({ label: 'research-bot' });
    await expect(agentLabelOf({ findOne } as never, 'org-1', 'agent-1')).resolves.toBe(
      'research-bot',
    );
    expect(findOne).toHaveBeenCalledWith({ where: { id: 'agent-1', organizationId: 'org-1' } });
  });

  it('never throws: a failed lookup is a missing name', async () => {
    const failing = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(agentLabelOf(failing as never, 'org-1', 'agent-1')).resolves.toBeNull();
    await expect(toolNameOf(failing as never, 'tool-1')).resolves.toBeNull();
    await expect(
      toolNameOf({ findOne: jest.fn().mockResolvedValue(null) } as never, 'tool-1'),
    ).resolves.toBeNull();
  });
});
