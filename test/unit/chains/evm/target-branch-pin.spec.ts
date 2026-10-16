import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { toEventSignature, toFunctionSelector } from 'viem';

import { EVM_ERROR_BY_SELECTOR } from '@modules/chains/evm/abi/error-selectors';
import {
  X402_CONFIG_EVENTS_ABI,
  X402_PROXY_EVENTS_ABI,
  X402_SLASH_WATCH_EVENTS_ABI,
  X402_STAKE_SLASH_ABI,
} from '@modules/chains/evm/abi/x402.abi';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';

/**
 * Audit T-3: the vendored error table, events and constants are compared with
 * the contract source of the branch the backend TARGETS — read with
 * `git show <ref>:<path>` from the assay-evm checkout, never from whatever its
 * working tree happens to have checked out.
 *
 * - `ASSAY_EVM_REF` (default `main`): the branch or commit
 *   that will be deployed.
 * - `ASSAY_EVM_DIR`: the checkout. Default: `assay-evm` beside this repo, or
 *   beside its parent (a worktree under `.wt/`).
 *
 * This repo is also cloned on its own (CI), where there is no contract
 * checkout; the suite then skips and says so. The hand-written pins in
 * `abi-selectors.spec.ts` and `constants-pin.spec.ts` still run everywhere.
 */
const REF = process.env.ASSAY_EVM_REF || 'main';
const REPO = resolve(__dirname, '../../../..');
const DIR = [
  process.env.ASSAY_EVM_DIR,
  join(REPO, '..', 'assay-evm'),
  join(REPO, '..', '..', 'assay-evm'),
].find((candidate): candidate is string => !!candidate && existsSync(join(candidate, '.git')));

function show(path: string): string {
  return execFileSync('git', ['-C', DIR as string, 'show', `${REF}:${path}`], {
    encoding: 'utf8',
  });
}

/** `struct Name { type a; … }` → canonical tuple types, for event signatures. */
function structsOf(source: string): Map<string, string> {
  const structs = new Map<string, string>();
  for (const match of source.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    const fields = match[2]
      .replace(/\/\/[^\n]*/g, '')
      .split(';')
      .map((field) => field.trim())
      .filter(Boolean)
      .map((field) => field.split(/\s+/)[0]);
    structs.set(match[1], `(${fields.join(',')})`);
  }
  // An enum is a uint8 in the ABI.
  for (const match of source.matchAll(/enum\s+(\w+)\s*\{/g)) structs.set(match[1], 'uint8');
  return structs;
}

/** Every `event Name(…);` in `source`, as its canonical signature. */
function eventsOf(source: string, structs: Map<string, string>): Map<string, string> {
  const events = new Map<string, string>();
  const code = source.replace(/\/\/[^\n]*/g, '');
  for (const match of code.matchAll(/event\s+(\w+)\s*\(([^)]*)\)\s*;/g)) {
    const types = match[2]
      .split(',')
      .map((param) => param.trim())
      .filter(Boolean)
      .map((param) => {
        const type = param.split(/\s+/)[0];
        return structs.get(type) ?? type;
      });
    events.set(match[1], `${match[1]}(${types.join(',')})`);
  }
  return events;
}

(DIR ? describe : describe.skip)(`the vendored contract surface, against assay-evm ${REF}`, () => {
  it('names every error Errors.sol declares, by the selector the chain will send', () => {
    const declared = [...show('src/Errors.sol').matchAll(/^error\s+(\w+)\s*\(\s*\)\s*;/gm)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    const missing = declared.filter(
      (name) => EVM_ERROR_BY_SELECTOR.get(toFunctionSelector(`${name}()`)) !== name,
    );
    expect(missing).toEqual([]);
    // And nothing the branch no longer declares (OpenZeppelin's two aside).
    const extra = [...EVM_ERROR_BY_SELECTOR.values()].filter(
      (name) => !declared.includes(name) && !name.startsWith('Ownable'),
    );
    expect(extra).toEqual([]);
  });

  it('watches events whose signatures the branch declares', () => {
    const structs = structsOf(show('src/Types.sol'));
    const config = eventsOf(show('src/X402Config.sol'), structs);
    const stake = eventsOf(show('src/X402Stake.sol'), structs);
    for (const entry of X402_CONFIG_EVENTS_ABI) {
      expect([entry.name, toEventSignature(entry)]).toEqual([entry.name, config.get(entry.name)]);
    }
    for (const entry of [
      ...X402_SLASH_WATCH_EVENTS_ABI,
      ...X402_STAKE_SLASH_ABI.filter((item) => item.type === 'event'),
    ]) {
      if (entry.type !== 'event') continue;
      expect([entry.name, toEventSignature(entry)]).toEqual([entry.name, stake.get(entry.name)]);
    }
    // ERC-1967, from OpenZeppelin rather than the branch.
    expect(X402_PROXY_EVENTS_ABI.map((entry) => toEventSignature(entry))).toEqual([
      'Upgraded(address)',
    ]);
  });

  it('copies the constants the branch declares', () => {
    const source = show('src/Constants.sol').replace(/\/\/[^\n]*/g, '');
    const values = new Map<string, bigint>();
    for (const match of source.matchAll(/constant\s+(\w+)\s*=\s*([^;]+);/g)) {
      let expression = match[2].replace(/_/g, '').replace(/\s+/g, '');
      for (const [name, value] of values) {
        expression = expression.replace(new RegExp(`\\b${name}\\b`, 'g'), String(value));
      }
      if (!/^[0-9+*()-]+$/.test(expression)) continue;
      values.set(match[1], BigInt(Function(`"use strict"; return (${expression});`)() as number));
    }
    const mismatched = Object.entries(EVM_CONSTANTS)
      .filter(([name]) => values.has(name))
      .filter(([name, value]) => BigInt(value) !== values.get(name))
      .map(([name, value]) => `${name}: backend ${value}, contract ${values.get(name)}`);
    expect(mismatched).toEqual([]);
  });
});
