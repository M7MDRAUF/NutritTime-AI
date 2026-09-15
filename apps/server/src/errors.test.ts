import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_RETRYABLE,
  API_ERROR_STATUS,
  chatRequestSchema,
} from '@nutritime/contracts';
import { ApiError, detailsFromIssues, INTERNAL_ERROR_BODY, isApiError } from './errors.js';
import type { IssueLike } from './errors.js';

/**
 * T-08-06. Status and retryability are properties of the CODE, not of the call site - which is
 * what stops the same condition being reported as 400 in one route and 503 in another.
 *
 * The rule that matters most here is the last suite: **nothing from an upstream error text
 * reaches a response body.** An upstream string is written for whoever operates the upstream
 * service and can carry a hostname, a stack frame, or a fragment of the request that caused it.
 */

describe('every declared code maps consistently', () => {
  it.each([...API_ERROR_CODES])(
    '%s carries the status and retryability the contract declares',
    (code) => {
      const error = new ApiError(code);
      expect(error.status).toBe(API_ERROR_STATUS[code]);
      expect(error.retryable).toBe(API_ERROR_RETRYABLE[code]);
      expect(error.toBody().error.code).toBe(code);
    },
  );

  it('covers exactly the five codes TSD 3.5 declares, and no more', () => {
    expect(API_ERROR_CODES).toHaveLength(5);
  });

  it('is recognisable across the module boundary', () => {
    expect(isApiError(new ApiError('meal_not_found'))).toBe(true);
    expect(isApiError(new Error('meal_not_found'))).toBe(false);
    expect(isApiError('meal_not_found')).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

describe('the body shape', () => {
  it('omits details entirely when there are none', () => {
    // Not `details: undefined`: an absent key and a present-but-empty one read differently to
    // a client, and the contract says the field is optional.
    expect(new ApiError('meal_not_found').toBody()).toStrictEqual({
      error: {
        code: 'meal_not_found',
        message: 'That meal could not be found.',
        retryable: false,
      },
    });
  });

  it('carries details when given them', () => {
    const body = new ApiError('invalid_request', {
      'preferences.diet': ['expected one of 5'],
    }).toBody();
    expect(body.error.details).toStrictEqual({ 'preferences.diet': ['expected one of 5'] });
  });

  it('gives the 500 body a fixed message and no detail at all', () => {
    expect(INTERNAL_ERROR_BODY.error.message).toBe('Something went wrong.');
    expect(Object.keys(INTERNAL_ERROR_BODY.error)).toStrictEqual(['code', 'message', 'retryable']);
  });
});

describe('detailsFromIssues, against real Zod failures', () => {
  /**
   * Driven by the real `chatRequestSchema` rather than hand-typed issues. The previous version
   * passed a lowercase `'unrecognized key'` stand-in and so never saw Zod's actual message -
   * which is `Unrecognized key: "peanut"`, the submitted key echoed verbatim.
   */
  const issuesFor = (body: unknown): readonly IssueLike[] => {
    const result = chatRequestSchema.safeParse(body);
    if (result.success) {
      throw new Error('expected the fixture to fail validation');
    }
    return result.error.issues;
  };

  it('groups by field path', () => {
    const details = detailsFromIssues(issuesFor({}));
    // Three missing fields now, not two: `mealPeriod` joined the chat contract at P28. The point
    // of the assertion is that EVERY missing path is reported and grouped, so the list grows with
    // the schema - and `toStrictEqual` over a sorted list is what makes that visible rather than
    // letting a silently-dropped path pass.
    expect(Object.keys(details).sort()).toStrictEqual(['mealPeriod', 'preferences', 'question']);
  });

  it('NEVER echoes a submitted key, which is what Zod itself does', () => {
    // The defect this replaces: `Unrecognized key: "peanut"` reached a response body, and an
    // unexpected key can be anything a client sends - including a question fragment.
    const details = detailsFromIssues(
      issuesFor({
        question: 'hi',
        preferences: { diet: 'vegan', allergies: [], dislikedIngredients: [] },
        'i-am-allergic-to-peanuts': 1,
      }),
    );
    const rendered = JSON.stringify(details);
    expect(rendered).not.toContain('peanut');
    expect(rendered).not.toContain('allergic');
    expect(rendered).toContain('unexpected field');
  });

  it('never echoes a submitted VALUE either', () => {
    const details = detailsFromIssues(
      issuesFor({
        question: 'x'.repeat(501),
        preferences: { diet: 'my-secret-diet', allergies: [], dislikedIngredients: [] },
      }),
    );
    const rendered = JSON.stringify(details);
    expect(rendered).not.toContain('my-secret-diet');
    expect(rendered).not.toContain('xxx');
  });

  it('names a root-level failure rather than using an empty key', () => {
    expect(detailsFromIssues([{ code: 'unrecognized_keys', path: [] }])).toStrictEqual({
      '(root)': ['unexpected field'],
    });
  });

  it('renders a numeric path segment', () => {
    expect(detailsFromIssues([{ code: 'too_small', path: ['allergies', 0] }])).toStrictEqual({
      'allergies.0': ['too small'],
    });
  });

  it('de-duplicates an identical message on one path', () => {
    expect(
      detailsFromIssues([
        { code: 'too_small', path: ['question'] },
        { code: 'too_small', path: ['question'] },
      ]),
    ).toStrictEqual({ question: ['too small'] });
  });

  it('falls back to a fixed message for an issue code it does not know', () => {
    expect(detailsFromIssues([{ code: 'something_new', path: ['x'] }])).toStrictEqual({
      x: ['not valid'],
    });
    expect(detailsFromIssues([{ path: ['y'] }])).toStrictEqual({ y: ['not valid'] });
  });
});

describe('no upstream text can reach a body', () => {
  it('keeps every message to the five fixed local strings', () => {
    // `ApiError` takes a CODE, not a message: there is no parameter through which an upstream
    // string could arrive, which is stronger than remembering to sanitise one.
    for (const code of API_ERROR_CODES) {
      const message = new ApiError(code).toBody().error.message;
      expect(message).not.toMatch(/ECONNREFUSED|ETIMEDOUT|ollama|127\.0\.0\.1|localhost|:\d{4}/i);
      expect(message.endsWith('.')).toBe(true);
    }
  });
});
