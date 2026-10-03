import { diffPolicyDocuments } from '@modules/provider/domain/policy-diff';

describe('diffPolicyDocuments', () => {
  it('returns no entries for identical documents', () => {
    const doc = { passThreshold: 0.7, verifiers: [{ verifierId: 'v1' }] };

    expect(diffPolicyDocuments(doc, doc)).toEqual([]);
  });

  it('returns no entries when only key order differs — canonicalJson is the equality oracle', () => {
    const before = { a: 1, b: 2 };
    const after = { b: 2, a: 1 };

    expect(diffPolicyDocuments(before, after)).toEqual([]);
  });

  it('reports a top-level key added', () => {
    const before = { passThreshold: 0.7 };
    const after = { passThreshold: 0.7, otherwise: 'FAIL' };

    expect(diffPolicyDocuments(before, after)).toEqual([
      { path: '$.otherwise', changeType: 'added', before: undefined, after: 'FAIL' },
    ]);
  });

  it('reports a top-level key removed', () => {
    const before = { passThreshold: 0.7, otherwise: 'FAIL' };
    const after = { passThreshold: 0.7 };

    expect(diffPolicyDocuments(before, after)).toEqual([
      { path: '$.otherwise', changeType: 'removed', before: 'FAIL', after: undefined },
    ]);
  });

  it('reports a primitive value changed', () => {
    const before = { passThreshold: 0.7 };
    const after = { passThreshold: 0.9 };

    expect(diffPolicyDocuments(before, after)).toEqual([
      { path: '$.passThreshold', changeType: 'changed', before: 0.7, after: 0.9 },
    ]);
  });

  it('localises a change inside a nested object rather than reporting the whole subtree', () => {
    const before = { verifiers: [{ verifierId: 'v1', weight: 0.4 }] };
    const after = { verifiers: [{ verifierId: 'v1', weight: 0.6 }] };

    expect(diffPolicyDocuments(before, after)).toEqual([
      { path: '$.verifiers[0].weight', changeType: 'changed', before: 0.4, after: 0.6 },
    ]);
  });

  it('reports an appended array element as added, without disturbing unchanged elements', () => {
    const before = { verifiers: [{ verifierId: 'v1' }] };
    const after = { verifiers: [{ verifierId: 'v1' }, { verifierId: 'v2' }] };

    expect(diffPolicyDocuments(before, after)).toEqual([
      {
        path: '$.verifiers[1]',
        changeType: 'added',
        before: undefined,
        after: { verifierId: 'v2' },
      },
    ]);
  });

  it('reports a trailing array element removed', () => {
    const before = { verifiers: [{ verifierId: 'v1' }, { verifierId: 'v2' }] };
    const after = { verifiers: [{ verifierId: 'v1' }] };

    expect(diffPolicyDocuments(before, after)).toEqual([
      {
        path: '$.verifiers[1]',
        changeType: 'removed',
        before: { verifierId: 'v2' },
        after: undefined,
      },
    ]);
  });

  it('reports every path as changed when the same index holds a different value shape', () => {
    const before = { clauses: ['a', 'b'] };
    const after = { clauses: [{ rule: 'a' }, 'b'] };

    expect(diffPolicyDocuments(before, after)).toEqual([
      { path: '$.clauses[0]', changeType: 'changed', before: 'a', after: { rule: 'a' } },
    ]);
  });

  it('treats a missing in-force document as empty — every path in the pending document is added', () => {
    const after = { passThreshold: 0.7, verifiers: [{ verifierId: 'v1' }] };

    expect(diffPolicyDocuments(null, after)).toEqual([
      { path: '$.passThreshold', changeType: 'added', before: undefined, after: 0.7 },
      {
        path: '$.verifiers',
        changeType: 'added',
        before: undefined,
        after: [{ verifierId: 'v1' }],
      },
    ]);
  });

  it('treats a missing pending document as empty — every path in the in-force document is removed', () => {
    const before = { passThreshold: 0.7 };

    expect(diffPolicyDocuments(before, null)).toEqual([
      { path: '$.passThreshold', changeType: 'removed', before: 0.7, after: undefined },
    ]);
  });

  it('returns no entries when both documents are absent', () => {
    expect(diffPolicyDocuments(null, null)).toEqual([]);
  });

  it('sorts sibling keys so the diff order is deterministic', () => {
    const before = {};
    const after = { zeta: 1, alpha: 2 };

    expect(diffPolicyDocuments(before, after).map((entry) => entry.path)).toEqual([
      '$.alpha',
      '$.zeta',
    ]);
  });
});
