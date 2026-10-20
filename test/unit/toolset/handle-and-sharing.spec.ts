import {
  HANDLE_CLAIM_MAX_ORGS,
  handleSkeleton,
  claimGateAllows,
  handleRefusal,
  handleSuggestions,
  normalizeHandle,
} from '@modules/toolset/domain/handle';
import {
  ListingStatus,
  SHARING_GRACE_MS,
  SharingState,
  SharingTransitionError,
  ToolsetVisibility,
  applySharing,
  listedInCatalogue,
  newUnlistedToken,
  servesPublicPath,
  servesUnlistedPath,
  sharingEndsAt,
} from '@modules/toolset/domain/sharing';
import { pinPathOf, pinReaches } from '@modules/toolset/domain/pin';

describe('handles (design spec §7.1)', () => {
  it.each([
    ['acme', null],
    ['acme-labs', null],
    ['a1b', null],
    ['ab', 'FORMAT'],
    ['1acme', 'FORMAT'],
    ['acme_labs', 'FORMAT'],
    ['Acme', 'FORMAT'],
    ['a'.repeat(25), 'FORMAT'],
    ['assay', 'RESERVED'],
    ['official', 'RESERVED'],
    ['toolsets', 'RESERVED'],
    ['weather', 'RESERVED'],
  ])('%s → %s', (handle, refusal) => {
    expect(handleRefusal(handle)).toBe(refusal);
  });

  it.each([
    'assay-ai',
    'assay0',
    'official-assay',
    'my-official-kit',
    'a55ay',
    'offlcial',
    'he1p',
    'we4ther',
    'adrnin',
    'supp0rt-team',
    'x402-labs',
    'goassay',
    'assayofficial',
    'admins',
    'the-staff',
  ])('refuses %s as a look-alike of a reserved name', (handle) => {
    expect(handleRefusal(handle)).toBe('RESERVED');
  });

  it.each([
    'acme',
    'weather-tools',
    'my-maps',
    'apiary',
    'helpful-bot',
    'orbit',
    'ecosystem-labs',
    'badminton-club',
    'staffing-co',
    'supportive-friends',
  ])('accepts %s, which only shares letters with a reserved word', (handle) => {
    expect(handleRefusal(handle)).toBeNull();
  });

  it('reserves every category the catalogue uses', () => {
    expect(handleRefusal('robotics', ['robotics'])).toBe('RESERVED');
    expect(handleRefusal('robotics', ['maps'])).toBeNull();
  });

  it('folds look-alikes into one skeleton', () => {
    expect(handleSkeleton('rn-0-1')).toBe('mol');
    expect(handleSkeleton('assay')).toBe(handleSkeleton('a55ay'));
  });

  it('normalises what a person types', () => {
    expect(normalizeHandle('  @AcMe ')).toBe('acme');
  });

  it('lets one Privy user claim for at most three organizations in the window', () => {
    const recent = ['o1', 'o2', 'o3'];
    expect(HANDLE_CLAIM_MAX_ORGS).toBe(3);
    expect(claimGateAllows(recent.slice(0, 2), 'o9')).toBe(true);
    expect(claimGateAllows(recent, 'o9')).toBe(false);
    // Changing the handle of an organization already counted is not a new one.
    expect(claimGateAllows(recent, 'o2')).toBe(true);
  });

  it('suggests valid free-form alternatives', () => {
    const suggestions = handleSuggestions('acme');
    expect(suggestions).toEqual(['acme-2', 'acme-3', 'acme-4']);
    for (const s of handleSuggestions('x'.repeat(24))) expect(handleRefusal(s)).toBeNull();
  });
});

