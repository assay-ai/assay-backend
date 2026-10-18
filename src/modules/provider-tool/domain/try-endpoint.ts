import { parse as parseYaml } from 'yaml';

import { JsonObject, JsonValue } from '@modules/tool/domain/mapping/mapping.types';

/**
 * "Try your endpoint" (design spec §7.10, Provider console step 1): a pasted
 * curl command or an OpenAPI document becomes one concrete test request, and
 * the answer becomes the draft's schemas and first example. Pure: parsing,
 * the request plan and the inference. The service sends the plan through the
 * production invoker (egress relay, SSRF policy, request signature) and
 * stores nothing.
 *
 * What a plan never carries into a suggestion: a credential. A header or a
 * query parameter whose name reads as one (`authorization`, `x-api-key`,
 * `token`, …) is sent with the test, redacted from everything echoed back,
 * and left out of the inferred inputs and the suggested mapping — on a
 * binding it belongs in the credential vault, and as an input it would fail
 * the publish gate's secret-input screen.
 */

export type TryMethod = 'GET' | 'POST';

export enum TryWarningCode {
  /** A header or query parameter was read as a credential: sent, never suggested. */
  CREDENTIAL_DETECTED = 'CREDENTIAL_DETECTED',
  /** A curl option that does not change the request was ignored. */
  OPTION_IGNORED = 'OPTION_IGNORED',
  /** Required OpenAPI inputs had no value or example: nothing was sent. */
  MISSING_TEST_VALUES = 'MISSING_TEST_VALUES',
  /** The operation declares security; add the credential (here and on the binding). */
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  /** Something in the OpenAPI document is not used (a header or cookie parameter). */
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  /** The upstream did not answer 2xx JSON: the output schema could not be inferred. */
  NO_JSON_RESPONSE = 'NO_JSON_RESPONSE',
  /** The example would exceed the 2 KB cap; it is returned without its result. */
  EXAMPLE_TOO_LARGE = 'EXAMPLE_TOO_LARGE',
}

export interface TryWarning {
  readonly code: TryWarningCode;
  readonly detail: string;
}

/** One concrete test request, and what is known before it is sent. */
export interface TryPlan {
  readonly source: 'CURL' | 'OPENAPI';
  readonly method: TryMethod;
  /** The full URL sent, query included. */
  readonly url: string;
  /** Sent as is (credentials included); never echoed. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonObject | undefined;
  /** Every value to redact from what is echoed back. */
  readonly secrets: readonly string[];
  /** Names of the query parameters read as credentials: masked in the echoed URL. */
  readonly secretQueryNames: readonly string[];
  /** False when a required value is missing: the plan is inferred but not sent. */
  readonly runnable: boolean;
  /** The suggested binding endpoint: origin + path, no query. */
  readonly endpoint: string;
  /** The tool input the test request stands for. */
  readonly arguments: JsonObject;
  readonly inputSchema: JsonObject;
  /** From the OpenAPI document; otherwise inferred from the answer. */
  readonly outputSchema: JsonObject | null;
  /** The binding's `requestMapping`, in the editor's shorthand; no credential in it. */
  readonly requestMapping: JsonObject;
  readonly operationId: string | null;
  readonly warnings: readonly TryWarning[];
}

/** The caps a paste is held to before anything is parsed. */
export const TRY_LIMITS = Object.freeze({
  curlChars: 16 * 1024,
  openapiChars: 512 * 1024,
  schemaDepth: 8,
  schemaProperties: 100,
  exampleBytes: 2 * 1024,
});

/** A name that reads as a credential. */
const SECRET_NAME =
  /(^|[-_])(auth|authorization|api[-_]?key|apikey|key|token|secret|password|passwd|session|cookie|signature|credential|bearer)s?($|[-_])/i;

export function isCredentialName(name: string): boolean {
  return SECRET_NAME.test(name) || /^authorization$|^cookie$|^x-api-key$/i.test(name);
}

