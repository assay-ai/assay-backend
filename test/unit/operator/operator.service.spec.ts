import { ConfigService } from '@nestjs/config';

import { OperatorService } from '@modules/operator/services/operator.service';

import { expectErrorCode, expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeOperatorRepository, buildOperator } from './helpers/fake-operator-repository';

/**
 * The operator directory's own small service — identity,
 * not arbitration. Two refusals matter enough to have their own error codes,
 * and both are operator-console requirements stated as code: no self-approval, and no
 * action by an operator who has been suspended since their token last
 * resolved.
 */
describe('OperatorService', () => {
  function build(config: Record<string, string> = {}) {
    const repo = new FakeOperatorRepository();
    const configService = { get: (key: string) => config[key] } as unknown as ConfigService;
    return { service: new OperatorService(repo as never, configService), repo };
  }

  describe('toDto', () => {
    it('renders a null authority limit as null, not a zero-amount MoneyDto', () => {
      const { service } = build();
      const operator = buildOperator({ authorityLimitMinor: null });

      expect(service.toDto(operator).authorityLimit).toBeNull();
    });

    it('renders a bounded authority limit as minor units of the platform asset', () => {
      const { service } = build({ PLATFORM_STAKE_ASSET_ID: 'solana:mainnet/token:usdc' });
      const operator = buildOperator({ authorityLimitMinor: '5000000' });

      expect(service.toDto(operator).authorityLimit).toEqual({
        amount: '5000000',
        asset: 'solana:mainnet/token:usdc',
        decimals: 6,
      });
    });

    it('carries id, subject, displayName, roles and status through unchanged', () => {
      const { service } = build();
      const operator = buildOperator({
        id: 'op-1',
        subject: 'dan@',
        displayName: 'Dan',
        roles: ['ADJ', 'ADJL'],
        status: 'ACTIVE',
      });

      expect(service.toDto(operator)).toMatchObject({
        id: 'op-1',
        subject: 'dan@',
        displayName: 'Dan',
        roles: ['ADJ', 'ADJL'],
        status: 'ACTIVE',
      });
    });
  });

  describe('requireActive', () => {
    it('returns the operator when active', async () => {
      const { service, repo } = build();
      repo.seed(buildOperator({ id: 'op-1', status: 'ACTIVE' }));

      await expect(service.requireActive('op-1')).resolves.toMatchObject({ id: 'op-1' });
    });

    it('refuses an id with no such row', async () => {
      const { service } = build();
      await expectErrorCodeAsync(() => service.requireActive('missing'), 'OPERATOR_NOT_FOUND');
    });

    it('refuses a suspended operator', async () => {
      const { service, repo } = build();
      repo.seed(buildOperator({ id: 'op-1', status: 'SUSPENDED' }));

      await expectErrorCodeAsync(() => service.requireActive('op-1'), 'OPERATOR_SUSPENDED');
    });
  });

  describe('assertDifferentPerson', () => {
    it('passes for two different ids', () => {
      const { service } = build();
      expect(() => service.assertDifferentPerson('op-1', 'op-2')).not.toThrow();
    });

    it('refuses self-approval', () => {
      const { service } = build();
      expectErrorCode(
        () => service.assertDifferentPerson('op-1', 'op-1'),
        'OPERATOR_SELF_APPROVAL_REFUSED',
      );
    });
  });
});
