/**
 * Shared column type configurations for entities
 *
 * NUMERIC_CONFIG: numeric(64, 12)
 * - Total digits: 64
 * - Decimal places: 12
 * - Integer part: 18 digits (max: 999,999,999,999,999,999)
 * - Handles large trading volumes (billions/trillions/quadrillions)
 */

export const NUMERIC_CONFIG = {
  type: 'numeric',
  precision: 64,
  scale: 12,
  default: 0,
} as const;
