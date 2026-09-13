/**
 * Configuration (TSD 5.2).
 *
 * **`process.env` is read in this file and nowhere else.** Every other module takes the parsed
 * object as a parameter. That is not style: a second reader means two places can disagree
 * about what the server is configured to do, and the disagreement shows up as behaviour no
 * test reproduces because the test set only one of them.
 *
 * Parsed once, frozen, at boot. A failure exits non-zero with the offending variable named -
 * the server does not start on configuration it could not understand (TSD 5.1 step 1).
 */

import { z } from 'zod';

/**
 * Generation parameters are **constants, not configuration** (TSD 5.2).
 *
 * They change what the model writes, not where it runs, so they belong in source next to the
 * prompt they were tuned against. `temperature: 0` with a fixed seed because this lane
 * restates an answer the domain already decided and has no creative requirement - and a
 * containment failure you cannot reproduce is one you cannot fix.
 *
 * Reproducibility holds for one model, one Ollama version, one machine. It is a debugging
 * property, not a guarantee, and no test asserts on exact model wording.
 */
export const GENERATION = { numCtx: 4096, numPredict: 300, temperature: 0, seed: 7 } as const;

/**
 * `AI_KEEP_ALIVE` must carry a unit, and this is why.
 *
 * Ollama reads a bare number as SECONDS. `AI_KEEP_ALIVE=30` therefore evicts the model thirty
 * seconds after a question, and the next question pays a ~60-second cold load that arrives
 * disguised as an ordinary timeout. It is a configuration error that costs an afternoon to
 * trace, so it is rejected at boot rather than tolerated.
 */
const KEEP_ALIVE_PATTERN = /^\d+(ms|s|m|h)$/;

export const KEEP_ALIVE_MESSAGE = 'AI_KEEP_ALIVE=30 means 30 seconds; write 30m for 30 minutes.';

/**
 * The defaults of TSD 5.2's table, in one place.
 *
 * Applied AFTER parsing rather than inside each field. Zod 4 keeps a key required when the
 * default is expressed as a union with `undefined`, and threading `.default()` through a
 * transform chain makes the order of operations the reader's problem. A table the eye can check
 * against the TSD is worth more here than a clever schema.
 */
const DEFAULTS = {
  PORT: 4000,
  AI_ENABLED: true,
  AI_FAKE: false,
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'gemma3:4b',
  AI_KEEP_ALIVE: '30m',
  OLLAMA_CHAT_TIMEOUT_MS: 30000,
  OLLAMA_EXPLANATION_TIMEOUT_MS: 12000,
} as const;

/**
 * A boolean from an environment string.
 *
 * Explicit about what counts: only `true`/`1` are true and only `false`/`0` are false. A
 * permissive reader that treats every non-empty string as true would make `AI_ENABLED=no`
 * enable the model, which is the opposite of what the operator typed.
 */
const envBoolean = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ['true', 'false', '1', '0'].includes(value), {
    message: 'expected true, false, 1 or 0',
  })
  .transform((value) => value === 'true' || value === '1');

const envInteger = (min: number, max: number) =>
  z
    .string()
    .trim()
    // Decimal digits only. `z.coerce.number()` is `Number()`, which reads `0b111` as 7 and
    // `4e3` as 4000 - both in range, so the TSD row is satisfied while the operator gets a
    // port they did not type.
    .regex(/^\d+$/, 'expected a whole number in decimal digits')
    .transform((value) => Number(value))
    .pipe(z.number().int().min(min).max(max));

