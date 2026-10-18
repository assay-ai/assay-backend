import { createDomainErrorFactory } from '@shared/errors/error-catalog';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { SettlementErrorCode } from '@modules/settlement/errors/settlement.errors';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { OrganizationErrorCode } from '@shared/errors/organization-scope.errors';
import { MoneyErrorCode } from '@shared/errors/money.errors';

const CATALOGS: Array<[string, Record<string, string>]> = [
  ['PAYMENT', PaymentErrorCode],
  ['LEDGER', LedgerErrorCode],
  ['TOOL', ToolErrorCode],
  ['PROVIDER', ProviderErrorCode],
  ['VERIFICATION', VerificationErrorCode],
  ['SETTLEMENT', SettlementErrorCode],
  ['MCP', McpErrorCode],
  ['CHAIN', ChainErrorCode],
  ['ORGANIZATION', OrganizationErrorCode],
  ['MONEY', MoneyErrorCode],
];

describe('domain error catalogs', () => {
  it.each(CATALOGS)('every %s code carries its prefix', (prefix, codes) => {
    const values = Object.values(codes);
    expect(values.length).toBeGreaterThan(0);

    for (const code of values) {
      expect(code.startsWith(`${prefix}_`)).toBe(true);
    }
  });

  it.each(CATALOGS)('%s enum keys and values match, so a code is greppable', (_prefix, codes) => {
    for (const [key, value] of Object.entries(codes)) {
      expect(value).toBe(key);
    }
  });

  it('codes are unique across every domain', () => {
    const all = CATALOGS.flatMap(([, codes]) => Object.values(codes));
    expect(new Set(all).size).toBe(all.length);
  });

  it('rejects a mis-prefixed code at import time rather than at request time', () => {
    expect(() =>
      createDomainErrorFactory('PAYMENT', {
        wrong: { code: 'LEDGER_HOLD_NOT_FOUND', statusCode: 404, message: () => 'x' },
      }),
    ).toThrow(/Error catalog violation/);
  });

  it('builds a factory whose errors carry code and status', () => {
    const errors = createDomainErrorFactory('PAYMENT', {
      thing: {
        code: 'PAYMENT_THING',
        statusCode: 409,
        message: (context?: Record<string, any>) => `thing ${context?.id}`,
      },
    });

    const error = errors.thing({ id: 'abc' });
    expect(error.errorCode).toBe('PAYMENT_THING');
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('thing abc');
  });
});
