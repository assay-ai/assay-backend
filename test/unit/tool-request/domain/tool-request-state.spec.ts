import {
  ToolRequestStatus,
  TOOL_REQUEST_TRANSITIONS,
  canTransition,
  isTerminal,
  requiresClosure,
  requiresFirstResponseStamp,
} from '@modules/tool-request/domain/tool-request-state';

const ALL_STATUSES = Object.values(ToolRequestStatus);

describe('canTransition', () => {
  it('allows OPEN to move straight to any of the three outcomes', () => {
    expect(canTransition(ToolRequestStatus.OPEN, ToolRequestStatus.ACKNOWLEDGED)).toBe(true);
    expect(canTransition(ToolRequestStatus.OPEN, ToolRequestStatus.ACCEPTED)).toBe(true);
    expect(canTransition(ToolRequestStatus.OPEN, ToolRequestStatus.DECLINED)).toBe(true);
  });

  it('allows ACKNOWLEDGED to move to either terminal outcome', () => {
    expect(canTransition(ToolRequestStatus.ACKNOWLEDGED, ToolRequestStatus.ACCEPTED)).toBe(true);
    expect(canTransition(ToolRequestStatus.ACKNOWLEDGED, ToolRequestStatus.DECLINED)).toBe(true);
  });

  it('refuses ACKNOWLEDGED back to OPEN', () => {
    expect(canTransition(ToolRequestStatus.ACKNOWLEDGED, ToolRequestStatus.OPEN)).toBe(false);
  });

  it('refuses any move out of a terminal state', () => {
    for (const terminal of [ToolRequestStatus.ACCEPTED, ToolRequestStatus.DECLINED]) {
      for (const target of ALL_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('refuses a no-op transition to the same state', () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('every listed destination is reachable and nothing else is', () => {
    for (const [from, destinations] of Object.entries(TOOL_REQUEST_TRANSITIONS)) {
      for (const to of ALL_STATUSES) {
        const expected = (destinations as readonly ToolRequestStatus[]).includes(to);
        expect(canTransition(from as ToolRequestStatus, to)).toBe(expected);
      }
    }
  });
});

describe('isTerminal', () => {
  it('is true for ACCEPTED and DECLINED only', () => {
    expect(isTerminal(ToolRequestStatus.OPEN)).toBe(false);
    expect(isTerminal(ToolRequestStatus.ACKNOWLEDGED)).toBe(false);
    expect(isTerminal(ToolRequestStatus.ACCEPTED)).toBe(true);
    expect(isTerminal(ToolRequestStatus.DECLINED)).toBe(true);
  });
});

describe('requiresClosure', () => {
  it('matches chk_tool_requests_closed_is_whole: only ACCEPTED and DECLINED', () => {
    expect(requiresClosure(ToolRequestStatus.OPEN)).toBe(false);
    expect(requiresClosure(ToolRequestStatus.ACKNOWLEDGED)).toBe(false);
    expect(requiresClosure(ToolRequestStatus.ACCEPTED)).toBe(true);
    expect(requiresClosure(ToolRequestStatus.DECLINED)).toBe(true);
  });
});

describe('requiresFirstResponseStamp', () => {
  it('matches chk_tool_requests_answered_is_timed: every status except OPEN', () => {
    expect(requiresFirstResponseStamp(ToolRequestStatus.OPEN)).toBe(false);
    expect(requiresFirstResponseStamp(ToolRequestStatus.ACKNOWLEDGED)).toBe(true);
    expect(requiresFirstResponseStamp(ToolRequestStatus.ACCEPTED)).toBe(true);
    expect(requiresFirstResponseStamp(ToolRequestStatus.DECLINED)).toBe(true);
  });
});
