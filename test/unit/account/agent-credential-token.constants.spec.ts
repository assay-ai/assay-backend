import {
  AGENT_CREDENTIAL_TOKEN_PREFIX,
  LEGACY_AGENT_CREDENTIAL_TOKEN_PREFIX,
  isAgentCredentialToken,
} from '@modules/account/constants/agent-credential-token.constants';

// R17-P-01: new keys (and every seed) mint `assay_sk_live_`; keys issued before
// the rename still carry `x402_sk_live_` and must keep authenticating.
describe('agent credential token prefix', () => {
  it('mints with the assay_ prefix', () => {
    expect(AGENT_CREDENTIAL_TOKEN_PREFIX).toBe('assay_sk_live_');
  });

  it('still accepts the legacy x402_ prefix', () => {
    expect(LEGACY_AGENT_CREDENTIAL_TOKEN_PREFIX).toBe('x402_sk_live_');
    expect(isAgentCredentialToken('x402_sk_live_abcdef')).toBe(true);
    expect(isAgentCredentialToken('assay_sk_live_abcdef')).toBe(true);
  });

  it.each(['eyJhbGciOiJIUzI1NiJ9.e30.x', 'assay_sk_test_abc', 'sk_live_abc', ''])(
    'does not claim %p',
    (token) => {
      expect(isAgentCredentialToken(token)).toBe(false);
    },
  );
});