/** Headers a test never forwards: the transport's, or the platform's own namespace. */
const DROPPED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
]);

export class TryParseError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('; '));
  }
}

// ── curl ────────────────────────────────────────────────────────────────────

/** Splits a shell command line the way a POSIX shell would for the common cases. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let has = false;
  let i = 0;
  const source = text.replace(/\\\r?\n/g, ' ');
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || (c === '$' && source[i + 1] === "'")) {
      const ansi = c === '$';
      i += ansi ? 2 : 1;
      const end = source.indexOf("'", i);
      if (end < 0) throw new TryParseError(['an unclosed single quote in the curl command']);
      const raw = source.slice(i, end);
      current += ansi ? raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'") : raw;
      has = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < source.length) {
        const d = source[i];
        if (d === '\\' && i + 1 < source.length && '"\\$`'.includes(source[i + 1])) {
          current += source[i + 1];
          i += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        current += d;
        i += 1;
      }
      if (!closed) throw new TryParseError(['an unclosed double quote in the curl command']);
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < source.length) {
      current += source[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) words.push(current);
      current = '';
      has = false;
      i += 1;
      continue;
    }
    current += c;
    has = true;
    i += 1;
  }
  if (has) words.push(current);
  return words;
}

const CURL_VALUE_OPTIONS: Record<string, string> = {
  '-X': 'request',
  '--request': 'request',
  '-H': 'header',
  '--header': 'header',
  '-d': 'data',
  '--data': 'data',
  '--data-raw': 'data-raw',
  '--data-binary': 'data',
  '--data-ascii': 'data',
  '--json': 'json',
  '--url': 'url',
  '-A': 'user-agent',
  '--user-agent': 'user-agent',
  '-e': 'referer',
  '--referer': 'referer',
  '-b': 'cookie',
  '--cookie': 'cookie',
  '-u': 'user',
  '--user': 'user',
  '-m': 'ignored-value',
  '--max-time': 'ignored-value',
  '--connect-timeout': 'ignored-value',
  '-o': 'ignored-value',
  '--output': 'ignored-value',
  '-w': 'ignored-value',
  '--write-out': 'ignored-value',
};

const CURL_FLAGS: Record<string, string> = {
  '-s': 'ignored',
  '--silent': 'ignored',
  '-S': 'ignored',
  '--show-error': 'ignored',
  '-L': 'ignored',
  '--location': 'ignored',
  '-i': 'ignored',
  '--include': 'ignored',
  '-v': 'ignored',
  '--verbose': 'ignored',
  '--compressed': 'ignored',
  '-f': 'ignored',
  '--fail': 'ignored',
  '-g': 'ignored',
  '--globoff': 'ignored',
  '-k': 'insecure',
  '--insecure': 'insecure',
  '-G': 'get',
  '--get': 'get',
};

/** A pasted curl command as one test request. Throws {@link TryParseError}. */
export function planFromCurl(text: string): TryPlan {
  if (text.length > TRY_LIMITS.curlChars) {
    throw new TryParseError([`the curl command is longer than ${TRY_LIMITS.curlChars} characters`]);
  }
  const words = shellWords(text.trim());
  if (words[0] === 'curl') words.shift();
  const problems: string[] = [];
  const warnings: TryWarning[] = [];
  const headers: Array<[string, string]> = [];
  const data: string[] = [];
  let method: string | null = null;
  let url: string | null = null;
  let json = false;
  let get = false;

  for (let i = 0; i < words.length; i += 1) {
    let word = words[i];
    if (!word.startsWith('-') || word === '-') {
      if (url === null) url = word;
      else problems.push(`more than one URL ("${truncate(word)}")`);
      continue;
    }
    // `-XPOST`, `-H'x: y'`: a short option with its value attached.
    let attached: string | null = null;
    if (!word.startsWith('--') && word.length > 2 && CURL_VALUE_OPTIONS[word.slice(0, 2)]) {
      attached = word.slice(2);
      word = word.slice(0, 2);
    }
    // `-sSL`: a cluster of short flags.
    if (!word.startsWith('--') && word.length > 2 && attached === null) {
      const cluster = word
        .slice(1)
        .split('')
        .map((c) => `-${c}`);
      if (cluster.every((flag) => CURL_FLAGS[flag])) {
        for (const flag of cluster) applyFlag(flag);
        continue;
      }
    }
    if (CURL_FLAGS[word]) {
      applyFlag(word);
      continue;
    }
    const kind = CURL_VALUE_OPTIONS[word];
    if (!kind) {
      problems.push(`the curl option ${word} is not supported`);
      continue;
    }
    const value = attached ?? words[i + 1];
    if (attached === null) i += 1;
    if (value === undefined) {
      problems.push(`${word} needs a value`);
      continue;
    }
    switch (kind) {
      case 'request':
        method = value.toUpperCase();
        break;
      case 'header': {
        const colon = value.indexOf(':');
        if (colon <= 0) {
          problems.push(`the header "${truncate(value)}" is not "Name: value"`);
          break;
        }
        headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
        break;
      }
      case 'data':
      case 'data-raw':
        if (kind === 'data' && value.startsWith('@')) {
          problems.push('a body read from a file (@file) cannot be tried; paste the JSON inline');
          break;
        }
        data.push(value);
        break;
      case 'json':
        if (value.startsWith('@')) {
          problems.push('a body read from a file (@file) cannot be tried; paste the JSON inline');
          break;
        }
        json = true;
        data.push(value);
        break;
      case 'url':
        if (url === null) url = value;
        else problems.push('more than one URL');
        break;
      case 'user-agent':
        headers.push(['user-agent', value]);
        break;
      case 'referer':
        headers.push(['referer', value]);
        break;
      case 'cookie':
        headers.push(['cookie', value]);
        break;
      case 'user':
        headers.push(['authorization', `Basic ${Buffer.from(value, 'utf8').toString('base64')}`]);
        break;
      default:
        warnings.push({ code: TryWarningCode.OPTION_IGNORED, detail: `${word} was ignored` });
    }
  }

  function applyFlag(flag: string): void {
    const kind = CURL_FLAGS[flag];
    if (kind === 'get') get = true;
    else if (kind === 'insecure') {
      warnings.push({
        code: TryWarningCode.OPTION_IGNORED,
        detail: `${flag} was ignored: certificates are always verified`,
      });
    }
  }

  if (url === null) problems.push('the curl command has no URL');
  if (problems.length > 0) throw new TryParseError(problems);

  const target = parseTarget(url as string);
  let body: JsonObject | undefined;
  if (data.length > 0 && get) {
    for (const pair of data.join('&').split('&')) {
      if (!pair) continue;
      const [name, ...rest] = pair.split('=');
      target.searchParams.append(decodeForm(name), decodeForm(rest.join('=')));
    }
  } else if (data.length > 0) {
    if (data.length > 1) {
      throw new TryParseError(['more than one -d: a test sends one JSON body']);
    }
    body = parseJsonObject(data[0], 'the request body');
  }
  const verb = method ?? (body !== undefined ? 'POST' : 'GET');
  if (verb !== 'GET' && verb !== 'POST') {
    throw new TryParseError([`only GET and POST can be tried, not ${verb}`]);
  }
  if (verb === 'GET' && body !== undefined) {
    throw new TryParseError(['a GET request with a body cannot be tried; use POST or -G']);
  }

  const sent: Record<string, string> = {};
  if (json) {
    sent['content-type'] = 'application/json';
    sent.accept = 'application/json';
  }
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.has(key) || key.startsWith('x-assay-')) continue;
    sent[key] = value;
  }
  return assemble({
    source: 'CURL',
    method: verb,
    target,
    headers: sent,
    body,
    pathTemplate: null,
    operationId: null,
    outputSchema: null,
    runnable: true,
    warnings,
    declaredInputs: null,
  });
}

