/**
 * Regression for the mapping-nesting depth cap (LOW finding, 2026-10-25): a
 * self-inflicted deeply-nested mapping must be refused cleanly, not recursed
 * until the Node stack overflows and the caller's own save 500s.
 */
import { normalizeMappingNode } from '@modules/tool/domain/mapping';
import type { RawMappingNode } from '@modules/tool/domain/mapping';

function nest(levels: number): RawMappingNode {
  let node: Record<string, unknown> = { $const: 'leaf' };
  for (let i = 0; i < levels; i++) node = { inner: node };
  return node as RawMappingNode;
}

describe('mapping nesting depth cap', () => {
  it('normalizes a reasonably nested mapping without throwing', () => {
    expect(() => normalizeMappingNode(nest(10))).not.toThrow();
  });

  it('refuses a mapping nested past the ceiling instead of overflowing the stack', () => {
    expect(() => normalizeMappingNode(nest(500))).toThrow();
  });
});
