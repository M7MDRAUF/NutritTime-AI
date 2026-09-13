import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, ConfigError, GENERATION, KEEP_ALIVE_MESSAGE, loadConfig } from './config.js';

/**
 * TSD 5.2's table, asserted. The keep-alive rule (T-08-03) gets the most attention because it
 * is the one variable whose wrong value fails SILENTLY at runtime rather than at boot: Ollama
 * reads a bare number as seconds, so `30` evicts the model between questions and the next one
 * pays a cold load that arrives looking like an ordinary timeout.
 */

describe('defaults', () => {
  it('supplies every default from an empty environment', () => {
    expect(loadConfig({})).toStrictEqual({
      PORT: 4000,
      AI_ENABLED: true,
      AI_FAKE: false,
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'gemma3:4b',
      AI_KEEP_ALIVE: '30m',
      OLLAMA_CHAT_TIMEOUT_MS: 30000,
      OLLAMA_EXPLANATION_TIMEOUT_MS: 12000,
    });
  });

  it('treats an empty string as unset rather than as a value', () => {
    // `PORT=` in a .env is a variable the operator meant to comment out, not a request for
    // port zero.
    expect(loadConfig({ PORT: '', OLLAMA_MODEL: '   ' }).PORT).toBe(4000);
    expect(loadConfig({ OLLAMA_MODEL: '   ' }).OLLAMA_MODEL).toBe('gemma3:4b');
  });

  it('returns a frozen object', () => {
    // Frozen so no later module can mutate what boot validated.
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
  });

  it('declares exactly the eight variables TSD 5.2 tabulates', () => {
    expect(CONFIG_KEYS).toHaveLength(8);
    expect(Object.keys(loadConfig({})).sort()).toStrictEqual([...CONFIG_KEYS].sort());
  });
});

describe('AI_KEEP_ALIVE', () => {
  it.each(['30m', '500ms', '45s', '2h', '0s'])('accepts %s', (value) => {
    expect(loadConfig({ AI_KEEP_ALIVE: value }).AI_KEEP_ALIVE).toBe(value);
  });

  it('rejects a bare integer with the named-intent message', () => {
    // The exact message matters: it has to tell the operator what `30` actually means, not
    // merely that it is invalid.
    expect(() => loadConfig({ AI_KEEP_ALIVE: '30' })).toThrow(ConfigError);
    expect(() => loadConfig({ AI_KEEP_ALIVE: '30' })).toThrow(KEEP_ALIVE_MESSAGE);
    expect(KEEP_ALIVE_MESSAGE).toBe('AI_KEEP_ALIVE=30 means 30 seconds; write 30m for 30 minutes.');
  });

  it.each(['30 m', 'm30', '30minutes', 'forever', '-5m', '30M'])('rejects %o', (value) => {
    expect(() => loadConfig({ AI_KEEP_ALIVE: value })).toThrow(ConfigError);
  });
});

describe('bounds and coercion', () => {
  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '4000.5'],
    ['PORT', 'four thousand'],
    ['OLLAMA_CHAT_TIMEOUT_MS', '999'],
    ['OLLAMA_CHAT_TIMEOUT_MS', '120001'],
    ['OLLAMA_EXPLANATION_TIMEOUT_MS', '60001'],
  ] as const)('rejects %s=%o', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('accepts the boundary values themselves', () => {
    expect(loadConfig({ PORT: '1' }).PORT).toBe(1);
    expect(loadConfig({ PORT: '65535' }).PORT).toBe(65535);
    expect(loadConfig({ OLLAMA_CHAT_TIMEOUT_MS: '1000' }).OLLAMA_CHAT_TIMEOUT_MS).toBe(1000);
    expect(loadConfig({ OLLAMA_CHAT_TIMEOUT_MS: '120000' }).OLLAMA_CHAT_TIMEOUT_MS).toBe(120000);
  });

  it('strips trailing slashes from the base URL', () => {
    // Otherwise a joined path becomes `//api/chat`, which some proxies treat as a new host.
    expect(loadConfig({ OLLAMA_BASE_URL: 'http://localhost:11434/' }).OLLAMA_BASE_URL).toBe(
      'http://localhost:11434',
    );
    expect(loadConfig({ OLLAMA_BASE_URL: 'http://host:1/////' }).OLLAMA_BASE_URL).toBe(
      'http://host:1',
    );
  });
});

describe('booleans', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
  ] as const)('reads %o as %o', (value, expected) => {
    expect(loadConfig({ AI_ENABLED: value }).AI_ENABLED).toBe(expected);
  });

  it.each(['no', 'yes', 'off', 'on', 'nope'])('rejects %o rather than guessing', (value) => {
    // A permissive reader that treats every non-empty string as true would make
    // `AI_ENABLED=no` enable the model - the opposite of what the operator typed.
    expect(() => loadConfig({ AI_ENABLED: value })).toThrow(ConfigError);
  });
});

