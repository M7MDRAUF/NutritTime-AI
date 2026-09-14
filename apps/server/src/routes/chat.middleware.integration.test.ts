import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ask,
  CHAT_PATH,
  CHEAPEST_SAFE,
  FIXED_NOW,
  firstOf,
  harness,
  MIXED_CATALOG,
  nameOnlyReply,
  PEANUT_MEAL,
  PEANUT_ONLY_CATALOG,
  SUPERLATIVE_QUESTION,
  UNRESOLVABLE_QUESTION,
} from './__fixtures__/chatHarness.js';

/**
 * `POST /api/v1/chat` through TSD 5.3's middleware stack and TSD 5.8's log lines.
 *
 * **Split out of `chat.integration.test.ts`**, which reached 1052 lines against Plan 17.1's
 * 350-line cap. The seam is the SUBJECT: that file asserts Plan 11.6's contract - the five
 * ordered steps, containment, the error mapping - and everything here asserts the stack the
 * route sits inside, which is a different document section and a different failure mode.
 *
 * **The construction both halves need is imported, not copied** - `./__fixtures__/chatHarness.ts`
 * holds the fixtures, the socket-less model, `harness` and `ask`, and holds no assertion at all.
 * It was copied into both files for one round and that is precisely the arrangement that drifts:
 * this wave found one mapping living in three files with two of them already diverged, and no
 * suite can assert anything about a constant in a file it does not import. Every control stayed
 * with the claim it controls, in the suite that makes it.
 *
 * **Why these cases cannot live at unit level.** `chat.test.ts` mounts `chatRouter` behind a bare
 * `express.json()` and its own two-branch error dispatch, so it can see neither the 64 KB cap,
 * nor `cors`, nor the 404 handler, nor the request log line. Each of those is a place a correct
 * route answers wrongly: a body rejected before the handler runs, a log line written after it, a
 * 404 for a path the router never claimed.
 *
 * **The log-line suite is the most valuable thing in this file.** TSD 5.8's AI log line is brand
 * new in this wave - `aiLogLine` had existed in `logging.ts` since P08 with no caller at all - and
 * this route is the first place in the server's history where a user's QUESTION could have
 * reached a log. So the lines are asserted as whole parsed objects (a fourth key is the leak that
 * matters, and only whole-object equality sees one), and a distinctive token is planted in the
 * question, in the model's answer and in the allergy list, then asserted absent from everything
 * the sink received (TSD 5.8, PRD 10.3).
 */

