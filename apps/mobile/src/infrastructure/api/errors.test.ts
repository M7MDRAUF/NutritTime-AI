import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '@nutritime/contracts';
import {
  API_CLIENT_MESSAGES,
  ApiClientError,
  TRANSPORT_STATUS,
  cancellation,
  isApiClientError,
  readErrorEnvelope,
  transportError,
} from './errors.js';

function envelope(error: Record<string, unknown>): { error: Record<string, unknown> } {
  return { error };
}

describe('the fixed local messages', () => {
  it('names one message per failure kind, and none of them is a template', () => {
    expect(Object.keys(API_CLIENT_MESSAGES).sort()).toEqual([
      'server',
      'timeout',
      'unreachable',
      'unreadable',
    ]);
    for (const message of Object.values(API_CLIENT_MESSAGES)) {
      // A placeholder is how wire text gets interpolated into a message later.
      expect(message).not.toMatch(/[{}$%]/);
      expect(message.endsWith('.')).toBe(true);
    }
  });

  it('maps each transport failure to the status TSD 6.5 gives it', () => {
    expect(TRANSPORT_STATUS).toEqual({ unreachable: 503, timeout: 504, unreadable: 502 });
  });

  it('marks a transport failure retryable only when retrying could help', () => {
    expect(transportError('getMeal', 'unreachable')).toMatchObject({
      status: 503,
      retryable: true,
      code: null,
      wire: null,
    });
    expect(transportError('ask', 'timeout')).toMatchObject({ status: 504, retryable: true });
    // A body this build cannot read will not become readable by asking again.
    expect(transportError('listMeals', 'unreadable')).toMatchObject({
      status: 502,
      retryable: false,
    });
  });

  it('carries the route that failed, so a screen knows what to offer', () => {
    expect(transportError('recommend', 'timeout').route).toBe('recommend');
  });
});

describe('ApiClientError', () => {
  const wire = { code: 'ai_busy', message: 'The assistant is busy.', retryable: true };

  it('takes its message from the local table and NEVER from the envelope', () => {
    const error = new ApiClientError({
      kind: 'server',
      status: 503,
      code: wire.code,
      retryable: wire.retryable,
      wire,
      route: 'ask',
    });
    expect(error.message).toBe(API_CLIENT_MESSAGES.server);
    expect(error.message).not.toBe(wire.message);
    expect(String(error)).not.toContain(wire.message);
    // The envelope is kept for diagnosis, and only there.
    expect(error.wire).toEqual(wire);
  });

  it('is recognisable through the type guard and as an Error', () => {
    const error = transportError('getMeal', 'timeout');
    expect(isApiClientError(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiClientError');
    expect(isApiClientError(new Error('x'))).toBe(false);
  });
});

describe('readErrorEnvelope', () => {
  it('reads the shape the server actually sends', () => {
    const body = envelope({
      code: 'meal_not_found',
      message: 'That meal could not be found.',
      retryable: false,
    });
    expect(readErrorEnvelope(body)).toEqual(body.error);
  });

  it('accepts every code the contract names', () => {
    for (const code of API_ERROR_CODES) {
      expect(readErrorEnvelope(envelope({ code, message: 'm', retryable: false }))?.code).toBe(
        code,
      );
    }
  });

  it('accepts a code this build has never heard of (X-20)', () => {
    // The server's own 500 body uses `internal_error`, a sixth code the five-code union does not
    // name. Parsing `code` against the union would make that body unreadable.
    expect(
      readErrorEnvelope(
        envelope({ code: 'internal_error', message: 'Something went wrong.', retryable: false }),
      ),
    ).toEqual({ code: 'internal_error', message: 'Something went wrong.', retryable: false });
    expect(
      readErrorEnvelope(envelope({ code: 'invented_later', message: 'm', retryable: true })),
    ).not.toBeNull();
  });

  it('carries `details` when the server names the offending fields', () => {
    const details = { 'preferences.diet': ['not one of the permitted values'] };
    expect(
      readErrorEnvelope(
        envelope({ code: 'invalid_request', message: 'm', retryable: false, details }),
      )?.details,
    ).toEqual(details);
  });

  it('keeps the envelope when only `details` is malformed', () => {
    // The code and the retry flag are what a screen acts on. Losing them because a field-path
    // map was the wrong shape would turn a clean 400 into an unreadable response.
    const read = readErrorEnvelope(
      envelope({
        code: 'invalid_request',
        message: 'm',
        retryable: false,
        details: { a: 'not a list' },
      }),
    );
    expect(read).toMatchObject({ code: 'invalid_request' });
    expect(read?.details).toBeUndefined();
  });

  it.each([
    ['no error member', { code: 'x', message: 'm', retryable: false }],
    ['a numeric code', envelope({ code: 7, message: 'm', retryable: false })],
    ['no message', envelope({ code: 'x', retryable: false })],
    ['a string retryable', envelope({ code: 'x', message: 'm', retryable: 'no' })],
    ['an HTML page', '<html>Bad Gateway</html>'],
    ['null', null],
    ['an array', []],
  ])('answers null for %s', (_name, body) => {
    expect(readErrorEnvelope(body)).toBeNull();
  });
});

describe('cancellation', () => {
  it('returns the caller’s own reason when it gave one', () => {
    class Superseded extends Error {}
    const controller = new AbortController();
    const reason = new Superseded('a newer search replaced this one');
    controller.abort(reason);
    expect(cancellation(controller.signal)).toBe(reason);
  });

  it('produces an AbortError when the caller gave no reason it can reuse', () => {
    const controller = new AbortController();
    controller.abort('just a string');
    const error = cancellation(controller.signal);
    expect(error.name).toBe('AbortError');
    expect(isApiClientError(error)).toBe(false);
  });
});
