import {
  AGENT_CREDENTIAL_TOKEN_PREFIX,
  isAgentCredentialToken,
} from '@modules/account/constants/agent-credential-token.constants';

// R17-P-01: keys (and every seed) mint `assay_sk_live_`; nothing else is ours.
describe('agent credential token prefix', () => {
  it('mints with the assay_ prefix', () => {
    expect(AGENT_CREDENTIAL_TOKEN_PREFIX).toBe('assay_sk_live_');
  });

  it('accepts the assay_ prefix', () => {
    expect(isAgentCredentialToken('assay_sk_live_abcdef')).toBe(true);
  });

  it.each([
    'eyJhbGciOiJIUzI1NiJ9.e30.x',
    'x402_sk_live_abcdef',
    'assay_sk_test_abc',
    'sk_live_abc',
    '',
  ])('does not claim %p', (token) => {
    expect(isAgentCredentialToken(token)).toBe(false);
  });
});