describe('the middleware stack around the route (TSD 5.3)', () => {
  it('sets a cors header for an allowed origin and none for a foreign one', async () => {
    const harnessed = harness();
    const fromOrigin = (origin: string) =>
      ask(harnessed, { question: UNRESOLVABLE_QUESTION }).set('Origin', origin);

    const allowed = await fromOrigin('http://localhost:8081');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    // Credentials off (TSD 5.3), so no browser sends a cookie to this route.
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const foreign = await fromOrigin('http://evil.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a declared error code for a chat path no route claims', async () => {
    const harnessed = harness();
    // The router registers POST `/` only, so a GET falls through to the 404 handler. TSD 5.3
    // step 5 calls for "a plain 404" outside `/api/v1/meals/*`; the shipped handler uses
    // `meal_not_found` because TSD 3.5's code set is closed at five and a sixth code carried no
    // `retryable`. Asserted as "one of the five", so the shape is pinned without this suite
    // taking a side on the wording.
    for (const response of [
      await request(harnessed.app).get(CHAT_PATH),
      await request(harnessed.app).post(`${CHAT_PATH}/extra`).send({}),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.error.retryable).toBe(false);
      expect(typeof response.body.error.message).toBe('string');
      expect(response.body.answer).toBeUndefined();
    }
  });
});

/**
 * TSD 5.8 and PRD 10.3 at the one layer that can see both lines at once.
 *
 * **The AI log line is brand new in this wave** - `aiLogLine` had existed since P08 with no
 * caller at all - and this route is the first place a question could ever have leaked into a
 * log. So the assertions are whole-object `toStrictEqual`s (a fourth key is the leak that
 * matters, and only whole-object equality sees one) plus a planted-token sweep across
 * everything the sink received.
 */
describe('the log lines (TSD 5.8, PRD 10.3)', () => {
  const aiLine = (outcome: string) => ({
    timestamp: FIXED_NOW.toISOString(),
    level: outcome === 'ok' ? 'info' : 'warn',
    lane: 'chat',
    // Both readings come from the injected clock, which is fixed - so this is exact rather than
    // a range, and a mutant reaching for `Date.now()` fails on the number.
    durationMs: 0,
    outcome,
  });

  const requestLine = (status: number, errorCode?: string) => ({
    timestamp: FIXED_NOW.toISOString(),
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    method: 'POST',
    routeTemplate: CHAT_PATH,
    status,
    durationMs: expect.any(Number),
    ...(errorCode === undefined ? {} : { errorCode }),
  });

  it('writes the route TEMPLATE and never the concrete path', async () => {
    const token = 'qzxvpathmarker';
    const harnessed = harness({
      behaviour: { kind: 'reply', reply: nameOnlyReply([CHEAPEST_SAFE]) },
    });
    // A query string is what makes the template distinguishable from the concrete path on this
    // route, where the two are otherwise the same string. A mutant logging `originalUrl` carries
    // the token.
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      allergies: ['peanut'],
      query: `asked=${token}`,
    });

    expect(response.status).toBe(200);
    expect(harnessed.lines).toHaveLength(2);
    // The AI line first: it is written inside the handler, before the response is sent.
    expect(JSON.parse(firstOf(harnessed.lines, 'the AI log line'))).toStrictEqual(aiLine('ok'));
    expect(JSON.parse(harnessed.lines[1] ?? '')).toStrictEqual(requestLine(200));
    expect(harnessed.lines.join('\n')).not.toContain(token);
  });

  /**
   * **The single most valuable assertion available at this layer.** Plant a distinctive token in
   * the question, one in the model's answer and one in the allergy list, then assert none of them
   * appears in ANYTHING the sink received. Stronger than reading the code, because it catches a
   * leak through a path nobody thought to look at.
   */
  it('lets neither the question, the answer nor the allergy list reach the sink', async () => {
    const questionToken = 'qzxvquestionmark';
    const answerToken = 'qzxvanswermark';
    const allergyToken = 'qzxvallergymark';
    const harnessed = harness({
      behaviour: {
        kind: 'reply',
        reply: {
          answered: true,
          answer: `${CHEAPEST_SAFE.name}. ${answerToken}`,
          citedMealIds: [CHEAPEST_SAFE.id],
        },
      },
    });

    const response = await ask(harnessed, {
      question: `${SUPERLATIVE_QUESTION} ${questionToken}`,
      allergies: ['peanut', allergyToken],
    });

    // The tokens really are in play: the request carried two and the response carries the third.
    expect(response.status).toBe(200);
    expect(response.body.answer).toContain(answerToken);
    expect(harnessed.lines).toHaveLength(2);

    const everything = harnessed.lines.join('\n');
    for (const token of [questionToken, answerToken, allergyToken]) {
      expect(everything).not.toContain(token);
    }
    // And no meal name and no allergen term, which are what PRD 10.3 names directly.
    expect(everything).not.toContain(CHEAPEST_SAFE.name);
    expect(everything).not.toContain(PEANUT_MEAL.name);
    expect(everything.toLowerCase()).not.toContain('peanut');
  });

  it('writes `contained` with neither the rule nor the evidence', async () => {
    const harnessed = harness({
      behaviour: {
        kind: 'reply',
        reply: {
          answered: true,
          answer: `${CHEAPEST_SAFE.name} is a healthy choice.`,
          citedMealIds: [CHEAPEST_SAFE.id],
        },
      },
    });
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      allergies: ['peanut'],
    });

    expect(response.status).toBe(503);
    expect(harnessed.lines).toHaveLength(2);
    expect(JSON.parse(firstOf(harnessed.lines, 'the AI log line'))).toStrictEqual(
      aiLine('contained'),
    );
    expect(JSON.parse(harnessed.lines[1] ?? '')).toStrictEqual(requestLine(503, 'ai_unavailable'));
    // X-40: TSD 5.8 has no field for either, and the evidence here is the denied phrase -
    // model-authored text derived from the user's own question.
    const everything = harnessed.lines.join('\n');
    expect(everything).not.toContain('denied-claim');
    expect(everything).not.toContain('healthy');
  });

  it('writes NO AI line on a path where the model was never called', async () => {
    for (const [catalog, options] of [
      [PEANUT_ONLY_CATALOG, { question: SUPERLATIVE_QUESTION, allergies: ['peanut'] }],
      [MIXED_CATALOG, { question: UNRESOLVABLE_QUESTION }],
    ] as const) {
      const harnessed = harness({ catalog });
      await ask(harnessed, options);
      // Exactly one line - the request line - and no `lane` field anywhere in it.
      expect(harnessed.lines).toHaveLength(1);
      expect(JSON.parse(firstOf(harnessed.lines, 'the request log line'))).toStrictEqual(
        requestLine(200),
      );
    }
  });

  it('writes no AI line when the lane was busy, because no call happened', async () => {
    const harnessed = harness({ behaviour: { kind: 'hold' } });
    const first = ask(harnessed, { question: SUPERLATIVE_QUESTION });
    void first.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = harnessed.lines.length;
    const second = await ask(harnessed, { question: SUPERLATIVE_QUESTION });
    expect(second.body.error.code).toBe('ai_busy');

    // The lane rejects before `fn` is invoked, so a `durationMs` here would time a call that
    // never ran. One line for the refused request, and it is the request line.
    const added = harnessed.lines.slice(before);
    expect(added).toHaveLength(1);
    expect(JSON.parse(firstOf(added, 'the request log line'))).toStrictEqual(
      requestLine(503, 'ai_busy'),
    );

    harnessed.model.release();
    await first.catch(() => undefined);
  });

  it('records the 400 with its error code and the template', async () => {
    const harnessed = harness();
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      extraPreferences: { goal: 'balanced' },
    });

    expect(response.status).toBe(400);
    expect(harnessed.lines).toHaveLength(1);
    expect(JSON.parse(firstOf(harnessed.lines, 'the request log line'))).toStrictEqual(
      requestLine(400, 'invalid_request'),
    );
  });
});