// ── OpenAPI ────────────────────────────────────────────────────────────────

export interface OpenApiTryOptions {
  readonly operationId?: string;
  /** Values for the operation's inputs, by name; examples and defaults fill the rest. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Headers sent with the test only — a credential, typically. Never stored or echoed. */
  readonly headers?: Readonly<Record<string, string>>;
}

type Doc = Record<string, unknown>;

/** One OpenAPI 3 operation as one test request. Throws {@link TryParseError}. */
export function planFromOpenApi(text: string, options: OpenApiTryOptions = {}): TryPlan {
  if (text.length > TRY_LIMITS.openapiChars) {
    throw new TryParseError([
      `the OpenAPI document is longer than ${TRY_LIMITS.openapiChars} characters`,
    ]);
  }
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 50 });
  } catch (error) {
    throw new TryParseError([`the OpenAPI document does not parse: ${(error as Error).message}`]);
  }
  if (!isObject(doc) || typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new TryParseError(['only an OpenAPI 3 document (JSON or YAML) can be tried']);
  }
  const root = doc;
  const deref = (value: unknown): unknown => resolveRef(root, value, 0);

  // The operation.
  const operations: Array<{ path: string; method: TryMethod; op: Doc; item: Doc }> = [];
  for (const [path, rawItem] of Object.entries(isObject(root.paths) ? root.paths : {})) {
    const item = deref(rawItem);
    if (!isObject(item)) continue;
    for (const method of ['get', 'post'] as const) {
      const op = deref(item[method]);
      if (isObject(op)) {
        operations.push({ path, method: method.toUpperCase() as TryMethod, op, item });
      }
    }
  }
  const named = options.operationId
    ? operations.filter((entry) => entry.op.operationId === options.operationId)
    : operations;
  if (named.length !== 1) {
    const ids = operations
      .map((entry) => String(entry.op.operationId ?? `${entry.method} ${entry.path}`))
      .slice(0, 20);
    throw new TryParseError([
      operations.length === 0
        ? 'the document has no GET or POST operation'
        : options.operationId
          ? `no GET or POST operation "${options.operationId}"; there are: ${ids.join(', ')}`
          : `name the operation to try (operationId); there are: ${ids.join(', ')}`,
    ]);
  }
  const { path, method, op, item } = named[0];
  const warnings: TryWarning[] = [];

  // The server.
  const servers = (
    Array.isArray(op.servers) && op.servers.length > 0 ? op.servers : root.servers
  ) as unknown[] | undefined;
  const server = Array.isArray(servers) ? deref(servers[0]) : null;
  if (!isObject(server) || typeof server.url !== 'string') {
    throw new TryParseError(['the document names no server (servers[0].url)']);
  }
  let base = server.url;
  if (isObject(server.variables)) {
    for (const [name, variable] of Object.entries(server.variables)) {
      const fallback = isObject(variable) ? variable.default : undefined;
      base = base.split(`{${name}}`).join(String(fallback ?? ''));
    }
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new TryParseError(['servers[0].url must be an absolute http(s) URL']);
  }

  const input = options.input ?? {};
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];
  const values: JsonObject = {};
  const missing: string[] = [];
  const pathValues: Record<string, string> = {};
  const query: Array<[string, string]> = [];

  // Parameters: the path item's, then the operation's (which override).
  const params = new Map<string, Doc>();
  for (const raw of [
    ...(Array.isArray(item.parameters) ? item.parameters : []),
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ]) {
    const param = deref(raw);
    if (isObject(param) && typeof param.name === 'string' && typeof param.in === 'string') {
      params.set(`${param.in}:${param.name}`, param);
    }
  }
  for (const param of params.values()) {
    const name = param.name as string;
    const where = param.in as string;
    if (where === 'header' || where === 'cookie') {
      warnings.push({
        code: TryWarningCode.NOT_SUPPORTED,
        detail: isCredentialName(name)
          ? `the ${where} parameter "${name}" is a credential: send it in "headers" for the test, and add it to the binding's credentials`
          : `the ${where} parameter "${name}" is not mapped; a mapping sends a constant header`,
      });
      continue;
    }
    if (where !== 'query' && where !== 'path') continue;
    const schema = sanitizeSchema(deref(param.schema), deref, 0);
    const isRequired = where === 'path' || param.required === true;
    const value = firstDefined(
      input[name],
      param.example,
      firstExample(param.examples, deref),
      isObject(schema) ? schema.example : undefined,
      isObject(schema) ? schema.default : undefined,
    );
    if (where === 'query' && isCredentialName(name)) {
      warnings.push({
        code: TryWarningCode.CREDENTIAL_DETECTED,
        detail: `the query parameter "${name}" reads as a credential: it is not an input; add it to the binding's credentials`,
      });
      if (value !== undefined) query.push([name, scalarText(value)]);
      continue;
    }
    properties[name] = (isObject(schema) ? schema : { type: 'string' }) as JsonValue;
    if (isRequired) required.push(name);
    if (value === undefined) {
      if (isRequired) missing.push(name);
      continue;
    }
    values[name] = value as JsonValue;
    if (where === 'path') pathValues[name] = scalarText(value);
    else query.push([name, scalarText(value)]);
  }

  // The JSON body: its top-level properties are inputs beside the parameters.
  let body: JsonObject | undefined;
  const requestBody = deref(op.requestBody);
  if (method === 'POST' && isObject(requestBody) && isObject(requestBody.content)) {
    const media = deref(requestBody.content['application/json']);
    const schema = isObject(media) ? sanitizeSchema(deref(media.schema), deref, 0) : null;
    if (isObject(schema) && isObject(schema.properties)) {
      const example = isObject(media) && isObject(media.example) ? media.example : {};
      const bodyRequired = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      body = {};
      for (const [name, propSchema] of Object.entries(schema.properties)) {
        if (name in properties) {
          warnings.push({
            code: TryWarningCode.NOT_SUPPORTED,
            detail: `the body field "${name}" has the name of a parameter; only the parameter is mapped`,
          });
          continue;
        }
        properties[name] = propSchema as JsonValue;
        const isRequired = bodyRequired.includes(name);
        if (isRequired) required.push(name);
        const value = firstDefined(
          input[name],
          (example as Doc)[name],
          isObject(propSchema) ? propSchema.example : undefined,
          isObject(propSchema) ? propSchema.default : undefined,
        );
        if (value === undefined) {
          if (isRequired) missing.push(name);
          continue;
        }
        values[name] = value as JsonValue;
        body[name] = value as JsonValue;
      }
    } else if (requestBody.required === true) {
      throw new TryParseError(['only a JSON object request body can be tried']);
    }
  }

  const security = op.security ?? root.security;
  if (Array.isArray(security) && security.length > 0 && !options.headers) {
    warnings.push({
      code: TryWarningCode.AUTH_REQUIRED,
      detail:
        'the operation declares security: send the credential in "headers" for the test, and ' +
        'add it to the binding’s credentials',
    });
  }
  if (missing.length > 0) {
    warnings.push({
      code: TryWarningCode.MISSING_TEST_VALUES,
      detail: `no value or example for ${missing.join(', ')}: give them in "input" to run the test`,
    });
  }

  const resolvedPath = path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(pathValues[name] ?? `{${name}}`),
  );
  const target = parseTarget(`${base.replace(/\/+$/, '')}${resolvedPath}`);
  for (const [name, value] of query) target.searchParams.append(name, value);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.has(key) || key.startsWith('x-assay-')) continue;
    headers[key] = value;
  }

  return assemble({
    source: 'OPENAPI',
    method,
    target,
    headers,
    body,
    pathTemplate: path,
    operationId: typeof op.operationId === 'string' ? op.operationId : null,
    outputSchema: outputSchemaOf(op, deref),
    runnable: missing.length === 0,
    warnings,
    declaredInputs: {
      schema: { type: 'object', properties, required } as JsonObject,
      values,
      basePath: new URL(base).pathname.replace(/\/+$/, ''),
    },
  });
}

