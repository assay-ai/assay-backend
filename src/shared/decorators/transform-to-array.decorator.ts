import { Transform } from 'class-transformer';

/**
 * Transforms query parameter values to an array
 * Supports:
 * - Single value: 'id' -> ['id']
 * - Comma-separated: 'id,title,description' -> ['id', 'title', 'description']
 * - Multiple params: ['id', 'title'] -> ['id', 'title'] (already array)
 * - Undefined/null: undefined -> undefined
 */
export function TransformToArray() {
  return Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value;
    // Support comma-separated values or single string
    if (typeof value === 'string') return value.split(',').map((v) => v.trim());
    return [value];
  });
}
