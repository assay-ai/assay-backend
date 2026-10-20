import { parseApiDocsEnabled } from '@config/app.config';

describe('API_DOCS_ENABLED', () => {
  it('serves Swagger by default outside production', () => {
    expect(parseApiDocsEnabled(undefined, 'development')).toBe(true);
    expect(parseApiDocsEnabled(undefined, undefined)).toBe(true);
  });

  it('does not serve it in production unless asked to', () => {
    expect(parseApiDocsEnabled(undefined, 'production')).toBe(false);
    expect(parseApiDocsEnabled('', 'production')).toBe(false);
    expect(parseApiDocsEnabled('true', 'production')).toBe(true);
  });

  it('can be turned off anywhere', () => {
    expect(parseApiDocsEnabled('false', 'development')).toBe(false);
    expect(parseApiDocsEnabled(' FALSE ', 'test')).toBe(false);
  });
});