// ── The plan ───────────────────────────────────────────────────────────────

interface AssembleInput {
  readonly source: 'CURL' | 'OPENAPI';
  readonly method: TryMethod;
  readonly target: URL;
  readonly headers: Record<string, string>;
  readonly body: JsonObject | undefined;
  /** OpenAPI: the path with its `{name}` segments. */
  readonly pathTemplate: string | null;
  readonly operationId: string | null;
  readonly outputSchema: JsonObject | null;
  readonly runnable: boolean;
  readonly warnings: TryWarning[];
  /** OpenAPI: the inputs the document declares; curl infers them from the request. */
  readonly declaredInputs: {
    readonly schema: JsonObject;
    readonly values: JsonObject;
    readonly basePath: string;
  } | null;
}

function assemble(input: AssembleInput): TryPlan {
  const { target, headers, body, warnings } = input;
  const secrets: string[] = [];
  const secretQueryNames: string[] = [];
  const mappingHeaders: Record<string, JsonValue> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (isCredentialName(name)) {
      secrets.push(value, ...credentialParts(value));
      warnings.push({
        code: TryWarningCode.CREDENTIAL_DETECTED,
        detail: `the header "${name}" reads as a credential: it is sent with the test only; add it to the binding's credentials`,
      });
      continue;
    }
    if (name === 'accept' || name === 'content-type') continue;
    mappingHeaders[name] = { $const: value };
  }

  const queryInputs: Record<string, JsonValue> = {};
  const argumentsOf: JsonObject = {};
  const properties: Record<string, JsonValue> = {};
  for (const [name, value] of target.searchParams) {
    if (isCredentialName(name)) {
      secrets.push(value);
      secretQueryNames.push(name);
      if (input.source === 'CURL') {
        warnings.push({
          code: TryWarningCode.CREDENTIAL_DETECTED,
          detail: `the query parameter "${name}" reads as a credential: it is not an input; add it to the binding's credentials`,
        });
      }
      continue;
    }
    queryInputs[name] = `$.${name}`;
    argumentsOf[name] = value;
    properties[name] = { type: 'string' };
  }

  const bodyMapping: Record<string, JsonValue> = {};
  if (body !== undefined) {
    for (const [name, value] of Object.entries(body)) {
      bodyMapping[name] = `$.${name}`;
      if (input.source === 'CURL') {
        if (name in properties) continue;
        argumentsOf[name] = value;
        properties[name] = inferSchema(value);
      }
    }
  }

  let endpointPath = target.pathname.replace(/\/+$/, '');
  let mappingPath: string | null = null;
  if (input.pathTemplate !== null && input.declaredInputs) {
    // The endpoint is the server's base; the mapping carries the templated path.
    endpointPath = input.declaredInputs.basePath;
    mappingPath = input.pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => `{$.${name}}`);
  }
  const endpoint = `${target.origin}${endpointPath}`;

  const requestMapping: JsonObject = { method: input.method };
  if (mappingPath) requestMapping.path = mappingPath;
  if (Object.keys(queryInputs).length > 0) requestMapping.query = queryInputs;
  if (Object.keys(mappingHeaders).length > 0) requestMapping.headers = mappingHeaders;
  if (Object.keys(bodyMapping).length > 0) requestMapping.body = bodyMapping;

  const declared = input.declaredInputs;
  return {
    source: input.source,
    method: input.method,
    url: target.href,
    headers: { ...headers },
    body,
    secrets: [...new Set(secrets.filter((secret) => secret.length > 0))],
    secretQueryNames,
    runnable: input.runnable,
    endpoint,
    arguments: declared ? declared.values : argumentsOf,
    inputSchema: declared
      ? declared.schema
      : { type: 'object', properties, required: Object.keys(properties) },
    outputSchema: input.outputSchema,
    requestMapping,
    operationId: input.operationId,
    warnings,
  };
}