const configSchema = z.strictObject({
  PORT: envInteger(1, 65535).optional(),
  AI_ENABLED: envBoolean.optional(),
  AI_FAKE: envBoolean.optional(),
  OLLAMA_BASE_URL: z
    .url()
    // http(s) only. `z.url()` accepts anything `new URL()` parses, so `javascript:alert(1)`,
    // `file:///C:/secret` and `mailto:` all booted clean - and a DROPPED SCHEME
    // (`localhost:11434`) parses too, which is the single most likely typo for this variable.
    // Without this the server comes up and every model call fails at P19 as `ai_unavailable`,
    // which is the opposite of the boot refusal TSD 5.1 step 1 promises.
    // Defensive, because Zod 4 runs a `.refine` even when an earlier check in the chain has
    // already failed - so an input `z.url()` rejected still reaches here, and a bare
    // `new URL(value)` threw a raw TypeError straight out of `loadConfig` instead of the
    // ConfigError the caller handles.
    .refine(
      (value) => {
        try {
          return /^https?:$/.test(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: 'expected an http or https URL' },
    )
    // Trailing slashes stripped, so a joined path never becomes `//api/chat`.
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),
  OLLAMA_MODEL: z.string().trim().min(1).optional(),
  AI_KEEP_ALIVE: z.string().trim().regex(KEEP_ALIVE_PATTERN, KEEP_ALIVE_MESSAGE).optional(),
  OLLAMA_CHAT_TIMEOUT_MS: envInteger(1000, 120000).optional(),
  OLLAMA_EXPLANATION_TIMEOUT_MS: envInteger(1000, 60000).optional(),
});

/**
 * Declared explicitly rather than inferred from `DEFAULTS`, whose `as const` narrows every
 * value to a literal type - `PORT: 4000` rather than `PORT: number`, which no parsed port
 * could satisfy.
 */
export interface ServerConfig {
  readonly PORT: number;
  readonly AI_ENABLED: boolean;
  readonly AI_FAKE: boolean;
  readonly OLLAMA_BASE_URL: string;
  readonly OLLAMA_MODEL: string;
  readonly AI_KEEP_ALIVE: string;
  readonly OLLAMA_CHAT_TIMEOUT_MS: number;
  readonly OLLAMA_EXPLANATION_TIMEOUT_MS: number;
}

/** The eight variables, in the order TSD 5.2 tabulates them. */
export const CONFIG_KEYS = [
  'PORT',
  'AI_ENABLED',
  'AI_FAKE',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'AI_KEEP_ALIVE',
  'OLLAMA_CHAT_TIMEOUT_MS',
  'OLLAMA_EXPLANATION_TIMEOUT_MS',
] as const;

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse the environment, or throw a `ConfigError` naming every variable that failed.
 *
 * Every variable, not the first: an operator fixing a `.env` wants the whole list in one run.
 * Unset variables are omitted rather than passed as `undefined` strings, so each field's
 * default applies.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const present: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') {
      present[key] = value;
    }
  }

  const result = configSchema.safeParse(present);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const variable = issue.path.join('.');
      return `  ${variable === '' ? '(config)' : variable}: ${issue.message}`;
    });
    throw new ConfigError(`invalid configuration:\n${lines.join('\n')}`);
  }

  // Every absent key takes its default. Frozen, so a later module cannot mutate what boot
  // validated.
  return Object.freeze({
    PORT: result.data.PORT ?? DEFAULTS.PORT,
    AI_ENABLED: result.data.AI_ENABLED ?? DEFAULTS.AI_ENABLED,
    AI_FAKE: result.data.AI_FAKE ?? DEFAULTS.AI_FAKE,
    OLLAMA_BASE_URL: result.data.OLLAMA_BASE_URL ?? DEFAULTS.OLLAMA_BASE_URL,
    OLLAMA_MODEL: result.data.OLLAMA_MODEL ?? DEFAULTS.OLLAMA_MODEL,
    AI_KEEP_ALIVE: result.data.AI_KEEP_ALIVE ?? DEFAULTS.AI_KEEP_ALIVE,
    OLLAMA_CHAT_TIMEOUT_MS: result.data.OLLAMA_CHAT_TIMEOUT_MS ?? DEFAULTS.OLLAMA_CHAT_TIMEOUT_MS,
    OLLAMA_EXPLANATION_TIMEOUT_MS:
      result.data.OLLAMA_EXPLANATION_TIMEOUT_MS ?? DEFAULTS.OLLAMA_EXPLANATION_TIMEOUT_MS,
  });
}
