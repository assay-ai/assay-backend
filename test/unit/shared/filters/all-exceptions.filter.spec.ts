import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { ErrorResponse } from '@shared/errors/error-response';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import { AccountErrors } from '@modules/account/errors/account.errors';
import { SlashErrors } from '@modules/slash/errors/slash.errors';

function buildHost(url = '/api/v1/payments/abc-123') {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const response = { status, json, headersSent: false };
  const request = { url, originalUrl: url, method: 'GET' };

  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

function capture(exception: unknown, url?: string): ErrorResponse {
  const { host, json } = buildHost(url);
  new AllExceptionsFilter().catch(exception, host);
  expect(json).toHaveBeenCalledTimes(1);
  return json.mock.calls[0][0] as ErrorResponse;
}

/** The single shape, asserted structurally so a new key is a test failure. */
function expectTheOneShape(body: ErrorResponse) {
  expect(Object.keys(body).sort()).toEqual(['error', 'success']);
  expect(body.success).toBe(false);
  expect(Object.keys(body.error).sort()).toEqual([
    'code',
    'message',
    'path',
    'statusCode',
    'timestamp',
  ]);
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
  expect(typeof body.error.statusCode).toBe('number');
  expect(typeof body.error.path).toBe('string');
  expect(new Date(body.error.timestamp).toISOString()).toBe(body.error.timestamp);
}

describe('AllExceptionsFilter', () => {
  it('serialises a domain AppError with its own code', () => {
    const body = capture(PaymentErrors.paymentIntentNotFound({ id: 'abc-123' }));

    expectTheOneShape(body);
    expect(body.error.code).toBe('PAYMENT_INTENT_NOT_FOUND');
    expect(body.error.statusCode).toBe(404);
    expect(body.error.message).toContain('abc-123');
  });

  it('serialises a framework 404 for a route that does not exist', () => {
    const body = capture(new NotFoundException('Cannot GET /api/v1/nope'), '/api/v1/nope');

    expectTheOneShape(body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.statusCode).toBe(404);
    expect(body.error.path).toBe('/api/v1/nope');
  });

  it('serialises an unhandled non-HTTP exception as a 500', () => {
    const body = capture(new TypeError('cannot read property x of undefined'));

    expectTheOneShape(body);
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.statusCode).toBe(500);
  });

  it('keeps a body-parser 4xx (an exposed http-error) a 4xx, not a 500', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const body = capture(tooLarge);

    expectTheOneShape(body);
    expect(body.error.statusCode).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.message).toBe('The request body is too large.');
  });

  it('answers a ParseUUIDPipe refusal with VALIDATION_FAILED, like a DTO (BUG-OPS-CASES-04)', async () => {
    let refusal: unknown;
    try {
      await new ParseUUIDPipe().transform('abc', { type: 'param', data: 'proposalId' });
    } catch (error) {
      refusal = error;
    }
    const body = capture(refusal);

    expect(body.error.statusCode).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/^Validation failed \(.*uuid.* is expected\)$/);
  });

  it('keeps any other plain 400 a BAD_REQUEST', () => {
    const body = capture(new BadRequestException('Something else'));
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('still answers 500 for an error that is not marked safe to expose', () => {
    const hidden = Object.assign(new Error('internal detail'), { status: 404, expose: false });
    const body = capture(hidden);

    expect(body.error.statusCode).toBe(500);
    expect(body.error.message).not.toContain('internal detail');
  });

  it('folds class-validator messages into the single message field', () => {
    const body = capture(
      new BadRequestException({
        message: ['title must be a string', 'author should not be empty'],
        error: 'Bad Request',
        statusCode: 400,
      }),
    );

    expectTheOneShape(body);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe('title must be a string; author should not be empty');
  });

  it('gives every exception type the identical key set — one shape, not three', () => {
    const bodies = [
      capture(PaymentErrors.paymentIntentNotFound({ id: 'a' })),
      capture(new NotFoundException()),
      capture(new HttpException('teapot', 418)),
      capture(new Error('boom')),
      capture('a thrown string'),
    ];

    const shapes = bodies.map((body) =>
      JSON.stringify([Object.keys(body).sort(), Object.keys(body.error).sort()]),
    );

    expect(new Set(shapes).size).toBe(1);
    bodies.forEach(expectTheOneShape);
  });

  it('does not write a second time when headers are already sent', () => {
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })), json, headersSent: true };
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ url: '/x', originalUrl: '/x', method: 'GET' }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter().catch(new Error('late'), host);
    expect(json).not.toHaveBeenCalled();
  });

  describe('error.context, only where the definition declares it safe', () => {
    it('puts ACCOUNT_BLOCKED role on the wire, so a client tells its own block from another party', () => {
      const own = capture(
        AccountErrors.accountBlocked({ role: 'ORGANIZATION', subjectKind: 'ORGANIZATION' }),
      );
      expect(own.error).toMatchObject({
        code: 'ACCOUNT_BLOCKED',
        statusCode: 403,
        message: 'Your account is blocked by Assay; contact support',
        context: { role: 'ORGANIZATION' },
      });
    });

    it('puts SLASH_CHAIN_BATCH_REFUSED refusals[] on the wire', () => {
      const refusals = [
        { requestId: 'ab'.repeat(32), reason: 'SlashNotPending', detail: 'the record is EXECUTED' },
      ];
      const body = capture(
        SlashErrors.chainBatchRefused({ functionName: 'disputeSlashBatch', refusals }),
      );
      expect(body.error.code).toBe('SLASH_CHAIN_BATCH_REFUSED');
      expect(body.error.context).toEqual({ functionName: 'disputeSlashBatch', refusals });
    });

    it('keeps every other context off the wire (no block note, no internals)', () => {
      const blocked = capture(
        AccountErrors.accountBlocked({
          role: 'PAYER',
          subjectKind: 'WALLET',
          note: 'internal: key leaked in a public repo',
        } as never),
      );
      // Only the declared `role`: never the note, never the subject kind.
      expect(blocked.error.context).toEqual({ role: 'PAYER' });
      expect(JSON.stringify(blocked)).not.toContain('leaked');
      expect(JSON.stringify(blocked)).not.toContain('WALLET');

      const notFound = capture(PaymentErrors.paymentIntentNotFound({ id: 'abc-123' }));
      expectTheOneShape(notFound);
    });
  });

  describe('R-OA-27: no consent request id, token or request body', () => {
    const RID = 'cmlkLXZhbHVlLXRoYXQtbXVzdC1uZXZlci1sZWFrLTEyMzQ';
    const SECRET = 'assay_rt_' + 'R'.repeat(43);

    function captureWithLog(exception: unknown, url: string, body?: unknown) {
      const json = jest.fn();
      const response = { status: jest.fn(() => ({ json })), json, headersSent: false };
      const request = { url, originalUrl: url, method: 'POST', body };
      const host = {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as unknown as ArgumentsHost;
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      let logged: string;
      try {
        new AllExceptionsFilter().catch(exception, host);
        logged = JSON.stringify([...debug.mock.calls, ...error.mock.calls]);
      } finally {
        debug.mockRestore();
        error.mockRestore();
      }
      return { body: json.mock.calls[0][0] as ErrorResponse, logged };
    }

    it.each([
      [`/api/v1/oauth/requests/${RID}`, '/api/v1/oauth/requests/[REDACTED]'],
      [`/api/v1/oauth/requests/${RID}/approve`, '/api/v1/oauth/requests/[REDACTED]/approve'],
      [`/oauth/authorize/continue?request=${RID}`, '/oauth/authorize/continue'],
    ])('redacts the rid in error.path and the 4xx debug line: %s', (url, expected) => {
      const { body, logged } = captureWithLog(new NotFoundException(), url);
      expectTheOneShape(body);
      expect(body.error.path).toBe(expected);
      expect(JSON.stringify(body)).not.toContain(RID);
      expect(logged).toContain(expected);
      expect(logged).not.toContain(RID);
    });

    it('redacts the rid in the 5xx error line too', () => {
      const { body, logged } = captureWithLog(new Error('boom'), `/api/v1/oauth/requests/${RID}`);
      expect(body.error.statusCode).toBe(500);
      expect(logged).not.toContain(RID);
      expect(JSON.stringify(body)).not.toContain(RID);
    });

    it('never echoes the request body (token and revoke forms), in the body or the log', () => {
      for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/register']) {
        const form = { grant_type: 'refresh_token', refresh_token: SECRET, token: SECRET };
        for (const exception of [
          new BadRequestException(),
          new HttpException('teapot', 418),
          new Error('boom'),
        ]) {
          const { body, logged } = captureWithLog(exception, path, form);
          expect(JSON.stringify(body)).not.toContain(SECRET);
          expect(logged).not.toContain(SECRET);
        }
      }
    });

    it('redacts the rid and query in a Nest route-not-found message (wrong method), body and log', () => {
      const url = `/api/v1/oauth/requests/${RID}/approve?x=${SECRET}`;
      const { body, logged } = captureWithLog(new NotFoundException(`Cannot GET ${url}`), url);
      expect(body.error.message).toBe('Cannot GET /api/v1/oauth/requests/[REDACTED]/approve');
      expect(body.error.path).toBe('/api/v1/oauth/requests/[REDACTED]/approve');
      for (const text of [JSON.stringify(body), logged]) {
        expect(text).not.toContain(RID);
        expect(text).not.toContain(SECRET);
      }
    });

    it('replaces a body-parser JSON message with a fixed string', () => {
      let parseError: Error;
      try {
        JSON.parse(`{"refresh_token":${SECRET}}`);
        throw new Error('unreachable');
      } catch (error) {
        parseError = error as Error;
      }
      // What Nest's `mapExternalException` makes of a body-parser SyntaxError.
      const mapped = new BadRequestException(parseError.message);
      const { body, logged } = captureWithLog(mapped, `/api/v1/oauth/requests/${RID}/approve`);
      expectTheOneShape(body);
      expect(body.error.statusCode).toBe(400);
      expect(body.error.message).toBe('Malformed request body');
      for (const text of [JSON.stringify(body), logged]) {
        expect(text).not.toContain(SECRET.slice(0, 12));
        expect(text).not.toContain('assay_rt');
      }
    });

    it('replaces an Express param-decode message with a fixed text, no echo of the param', () => {
      // A rid-shaped value, so only the fixed text (not the token backstop) can hide it.
      const hexRid = 'a1b2c3d4'.repeat(8);
      const url = `/api/v1/oauth/requests/${hexRid}%E0`;
      // What Nest's `mapExternalException` makes of Express's URIError.
      const { body, logged } = captureWithLog(
        new BadRequestException(`Failed to decode param '${hexRid}%E0'`),
        url,
      );
      expectTheOneShape(body);
      expect(body.error.statusCode).toBe(400);
      expect(body.error.message).toBe('Malformed request path');
      expect(body.error.path).toBe('/api/v1/oauth/requests/[REDACTED]');
      for (const text of [JSON.stringify(body), logged]) {
        expect(text).not.toContain(hexRid);
      }
      expect(logged).toContain('Malformed request path');
    });

    it('redacts a token in a query string of error.path', () => {
      const { body } = captureWithLog(
        new NotFoundException(),
        `/oauth/token?refresh_token=${SECRET}`,
      );
      expect(body.error.path).toBe('/oauth/token?refresh_token=[REDACTED]');
    });
  });
});