/** The URL a test may send to: absolute http(s), no credentials in it, no fragment. */
function parseTarget(text: string): URL {
  let target: URL;
  try {
    target = new URL(text);
  } catch {
    throw new TryParseError([`"${truncate(text)}" is not an absolute URL`]);
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new TryParseError([`only http(s) URLs can be tried, not ${target.protocol}`]);
  }
  if (target.username || target.password) {
    throw new TryParseError(['a URL with a user name or password in it cannot be tried']);
  }
  target.hash = '';
  return target;
}

// ── Inference ──────────────────────────────────────────────────────────────

/** A JSON Schema for one value: types, object properties (all required), array items. */
export function inferSchema(value: unknown, depth = 0): JsonObject {
  if (value === null) return {};
  if (Array.isArray(value)) {
    const sample = value.slice(0, 5);
    if (sample.length === 0 || depth >= TRY_LIMITS.schemaDepth) return { type: 'array' };
    return {
      type: 'array',
      items: mergeSchemas(sample.map((item) => inferSchema(item, depth + 1))),
    };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      if (depth >= TRY_LIMITS.schemaDepth) return { type: 'object' };
      const entries = Object.entries(value as Record<string, unknown>).slice(
        0,
        TRY_LIMITS.schemaProperties,
      );
      const properties: Record<string, JsonValue> = {};
      for (const [name, child] of entries) properties[name] = inferSchema(child, depth + 1);
      return { type: 'object', properties, required: entries.map(([name]) => name) };
    }
    default:
      return {};
  }
}