/**
 * The message from a call that MUST throw.
 *
 * Not `try { … expect.unreachable() } catch {}`: the marker's own throw is caught by the very
 * catch that then asserts on it, so the assertion runs against
 * `"expected \"expected a ConfigError\" not to be reached"` and passes no matter what the
 * function did. Two tests here were vacuous that way, and one of them was the privacy guard.
 */
function messageFromThrow(run: () => unknown): string {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw, 'expected the call to throw').toBe(true);
  expect(caught).toBeInstanceOf(ConfigError);
  return caught instanceof Error ? caught.message : String(caught);
}

describe('the error message', () => {
  it('names every failing variable, not just the first', () => {
    // An operator fixing a .env wants the whole list in one run.
    const message = messageFromThrow(() =>
      loadConfig({ PORT: '0', AI_KEEP_ALIVE: '30', AI_ENABLED: 'maybe' }),
    );
    expect(message).toContain('PORT');
    expect(message).toContain('AI_KEEP_ALIVE');
    expect(message).toContain('AI_ENABLED');
  });

  it('never echoes the offending value, on an input that really fails', () => {
    // The previous version used `http://user:hunter2@host/`, which is a VALID url and so did
    // not throw at all - the privacy guard was completely unverified. A credential in a
    // rejected value is the case that matters, so the input has to be one that is rejected.
    const message = messageFromThrow(() =>
      loadConfig({ OLLAMA_BASE_URL: 'ftp://user:hunter2@host/path' }),
    );
    expect(message).toContain('OLLAMA_BASE_URL');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('ftp://');
  });

  it('names the variable without echoing a long or odd value', () => {
    for (const value of ['x'.repeat(300), 'javascript:alert(1)', '../../etc/passwd']) {
      const message = messageFromThrow(() => loadConfig({ OLLAMA_BASE_URL: value }));
      expect(message).toContain('OLLAMA_BASE_URL');
      expect(message).not.toContain(value);
    }
  });
});

describe('OLLAMA_BASE_URL accepts only http and https', () => {
  it.each([
    'localhost:11434',
    'javascript:alert(1)',
    'file:///C:/secret',
    'ftp://host/',
    'mailto:x@y.z',
    'not-a-url',
  ])('rejects %o', (value) => {
    // A DROPPED SCHEME is the likeliest typo for this variable, and it used to boot clean -
    // every model call then failed at P19 as `ai_unavailable` rather than as the boot refusal
    // TSD 5.1 step 1 promises.
    expect(() => loadConfig({ OLLAMA_BASE_URL: value })).toThrow(ConfigError);
  });

  it.each(['http://localhost:11434', 'https://ollama.internal:443/'])('accepts %o', (value) => {
    expect(() => loadConfig({ OLLAMA_BASE_URL: value })).not.toThrow();
  });
});

describe('coverage the TSD table demands and the first pass missed', () => {
  it('accepts both inclusive edges of the explanation timeout', () => {
    expect(
      loadConfig({ OLLAMA_EXPLANATION_TIMEOUT_MS: '1000' }).OLLAMA_EXPLANATION_TIMEOUT_MS,
    ).toBe(1000);
    expect(
      loadConfig({ OLLAMA_EXPLANATION_TIMEOUT_MS: '60000' }).OLLAMA_EXPLANATION_TIMEOUT_MS,
    ).toBe(60000);
    expect(() => loadConfig({ OLLAMA_EXPLANATION_TIMEOUT_MS: '999' })).toThrow(ConfigError);
  });

  it('reads AI_FAKE independently of AI_ENABLED', () => {
    const config = loadConfig({ AI_FAKE: 'true', AI_ENABLED: 'false' });
    expect(config.AI_FAKE).toBe(true);
    expect(config.AI_ENABLED).toBe(false);
  });

  it.each(['0x1f90', '0b111', '0o7777', '4e3', '+8080', '8080.0'])(
    'rejects the non-decimal integer %o rather than silently reading it',
    (value) => {
      // `z.coerce.number()` is `Number()`, which reads `0b111` as 7 and `4e3` as 4000 - both in
      // range, so the TSD row was satisfied while the operator got a port they did not type.
      expect(() => loadConfig({ PORT: value })).toThrow(ConfigError);
    },
  );

  it('trims surrounding whitespace rather than failing on it', () => {
    // A stray space in a .env is not an error the operator should have to hunt; `12` is what
    // they meant. The regex runs after `.trim()`, so this is deliberate, not an escape.
    expect(loadConfig({ PORT: ' 4100 ' }).PORT).toBe(4100);
  });

  it('pins the generation constants, which have no consumer until P19', () => {
    // Declared here per TSD 5.2 because they change what the model writes, not where it runs.
    // Nothing reads them yet, so a mistyped value would otherwise ship silently to P19.
    expect(GENERATION).toStrictEqual({
      numCtx: 4096,
      numPredict: 300,
      temperature: 0,
      seed: 7,
    });
  });
});
