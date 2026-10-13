import { PublicFeaturesController } from '@bootstrap/api/public-features.controller';
import { DEMO_MCP_TOKEN_ENV, DEMO_ORGANIZATION_ID_ENV } from '@modules/mcp/mcp-api.module';
import { PUBLIC_RESERVES_ASSET_ENV } from '@modules/settlement/public-reserves-api.module';

/**
 * `GET /api/v1/public/features`.
 *
 * The `/reserves` and `/demo` pages used to learn that their routes were not
 * registered by calling them and reading the 404 (BUG-R5-02). This route is
 * always registered and answers from the same predicates the API bootstrap
 * mounts those modules with, so the two cannot disagree.
 */
describe('PublicFeaturesController', () => {
  const ENVS = [PUBLIC_RESERVES_ASSET_ENV, DEMO_MCP_TOKEN_ENV, DEMO_ORGANIZATION_ID_ENV];
  const saved = ENVS.map((name) => process.env[name]);

  beforeEach(() => {
    for (const name of ENVS) delete process.env[name];
  });

  afterAll(() => {
    ENVS.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  });

  it('reports both off on a deployment that configured neither', () => {
    expect(new PublicFeaturesController().get()).toEqual({ reserves: false, demo: false });
  });

  it('reports proof of reserves on once its asset is named', () => {
    process.env[PUBLIC_RESERVES_ASSET_ENV] = 'solana:devnet/token:usdc';
    expect(new PublicFeaturesController().get()).toEqual({ reserves: true, demo: false });
  });

  it('reports the demo on only with both its credential and its organization', () => {
    process.env[DEMO_MCP_TOKEN_ENV] = 'token';
    expect(new PublicFeaturesController().get().demo).toBe(false);
    process.env[DEMO_ORGANIZATION_ID_ENV] = 'org';
    expect(new PublicFeaturesController().get()).toEqual({ reserves: false, demo: true });
  });
});
