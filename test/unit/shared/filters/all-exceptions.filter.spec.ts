import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { ErrorResponse } from '@shared/errors/error-response';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';

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
});
