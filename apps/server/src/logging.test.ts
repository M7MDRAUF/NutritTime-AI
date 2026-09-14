import { describe, expect, it } from 'vitest';
import { aiLogLine, errorLogLine, framesOf, requestLogLine } from './logging.js';

/**
 * T-08-08, and PRD 10.3 is the whole point (not "PRD 15.5", which does not exist; the
 * table is Plan 15.5): **never a prompt, a question, an answer, an
 * allergy list, a name, or a request body.**
 *
 * The way that rule is kept is structural. `requestLogLine` has no parameter through which any
 * of them could arrive, so the last suite below is not testing a redaction step - it is
 * testing that there is nothing to redact. A sanitiser you have to remember to call is a
 * sanitiser that gets forgotten.
 */

const AT = new Date('2026-09-13T10:20:30.400Z');

describe('the request line', () => {
  it('carries exactly the fields TSD 5.8 names', () => {
    const line = requestLogLine(
      { method: 'GET', routeTemplate: '/api/v1/meals/:mealId', status: 200, durationMs: 12 },
      AT,
    );
    expect(JSON.parse(line)).toStrictEqual({
      timestamp: '2026-09-13T10:20:30.400Z',
      level: 'info',
      method: 'GET',
      routeTemplate: '/api/v1/meals/:mealId',
      status: 200,
      durationMs: 12,
    });
  });

  it('adds errorCode only when there is one', () => {
    const without = JSON.parse(
      requestLogLine({ method: 'GET', routeTemplate: '/health', status: 200, durationMs: 1 }, AT),
    );
    expect('errorCode' in without).toBe(false);

    const withCode = JSON.parse(
      requestLogLine(
        {
          method: 'GET',
          routeTemplate: '/api/v1/meals/:mealId',
          status: 404,
          durationMs: 1,
          errorCode: 'meal_not_found',
        },
        AT,
      ),
    );
    expect(withCode.errorCode).toBe('meal_not_found');
  });

  it.each([
    [200, 'info'],
    [301, 'info'],
    [400, 'warn'],
    [404, 'warn'],
    [499, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ] as const)('logs status %i at level %s', (status, level) => {
    expect(
      JSON.parse(requestLogLine({ method: 'GET', routeTemplate: '/x', status, durationMs: 0 }, AT))
        .level,
    ).toBe(level);
  });

  it('is one line, so a log reader never has to reassemble a record', () => {
    const line = requestLogLine(
      { method: 'POST', routeTemplate: '/api/v1/chat', status: 200, durationMs: 900 },
      AT,
    );
    expect(line).not.toContain('\n');
    expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('the AI line', () => {
  it('carries lane, duration and outcome', () => {
    expect(
      JSON.parse(aiLogLine({ lane: 'chat', durationMs: 1800, outcome: 'ok' }, AT)),
    ).toStrictEqual({
      timestamp: '2026-09-13T10:20:30.400Z',
      level: 'info',
      lane: 'chat',
      durationMs: 1800,
      outcome: 'ok',
    });
  });

  it.each(['timeout', 'schema', 'contained', 'unreachable'] as const)(
    'logs the %s outcome at warn',
    (outcome) => {
      expect(JSON.parse(aiLogLine({ lane: 'explanation', durationMs: 1, outcome }, AT)).level).toBe(
        'warn',
      );
    },
  );

  it('records no prompt and no answer, only what happened', () => {
    const parsed = JSON.parse(aiLogLine({ lane: 'chat', durationMs: 5, outcome: 'contained' }, AT));
    expect(Object.keys(parsed).sort()).toStrictEqual([
      'durationMs',
      'lane',
      'level',
      'outcome',
      'timestamp',
    ]);
  });
});

describe('there is nothing to redact', () => {
  it('accepts no field that could carry user content', () => {
    // The route TEMPLATE, never the concrete path: `/api/v1/meals/chicken-curry` is a record
    // the user asked about, and a log of those is a log of what someone eats.
    const line = requestLogLine(
      {
        method: 'GET',
        routeTemplate: '/api/v1/meals/:mealId',
        status: 200,
        durationMs: 3,
        errorCode: 'meal_not_found',
      },
      AT,
    );
    const keys = Object.keys(JSON.parse(line));
    for (const forbidden of [
      'path',
      'url',
      'body',
      'query',
      'question',
      'answer',
      'prompt',
      'name',
      'allergies',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('takes its timestamp as a parameter, so a test can assert an exact line', () => {
    // Not `new Date()` inside: a clock read here would force every assertion to be a regex
    // around a moving value, and a regex is where a field slips in unnoticed.
    const a = requestLogLine(
      { method: 'GET', routeTemplate: '/health', status: 200, durationMs: 0 },
      AT,
    );
    const b = requestLogLine(
      { method: 'GET', routeTemplate: '/health', status: 200, durationMs: 0 },
      AT,
    );
    expect(a).toBe(b);
  });
});

describe('an unexpected throw is logged without its message', () => {
  /**
   * The defect this pins: `app.ts`'s 500 branch wrote `error.stack` - message included -
   * straight to the sink, so zlib's "incorrect header check" was logged verbatim, and a future
   * `new Error(`no match for "${question}"`)` would have logged a question and an allergy.
   *
   * TSD 3.5 forbids upstream text in a log line as firmly as in a response body, so the
   * message is dropped and only the NAME and FRAMES survive.
   */
  it('drops the message and keeps the name', () => {
    const error = new Error('user asked: do you have peanuts? my allergy is peanut');
    const line = errorLogLine({ errorName: error.name, frames: framesOf(error) }, AT);
    expect(line).not.toContain('peanut');
    expect(line).not.toContain('allergy');
    expect(JSON.parse(line).errorName).toBe('Error');
    expect(JSON.parse(line).message).toBe('unhandled error');
  });

  it('keeps frames, which are what locate the throw', () => {
    const frames = framesOf(new Error('anything'));
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.startsWith('at ')).toBe(true);
      // The message line is the one line that is not a frame, and it must not survive.
      expect(frame).not.toContain('anything');
    }
  });

  it('strips the message even when it spans lines', () => {
    const frames = framesOf(new Error('line one\nline two\n    at fake (nowhere:1:1)'));
    // A multi-line message can forge a frame; the filter keeps it, so the assertion is that
    // the genuine message lines are gone rather than that nothing forged survives.
    expect(frames.some((frame) => frame.includes('line one'))).toBe(false);
    expect(frames.some((frame) => frame.includes('line two'))).toBe(false);
  });

  it('returns no frames for a non-Error throw rather than stringifying it', () => {
    // `String(error)` on an unknown throw is the same hazard with no upper bound: a thrown
    // string can be anything, including a question.
    expect(framesOf('my allergy is peanut')).toStrictEqual([]);
    expect(framesOf(null)).toStrictEqual([]);
    expect(framesOf({ message: 'peanut' })).toStrictEqual([]);
  });
});
