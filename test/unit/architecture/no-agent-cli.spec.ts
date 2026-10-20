import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

/** Built from parts so that this file does not match itself. */
const NAME = ['agent', 'cli'].join('-');
const ENV_NAME = ['AGENT', 'CLI'].join('_');

/**
 * The old e2e agent CLI was retired: the local `assay-mcp` proxy holds the payment key and signs vouchers.
 * No tracked file outside `docs/history` may name it again.
 */
describe('the retired agent CLI is not referenced', () => {
  it('appears in no tracked file outside docs/history', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f && !f.startsWith('docs/history/'));
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), 'utf8');
      } catch {
        continue; // deleted in the working tree
      }
      if (text.includes(NAME) || text.includes(ENV_NAME)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
