import { Transform } from 'class-transformer';

/**
 * Transform decorator to parse JSON string from query parameters
 * Useful for nested objects in query strings
 *
 * This decorator handles:
 * - JSON strings: '{"key":"value"}' -> {key: "value"}
 * - Already parsed objects: {key: "value"} -> {key: "value"}
 * - URL encoded JSON strings: '%7B%22key%22%3A%22value%22%7D' -> {key: "value"}
 * - Nested select fields: '{"select":"id,liquidity"}' -> {select: ["id", "liquidity"]}
 *
 * @example
 * ```typescript
 * @ParseJsonQuery()
 * @Type(() => EventFilterDto)
 * filter?: EventFilterDto;
 * ```
 */
export function ParseJsonQuery() {
  return Transform(({ value }) => {
    if (!value) return undefined;

    // Helper function to transform select fields from string to array
    const transformSelectField = (obj: any): any => {
      if (!obj || typeof obj !== 'object') return obj;

      // If this object has a select field that's a string, transform it
      if (obj.select && typeof obj.select === 'string') {
        obj.select = obj.select
          .split(',')
          .map((v: string) => v.trim())
          .filter(Boolean);
      }

      // Recursively transform nested objects
      for (const key in obj) {
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          obj[key] = transformSelectField(obj[key]);
        }
      }

      return obj;
    };

    // If already an object (and not an array), transform select fields and return
    if (typeof value === 'object' && !Array.isArray(value)) {
      return transformSelectField(value);
    }

    // If string, try to parse as JSON
    if (typeof value === 'string') {
      try {
        // Handle URL decoded strings (NestJS automatically decodes query params)
        const parsed = JSON.parse(value);
        // Transform select fields in the parsed object
        return transformSelectField(parsed);
      } catch (e) {
        // If parsing fails, return undefined
        // This allows ValidationPipe to handle validation errors
        return undefined;
      }
    }

    return undefined;
  });
}