/** One schema for several samples: objects merge (required = in every one); else the first. */
function mergeSchemas(schemas: readonly JsonObject[]): JsonObject {
  const objects = schemas.filter((schema) => schema.type === 'object');
  if (objects.length !== schemas.length || objects.length === 0) {
    const integers = schemas.every(
      (schema) => schema.type === 'integer' || schema.type === 'number',
    );
    if (integers && schemas.some((schema) => schema.type === 'number')) return { type: 'number' };
    return schemas[0] ?? {};
  }
  const properties: Record<string, JsonValue> = {};
  let required: string[] | null = null;
  for (const schema of objects) {
    const own = (schema.properties ?? {}) as Record<string, JsonValue>;
    for (const [name, child] of Object.entries(own))
      if (!(name in properties)) properties[name] = child;
    const names = (schema.required ?? []) as string[];
    required = required === null ? [...names] : required.filter((name) => names.includes(name));
  }
  return { type: 'object', properties, required: required ?? [] };
}

/**
 * The draft's output schema and response mapping from the answer: a JSON
 * object maps field for field; anything else is wrapped as `result`, since a
 * tool's output is always an object.
 */
export function outputOf(
  answer: JsonValue,
  declared: JsonObject | null,
): { readonly outputSchema: JsonObject; readonly responseMapping: JsonObject } {
  const isObj = answer !== null && typeof answer === 'object' && !Array.isArray(answer);
  if (isObj) {
    const schema =
      declared && declared.type === 'object' && isObject(declared.properties)
        ? declared
        : inferSchema(answer);
    const names = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    return {
      outputSchema: schema,
      responseMapping: Object.fromEntries(names.map((name) => [name, `$.${name}`])),
    };
  }
  return {
    outputSchema: {
      type: 'object',
      properties: { result: declared ?? inferSchema(answer) },
      required: ['result'],
    },
    responseMapping: { result: { $path: '$' } },
  };
}

