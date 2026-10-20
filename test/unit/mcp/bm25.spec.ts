import { SearchDocument, rankBm25, tokenize } from '@modules/mcp/domain/bm25';

function doc(key: string, ...fields: Array<[string, number]>): SearchDocument<string> {
  return { item: key, key, fields: fields.map(([text, weight]) => ({ text, weight })) };
}

/** BM25 ranking for `search_tools` (design spec §7.4). */
describe('rankBm25', () => {
  const docs = [
    doc('get_weather', ['get_weather', 3], ['Current temperature at a point', 1], ['weather', 2]),
    doc('get_token_market', ['get_token_market', 3], ['Token price and market cap', 1]),
    doc('geocode_place', ['geocode_place', 3], ['Resolve a place name to coordinates', 1]),
    doc('get_usd_eur_rate', ['get_usd_eur_rate', 3], ['Exchange rate, a price of a currency', 1]),
  ];

  it('splits snake_case and drops a plural s and one-letter terms', () => {
    expect(tokenize('get_token_market Prices a x')).toEqual(['get', 'token', 'market', 'price']);
  });

  it('ranks the tool whose name matches above one whose description does', () => {
    const ranked = rankBm25('token price', docs).map((hit) => hit.key);
    expect(ranked[0]).toBe('get_token_market');
    expect(ranked).toContain('get_usd_eur_rate');
    expect(ranked).not.toContain('geocode_place');
  });

  it('weights fields: a term in a heavier field scores higher', () => {
    const heavy = doc('a_tool', ['alpha', 3]);
    const light = doc('b_tool', ['alpha', 1]);
    const [first] = rankBm25('alpha', [light, heavy]);
    expect(first.key).toBe('a_tool');
  });

  it('a rarer term counts for more than a common one (idf)', () => {
    const ranked = rankBm25('get coordinates', docs);
    expect(ranked[0].key).toBe('geocode_place');
  });

  it('returns only matching documents, and nothing for a query that matches none', () => {
    expect(rankBm25('zebra', docs)).toEqual([]);
  });

  it('an empty query matches everything with score 0, in key order', () => {
    const ranked = rankBm25('  ', docs);
    expect(ranked.map((hit) => hit.key)).toEqual([
      'geocode_place',
      'get_token_market',
      'get_usd_eur_rate',
      'get_weather',
    ]);
    expect(ranked.every((hit) => hit.score === 0)).toBe(true);
  });

  it('breaks ties by key, so paging is stable', () => {
    const twins = [doc('b_twin', ['same words', 1]), doc('a_twin', ['same words', 1])];
    expect(rankBm25('same', twins).map((hit) => hit.key)).toEqual(['a_twin', 'b_twin']);
  });
});
