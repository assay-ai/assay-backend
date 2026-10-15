/**
 * RFC 4180 CSV encoding. A finance export that mis-escapes a comma
 * corrupts silently rather than throwing, so this is a round-trip test: parse
 * back what was written and get the original value.
 */
import { callsExportFilename, csvField, csvLine, csvRow } from '@modules/provider/domain/csv';

/** A minimal RFC 4180 parser, independent of the encoder, for the round-trip tests. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = '';
      i += 1;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        value += line[i];
        i += 1;
      }
      fields.push(value);
      i += 1; // consume the following comma, if any
    } else {
      const next = line.indexOf(',', i);
      const end = next === -1 ? line.length : next;
      fields.push(line.slice(i, end));
      i = end + 1;
    }
    if (i > line.length) break;
  }
  return fields;
}

describe('csvField', () => {
  // Review P-10: a field a spreadsheet would evaluate as a formula.
  it.each(['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd'])(
    'neutralises %j with a leading quote',
    (value) => {
      expect(parseCsvLine(csvField(value))[0]).toBe(`'${value}`);
    },
  );

  it('leaves a plain signed amount alone', () => {
    expect(csvField('-0.05')).toBe('-0.05');
    expect(csvField(-12)).toBe('-12');
  });

  it('leaves a plain value unquoted', () => {
    expect(csvField('tool-search-web')).toBe('tool-search-web');
  });

  it('quotes a value containing a comma', () => {
    expect(csvField('search, web')).toBe('"search, web"');
  });

  it('doubles an internal quote and wraps the whole field', () => {
    expect(csvField('the "best" tool')).toBe('"the ""best"" tool"');
  });

  it('quotes a value containing a newline', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('quotes a value containing a carriage return', () => {
    expect(csvField('line one\r\nline two')).toBe('"line one\r\nline two"');
  });

  it('renders null and undefined as an empty field', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('stringifies a number', () => {
    expect(csvField(42)).toBe('42');
  });
});

describe('csvRow / csvLine — round trip', () => {
  const ADVERSARIAL_ROWS: ReadonlyArray<ReadonlyArray<string | number | null>> = [
    ['plain', 'values', 'here'],
    ['a tool, with a comma', 'reason: "quoted failure"', 'no-op'],
    ['multi\nline reason', 'x', 'y'],
    ['', null, 'trailing-empties'],
    ['exactly "one" pair of quotes', 'fine', '3'],
    ['comma,then"quote', 'then\nnewline', 'z'],
  ];

  it.each(ADVERSARIAL_ROWS)('round-trips row: %j', (...row) => {
    const encoded = csvRow(row);
    const decoded = parseCsvLine(encoded);
    expect(decoded).toEqual(row.map((v) => (v === null ? '' : String(v))));
  });

  it('csvLine terminates with CRLF', () => {
    expect(csvLine(['a', 'b'])).toBe('a,b\r\n');
  });
});

// BUG-R16-V1-02: the export downloaded as `calls-<from>_<to>.csv` with colons in it.
describe('callsExportFilename', () => {
  it('names the file assay-calls-<from>_<to>.csv with no colon in it', () => {
    expect(callsExportFilename('2026-10-01T00:00:00.000Z', '2026-10-16T00:00:00.000Z')).toBe(
      'assay-calls-2026-10-01T00-00-00.000Z_2026-10-16T00-00-00.000Z.csv',
    );
  });

  it('cannot put a quote into the Content-Disposition value', () => {
    expect(callsExportFilename('a"b', 'c;d')).toBe('assay-calls-a-b_c-d.csv');
  });
});