describe('sharing state machine (design spec §7.7)', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const later = (ms: number) => new Date(now.getTime() + ms);
  const token = () => 'tok' + 'a'.repeat(23);
  const PRIVATE: SharingState = {
    visibility: ToolsetVisibility.PRIVATE,
    listingStatus: null,
    graceVisibility: null,
    graceUntil: null,
    unlistedToken: null,
    removedAt: null,
    deletedAt: null,
    delistedAt: null,
    firstSharedAt: null,
  };
  const apply = (state: SharingState, action: Parameters<typeof applySharing>[1], at = now) =>
    applySharing(state, action, at, token);
  const refusalOf = (work: () => unknown) => {
    try {
      work();
      return null;
    } catch (error) {
      return (error as SharingTransitionError).refusal;
    }
  };

  it('mints a 26-character lowercase token of at least 128 bits, unique each time', () => {
    const a = newUnlistedToken();
    expect(a).toMatch(/^[a-z2-7]{26}$/);
    expect(newUnlistedToken()).not.toBe(a);
  });

  it('share UNLISTED creates a link, serves /u/ only, and is not in the catalogue', () => {
    const s = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.UNLISTED });
    expect(s.visibility).toBe(ToolsetVisibility.UNLISTED);
    expect(s.unlistedToken).toBe(token());
    expect(s.firstSharedAt).toEqual(now);
    expect(servesUnlistedPath(s, now)).toBe(true);
    expect(servesPublicPath(s, now)).toBe(false);
    expect(listedInCatalogue(s)).toBe(false);
  });

  it('share PUBLIC lists it and keeps an existing /u/ link', () => {
    const unlisted = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.UNLISTED });
    const s = apply(unlisted, { kind: 'SHARE', visibility: ToolsetVisibility.PUBLIC });
    expect(s.listingStatus).toBe(ListingStatus.LISTED);
    expect(s.unlistedToken).toBe(token());
    expect(listedInCatalogue(s)).toBe(true);
    expect(servesPublicPath(s, now)).toBe(true);
    expect(servesUnlistedPath(s, now)).toBe(true);
    expect(sharingEndsAt(s, 'PUBLIC')).toBeNull();
  });

  it('a PUBLIC toolset made UNLISTED keeps its /@ URLs for 90 days', () => {
    const pub = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.PUBLIC });
    const s = apply(pub, { kind: 'SHARE', visibility: ToolsetVisibility.UNLISTED });
    expect(s.graceVisibility).toBe(ToolsetVisibility.PUBLIC);
    expect(s.graceUntil).toEqual(later(SHARING_GRACE_MS));
    expect(listedInCatalogue(s)).toBe(false);
    expect(servesPublicPath(s, later(SHARING_GRACE_MS - 1))).toBe(true);
    expect(servesPublicPath(s, later(SHARING_GRACE_MS))).toBe(false);
    expect(sharingEndsAt(s, 'PUBLIC')).toEqual(later(SHARING_GRACE_MS));
  });

  it('stop sharing keeps old URLs for 90 days, then clears the token', () => {
    const unlisted = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.UNLISTED });
    const s = apply(unlisted, { kind: 'STOP' });
    expect(s.visibility).toBe(ToolsetVisibility.PRIVATE);
    expect(s.graceVisibility).toBe(ToolsetVisibility.UNLISTED);
    expect(servesUnlistedPath(s, now)).toBe(true);
    expect(servesPublicPath(s, now)).toBe(false);
    const expired = apply(s, { kind: 'EXPIRE_GRACE' }, later(SHARING_GRACE_MS));
    expect(expired.unlistedToken).toBeNull();
    expect(servesUnlistedPath(expired, later(SHARING_GRACE_MS))).toBe(false);
    // Not yet due: unchanged.
    expect(apply(s, { kind: 'EXPIRE_GRACE' }, later(1000))).toBe(s);
  });

  it('stop sharing a PRIVATE toolset is a no-op', () => {
    expect(apply(PRIVATE, { kind: 'STOP' })).toBe(PRIVATE);
  });

  it('rotating the link kills the old one at once, and needs a shared toolset', () => {
    const unlisted = applySharing(
      PRIVATE,
      { kind: 'SHARE', visibility: ToolsetVisibility.UNLISTED },
      now,
      () => 'old' + 'a'.repeat(23),
    );
    const s = apply(unlisted, { kind: 'ROTATE' });
    expect(s.unlistedToken).toBe(token());
    expect(refusalOf(() => apply(PRIVATE, { kind: 'ROTATE' }))).toBe('NOT_SHARED');
  });

  it('delist leaves the catalogue at once, serves until grace, and cannot be undone by re-sharing', () => {
    const pub = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.PUBLIC });
    const s = apply(pub, { kind: 'DELIST' });
    expect(s.listingStatus).toBe(ListingStatus.DELISTED);
    expect(listedInCatalogue(s)).toBe(false);
    expect(servesPublicPath(s, now)).toBe(true);
    const cycled = apply(apply(s, { kind: 'STOP' }), {
      kind: 'SHARE',
      visibility: ToolsetVisibility.PUBLIC,
    });
    expect(cycled.listingStatus).toBe(ListingStatus.DELISTED);
    expect(listedInCatalogue(cycled)).toBe(false);
    const relisted = apply(cycled, { kind: 'RELIST' });
    expect(listedInCatalogue(relisted)).toBe(true);
    expect(relisted.graceUntil).toBeNull();
    expect(refusalOf(() => apply(PRIVATE, { kind: 'DELIST' }))).toBe('NOT_LISTED');
    expect(refusalOf(() => apply(pub, { kind: 'RELIST' }))).toBe('NOT_DELISTED');
  });

  it('a takedown stops every shared URL at once with no grace, and blocks sharing', () => {
    const pub = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.PUBLIC });
    const s = apply(pub, { kind: 'TAKEDOWN' });
    expect(servesPublicPath(s, now)).toBe(false);
    expect(servesUnlistedPath({ ...s, unlistedToken: token() }, now)).toBe(false);
    expect(listedInCatalogue(s)).toBe(false);
    expect(
      refusalOf(() => apply(s, { kind: 'SHARE', visibility: ToolsetVisibility.UNLISTED })),
    ).toBe('TAKEN_DOWN');
    expect(refusalOf(() => apply(s, { kind: 'TAKEDOWN' }))).toBe('ALREADY_TAKEN_DOWN');
    expect(servesPublicPath(apply(s, { kind: 'RESTORE' }), now)).toBe(true);
  });

  it('delete keeps serving for 90 days only when others use it', () => {
    const pub = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.PUBLIC });
    const used = apply(pub, { kind: 'DELETE', usedByOthers: true });
    expect(used.deletedAt).toEqual(now);
    expect(listedInCatalogue(used)).toBe(false);
    expect(servesPublicPath(used, now)).toBe(true);
    const unused = apply(pub, { kind: 'DELETE', usedByOthers: false });
    expect(servesPublicPath(unused, now)).toBe(false);
    expect(unused.unlistedToken).toBeNull();
    expect(
      refusalOf(() => apply(used, { kind: 'SHARE', visibility: ToolsetVisibility.PUBLIC })),
    ).toBe('DELETED');
  });

  it('publishing PRIVATE on a shared toolset is stop sharing', () => {
    const unlisted = apply(PRIVATE, { kind: 'SHARE', visibility: ToolsetVisibility.UNLISTED });
    const s = apply(unlisted, { kind: 'SHARE', visibility: ToolsetVisibility.PRIVATE });
    expect(s.visibility).toBe(ToolsetVisibility.PRIVATE);
    expect(s.graceVisibility).toBe(ToolsetVisibility.UNLISTED);
  });
});

