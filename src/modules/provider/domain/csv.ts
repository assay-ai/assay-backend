/**
 * RFC 4180 CSV encoding — the one place `ProviderCallsExportService` turns a
 * value into wire bytes.
 *
 * A tool id, a `status_reason` or a free-text reason can legitimately contain
 * a comma, a quote or a newline (a provider's own error message, echoed back
 * via `statusReason`). Handling that ad hoc at the call site is how a finance
 * export corrupts silently — a comma in one row shifts every column after it
 * for the rest of the file, and nothing throws.
 */

/** Quotes and escapes one field per RFC 4180. `null`/`undefined` become an empty field. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** One CSV row (no trailing newline) from already-ordered field values. */
export function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(csvField).join(',');
}

/** A CSV line, `\r\n`-terminated per RFC 4180 — the terminator most spreadsheet tools expect. */
export function csvLine(values: ReadonlyArray<string | number | null | undefined>): string {
  return `${csvRow(values)}\r\n`;
}