/** The first example, `{ arguments, result? }`, inside the 2 KB cap. */
export function exampleOf(
  args: JsonObject,
  result: JsonValue | undefined,
): { readonly example: JsonObject; readonly trimmed: boolean } {
  const full: JsonObject = result === undefined ? { arguments: args } : { arguments: args, result };
  if (Buffer.byteLength(JSON.stringify(full), 'utf8') <= TRY_LIMITS.exampleBytes) {
    return { example: full, trimmed: false };
  }
  return { example: { arguments: args }, trimmed: result !== undefined };
}

// ── OpenAPI helpers ────────────────────────────────────────────────────────

function outputSchemaOf(op: Doc, deref: (value: unknown) => unknown): JsonObject | null {
  const responses = deref(op.responses);
  if (!isObject(responses)) return null;
  for (const code of ['200', '201', '2XX', '2xx', 'default']) {
    const response = deref(responses[code]);
    if (!isObject(response) || !isObject(response.content)) continue;
    const media = deref(response.content['application/json']);
    if (!isObject(media)) continue;
    const schema = sanitizeSchema(deref(media.schema), deref, 0);
    if (isObject(schema)) return schema as JsonObject;
  }
  return null;
}

/** A local `$ref` (`#/components/…`), followed at most 16 deep; anything else as is. */
function resolveRef(root: Doc, value: unknown, depth: number): unknown {
  if (!isObject(value) || typeof value.$ref !== 'string') return value;
  if (depth > 16 || !value.$ref.startsWith('#/')) return {};
  let node: unknown = root;
  for (const part of value.$ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    node = isObject(node) ? node[key] : undefined;
  }
  return resolveRef(root, node, depth + 1);
}

