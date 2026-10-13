import {
  BlockSubjectKind,
  normalizeSubject,
  subjectKey,
} from '@modules/blocklist/domain/account-block';

const ORG = '08773F92-21CD-4E53-8348-D3EF1DCC8378';
const EVM = 'eip155:84532:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const SOLANA = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:AgentTestOrgAWalletAddress11111';

describe('account block subjects', () => {
  describe('normalizeSubject', () => {
    it('lower-cases an organization uuid', () => {
      expect(normalizeSubject(BlockSubjectKind.ORGANIZATION, ` ${ORG} `)).toBe(ORG.toLowerCase());
    });

    it('refuses an organization that is not a uuid', () => {
      expect(normalizeSubject(BlockSubjectKind.ORGANIZATION, 'org-a')).toBeNull();
      expect(normalizeSubject(BlockSubjectKind.ORGANIZATION, EVM)).toBeNull();
    });

    it('lower-cases an EVM account, chain and address', () => {
      expect(normalizeSubject(BlockSubjectKind.WALLET, EVM)).toBe(EVM.toLowerCase());
    });

    it('keeps a Solana account as written, because base58 is case-sensitive', () => {
      expect(normalizeSubject(BlockSubjectKind.WALLET, SOLANA)).toBe(SOLANA);
    });

    it('refuses a wallet that is not CAIP-10', () => {
      expect(
        normalizeSubject(BlockSubjectKind.WALLET, '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45'),
      ).toBeNull();
      expect(normalizeSubject(BlockSubjectKind.WALLET, ORG)).toBeNull();
      expect(normalizeSubject(BlockSubjectKind.WALLET, '')).toBeNull();
    });
  });

  describe('subjectKey', () => {
    it('matches one EVM key on every chain of the namespace, in any case', () => {
      const base = subjectKey(BlockSubjectKind.WALLET, EVM);
      expect(base).toBe('eip155:0xa271a3407d3302f4b4fbe469b9188487cedd7d45');
      expect(
        subjectKey(
          BlockSubjectKind.WALLET,
          'eip155:8453:0xa271a3407d3302f4b4fbe469b9188487cedd7d45',
        ),
      ).toBe(base);
    });

    it('keeps namespaces apart', () => {
      expect(subjectKey(BlockSubjectKind.WALLET, SOLANA)).toBe(
        'solana:AgentTestOrgAWalletAddress11111',
      );
    });

    it('answers null, never throws, for anything that is not a subject', () => {
      expect(subjectKey(BlockSubjectKind.WALLET, 'not an account')).toBeNull();
      expect(subjectKey(BlockSubjectKind.ORGANIZATION, 'not a uuid')).toBeNull();
    });
  });
});
