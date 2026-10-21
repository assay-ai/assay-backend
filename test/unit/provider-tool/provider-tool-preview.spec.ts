import { previewServerNameFor } from '@modules/provider-tool/services/provider-tools.service';

/**
 * BUG-PRV-SETUP-07: the preview used a fixed `acme` server for every org. It
 * now follows the Connect sheet's suggestion, the same rule as the console's
 * `defaultServerNameFor` (`mcp__assay-acme__acme__search_posts`).
 */
describe('previewServerNameFor', () => {
  it('suggests assay-{handle} when the model-seen name fits 64 characters', () => {
    expect(previewServerNameFor('acme', 'acme__search_posts')).toBe('assay-acme');
    expect(previewServerNameFor('e2eprv', 'e2eprv__e2e_prv_setup_probe')).toBe('assay-e2eprv');
    expect(previewServerNameFor('marketkit-labs', 'marketkit-labs__x1')).toBe(
      'assay-marketkit-labs',
    );
  });

  it('drops trailing handle words until the name fits, else falls back to assay', () => {
    const tool = `marketkit-labs__${'a'.repeat(22)}`; // 38 characters
    // 7 + 20 + 38 = 65 > 64; 7 + 15 + 38 = 60 fits.
    expect(previewServerNameFor('marketkit-labs', tool)).toBe('assay-marketkit');
    expect(previewServerNameFor('acme', `acme__${'a'.repeat(48)}`)).toBe('assay');
  });
});
