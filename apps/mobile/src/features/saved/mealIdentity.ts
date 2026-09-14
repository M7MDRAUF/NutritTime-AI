/**
 * Identity for a user-authored meal: one id, generated three different ways (T-17-03).
 *
 * Extracted from `mealFormValidation.ts` under SQG-09, and it is a real unit rather than a slice
 * taken to make a number: nothing here knows what a meal form is, and nothing in the form knows
 * how an id is assembled. `mealFormValidation.ts` re-exports both symbols, so CONTRACTS §7's
 * published surface is unchanged.
 *
 * **The whole file exists because there is no dependency to do this with.** `apps/mobile` has no
 * `uuid` and no `expo-crypto` (TSD §2.1 pins the toolchain and BRIEF §3 forbids adding one), and
 * Expo 57's winter runtime ships no `crypto` — so on a Hermes device `globalThis.crypto` may
 * simply be absent, and a module that reached for `crypto.randomUUID()` unguarded would throw at
 * the moment the user pressed Save.
 */

/** RFC-4122 v4, lowercase. CONTRACTS §0 verified that this shape satisfies `kebabIdSchema`. */
export const MEAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const UUID_BYTES = 16;
const BYTE_VALUES = 256;
const BYTE_MAX = 255;
const HEX_RADIX = 16;
const VERSION_INDEX = 6;
const VARIANT_INDEX = 8;

interface RandomUuidSource {
  randomUUID(): string;
}
interface RandomBytesSource {
  getRandomValues(target: Uint8Array): Uint8Array;
}

function hasRandomUuid(value: unknown): value is RandomUuidSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    'randomUUID' in value &&
    typeof value.randomUUID === 'function'
  );
}

function hasRandomBytes(value: unknown): value is RandomBytesSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getRandomValues' in value &&
    typeof value.getRandomValues === 'function'
  );
}

/** Clamped, so a stub or a broken engine returning 1, −1 or NaN cannot widen a byte to three hex
 * digits and produce an id no schema accepts. */
function byteFrom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(BYTE_MAX, Math.max(0, Math.floor(value * BYTE_VALUES)));
}

function uuidFromBytes(bytes: readonly number[]): string {
  const hex = bytes
    .map((byte, index) => {
      if (index === VERSION_INDEX) return (byte & 0x0f) | 0x40;
      if (index === VARIANT_INDEX) return (byte & 0x3f) | 0x80;
      return byte;
    })
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, '0'))
    .join('');
  const groups = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20)];
  return `${groups.join('-')}-${hex.slice(20, 32)}`;
}

/**
 * An RFC-4122 v4-shaped id, lowercase so it satisfies `kebabIdSchema`.
 *
 * Three strategies in descending order of trustworthiness, for the reason in the file docstring.
 * The `crypto.randomUUID` result is **verified rather than trusted**: a polyfill returning
 * anything else would put a value `kebabIdSchema` rejects into a record the `customMeals/created`
 * reducer then refuses silently, losing the user's meal with no message on screen.
 *
 * The last resort is not cryptographically random. For a local, single-user store of at most 200
 * records that is acceptable, and `composeCustomMeal`'s five-attempt regeneration against
 * `existingIds` plus the reducer's duplicate refusal are the containment.
 */
export function generateMealId(random: () => number = Math.random): string {
  const source: unknown = globalThis.crypto;
  if (hasRandomUuid(source)) {
    const candidate = source.randomUUID();
    if (MEAL_ID_PATTERN.test(candidate)) return candidate;
  }
  if (hasRandomBytes(source)) {
    return uuidFromBytes(Array.from(source.getRandomValues(new Uint8Array(UUID_BYTES))));
  }
  return uuidFromBytes(Array.from({ length: UUID_BYTES }, () => byteFrom(random())));
}