describe('how a pin reaches its toolset (review N1)', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const TOKEN = 'abcdefghijklmnopqrstuvwxyz';
  const base: SharingState = {
    visibility: ToolsetVisibility.UNLISTED,
    listingStatus: null,
    graceVisibility: null,
    graceUntil: null,
    unlistedToken: TOKEN,
    removedAt: null,
    deletedAt: null,
    delistedAt: null,
    firstSharedAt: now,
  };

  it('a link pin reaches it only through the same link', () => {
    const pin = pinPathOf('UNLISTED', TOKEN);
    expect(pin.via).toBe('LINK');
    expect(pin.linkHash).not.toContain(TOKEN);
    expect(pinReaches(pin, base, now)).toBe('UNLISTED');
    expect(
      pinReaches(pin, { ...base, unlistedToken: 'zyxwvutsrqponmlkjihgfedcba' }, now),
    ).toBeNull();
    expect(pinReaches(pin, { ...base, removedAt: now }, now)).toBeNull();
  });

  it('a /@ pin reaches it only while /@ serves', () => {
    const pin = pinPathOf('PUBLIC', undefined);
    expect(pinReaches(pin, base, now)).toBeNull();
    expect(
      pinReaches(
        pin,
        { ...base, visibility: ToolsetVisibility.PUBLIC, listingStatus: ListingStatus.LISTED },
        now,
      ),
    ).toBe('PUBLIC');
  });
});
