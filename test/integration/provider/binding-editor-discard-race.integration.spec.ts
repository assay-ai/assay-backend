import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { BindingAuthMode, PricingMode } from '@modules/tool/ports/tool.types';
import { EgressHttpClient } from '@shared/network/egress';

import { plainInvoker } from '../../unit/tool/helpers/routing-fixtures';
import {
  BindingEditorTestContext,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

/**
 * A save racing a discard must not bring the draft back. `update()` reads the
 * row, then saves it in a transaction; a discard that commits in between used
 * to be undone by `save` re-inserting the row it no longer found. The save now
 * locks and re-reads the row first, and a gone row is a 404.
 */
const SUBJECT = 'cred-race';

let context: BindingEditorTestContext;

beforeAll(async () => {
  context = await createBindingEditorTestContext(plainInvoker(new EgressHttpClient()));
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await context.reset();
  await context.registerProvider();
});

function body(): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: 'https://provider.example.com/api',
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.FREE,
    priceAmount: '0',
    assetId: USDC_ASSET,
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 30_000,
    authMode: BindingAuthMode.NONE,
  } as SaveToolBindingBodyDto;
}

it('a save after the draft was discarded is a 404 and does not re-create it', async () => {
  const draft = await context.editor.create(context.organizationId, SUBJECT, body());
  const load = context.editor.loadEditable.bind(context.editor);
  // The discard lands between the editor's read and its write.
  jest.spyOn(context.editor, 'loadEditable').mockImplementationOnce(async (org, id) => {
    const row = await load(org, id);
    await context.dataSource.query(`DELETE FROM tool_bindings WHERE id = $1`, [id]);
    return row;
  });

  await expect(
    context.editor.update(context.organizationId, SUBJECT, draft.id, { timeoutMs: 20_000 }),
  ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND });

  const [row] = (await context.dataSource.query(
    `SELECT count(*)::int AS n FROM tool_bindings WHERE id = $1`,
    [draft.id],
  )) as Array<{ n: number }>;
  expect(row.n).toBe(0);
});

it('an ordinary save still works', async () => {
  const draft = await context.editor.create(context.organizationId, SUBJECT, body());
  const saved = await context.editor.update(context.organizationId, SUBJECT, draft.id, {
    timeoutMs: 20_000,
  });
  expect(saved.timeoutMs).toBe(20_000);
});