/** A schema with its `$ref`s inlined, depth-capped, without OpenAPI-only keywords. */
function sanitizeSchema(
  schema: unknown,
  deref: (value: unknown) => unknown,
  depth: number,
): Doc | null {
  const node = deref(schema);
  if (!isObject(node)) return null;
  if (depth >= TRY_LIMITS.schemaDepth) return { type: node.type ?? 'object' };
  const out: Doc = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      ['xml', 'externalDocs', 'discriminator', 'readOnly', 'writeOnly', 'deprecated'].includes(key)
    ) {
      continue;
    }
    if (key === 'nullable') continue;
    if (key === 'properties' && isObject(value)) {
      const properties: Doc = {};
      for (const [name, child] of Object.entries(value).slice(0, TRY_LIMITS.schemaProperties)) {
        properties[name] = sanitizeSchema(child, deref, depth + 1) ?? {};
      }
      out.properties = properties;
      continue;
    }
    if ((key === 'items' || key === 'additionalProperties') && isObject(value)) {
      out[key] = sanitizeSchema(value, deref, depth + 1) ?? {};
      continue;
    }
    if (['allOf', 'anyOf', 'oneOf'].includes(key) && Array.isArray(value)) {
      out[key] = value.map((child) => sanitizeSchema(child, deref, depth + 1) ?? {});
      continue;
    }
    out[key] = value;
  }
  return out;
}

function firstExample(examples: unknown, deref: (value: unknown) => unknown): unknown {
  if (!isObject(examples)) return undefined;
  for (const entry of Object.values(examples)) {
    const example = deref(entry);
    if (isObject(example) && example.value !== undefined) return example.value;
  }
  return undefined;
}

// ── Small helpers ──────────────────────────────────────────────────────────

function parseJsonObject(text: string, what: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TryParseError([`${what} is not JSON; only a JSON body can be tried`]);
  }
  if (!isObject(value)) throw new TryParseError([`${what} must be a JSON object`]);
  return value as JsonObject;
}

/** The secret parts of a credential header value: the token after `Bearer `, a Basic pair. */
function credentialParts(value: string): string[] {
  const match = /^(bearer|basic|token)\s+(.+)$/i.exec(value);
  if (!match) return [];
  const parts = [match[2]];
  if (match[1].toLowerCase() === 'basic') {
    const decoded = Buffer.from(match[2], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon >= 0) parts.push(decoded.slice(colon + 1));
  }
  return parts;
}

function decodeForm(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

function scalarText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function isObject(value: unknown): value is Doc {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
