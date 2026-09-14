/**
 * Dietary-setup validation, pure and separate from the screen (T-14-05).
 *
 * Plan §14.2 requires errors that are **inline, bound to the field, announced, and validated on
 * blur**. Three of those four are the screen's job; the fourth — what counts as invalid — is a rule,
 * and a rule in a component is a rule that cannot be enumerated. So the predicates live here and
 * the screen renders their output.
 *
 * **Blur-time, not keystroke-time, and that is a decision about dignity rather than performance.**
 * `08:` is not a wrong meal time, it is an unfinished one, and telling someone they are wrong while
 * they are still typing is how a form becomes hostile. The rule is: validate when the user leaves
 * the field, and re-validate on every keystroke *after* an error has been shown, so a correction
 * clears the message immediately rather than making them leave the field again to be forgiven.
 */

import { CANONICAL_ALLERGENS } from '@nutritime/contracts';
import type { CanonicalAllergen } from '@nutritime/contracts';

/** The list the UI offers. A text box here is what R-30 is about; a fixed list is the containment. */
export const ALLERGY_CHOICES: readonly CanonicalAllergen[] = CANONICAL_ALLERGENS;

export type MealTimeField = 'breakfast' | 'lunch' | 'dinner';

/**
 * `HH:mm`, 24-hour, zero-padded — the format `parseClockTime` in the domain accepts.
 *
 * Anchored at both ends, so `'08:00 '` and `'108:00'` are rejected rather than partially matched.
 * Hours `00-23` and minutes `00-59` are spelled out rather than `\d{2}` bounded by a range check,
 * because `25:00` failing the regex says "that is not a time" and failing a range check says
 * nothing about which half is wrong.
 */
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface FieldErrors {
  readonly breakfast?: string;
  readonly lunch?: string;
  readonly dinner?: string;
  readonly allergies?: string;
  readonly dislikes?: string;
}

/**
 * `userPreferencesSchema`'s own bound (`packages/contracts/src/schemas.ts`), restated here because
 * the form has to enforce it BEFORE the value is stored.
 *
 * **A 31st dislike was a silent, delayed erasure of the user's allergy list.** The screen had no
 * dislikes rule, so `isDietarySetupValid` returned true, Save completed onboarding, and the write
 * queue persisted a value `userPreferencesSchema` rejects. On the next launch `classifyEntry`
 * quarantined the whole `preferences` entry and the store was created from `DEFAULT_PREFERENCES` —
 * `allergies: []`. The `onboarding` key is separate and survived, so the app went straight to Home
 * and painted recommendations filtered by nothing.
 */
export const MAX_DISLIKES = 30;

/** One message per failure mode, written for the person reading it rather than for the developer. */
export const VALIDATION_MESSAGES = {
  /** Names the format AND gives an example: a format alone leaves the user guessing at padding. */
  clockFormat: 'Use a 24-hour time like 08:00.',
  clockEmpty: 'Enter a time.',
  /**
   * The order rule.
   *
   * Not a format problem, so it gets its own message. `mealPeriodForMinutes` takes the NEAREST
   * anchor within a −90/+120 window, so anchors out of order do not crash — they silently make one
   * period unreachable, which is worse than an error.
   */
  clockOrder: 'Each meal should come after the one before it.',
  allergyUnknown: 'Choose from the list so the filter can match it.',
  dislikesTooMany: `Up to ${String(MAX_DISLIKES)} ingredients. Remove a few.`,
} as const;

/** A single meal-time field, in isolation. */
export function validateMealTime(value: string): string | undefined {
  if (value.trim() === '') {
    return VALIDATION_MESSAGES.clockEmpty;
  }
  if (!CLOCK.test(value)) {
    return VALIDATION_MESSAGES.clockFormat;
  }
  return undefined;
}

function minutesOf(value: string): number | null {
  if (!CLOCK.test(value)) {
    return null;
  }
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * All three meal times together, including the ordering rule.
 *
 * **The error is attached to the LATER field**, which is the one the user just made wrong: if lunch
 * is set before breakfast, it is lunch that is out of place from the user's point of view, because
 * breakfast was already there. Putting the message on breakfast would point at a field they did not
 * touch — the exact failure Plan §14.2's "bound to the field" is written against.
 */
export function validateMealTimes(times: {
  readonly breakfast: string;
  readonly lunch: string;
  readonly dinner: string;
}): FieldErrors {
  const errors: Record<string, string> = {};
  for (const field of ['breakfast', 'lunch', 'dinner'] as const) {
    const message = validateMealTime(times[field]);
    if (message !== undefined) {
      errors[field] = message;
    }
  }
  // Order is only meaningful once all three parse; otherwise the format error is the real problem
  // and a second message about ordering would be noise on top of it.
  if (Object.keys(errors).length === 0) {
    const breakfast = minutesOf(times.breakfast);
    const lunch = minutesOf(times.lunch);
    const dinner = minutesOf(times.dinner);
    if (breakfast !== null && lunch !== null && lunch <= breakfast) {
      errors['lunch'] = VALIDATION_MESSAGES.clockOrder;
    } else if (lunch !== null && dinner !== null && dinner <= lunch) {
      errors['dinner'] = VALIDATION_MESSAGES.clockOrder;
    }
  }
  return errors;
}

/**
 * Whether every allergy in a list is one the matcher can act on.
 *
 * The screen offers a fixed list, so this cannot fail through the UI — it is the guard for the paths
 * that do not go through the UI: a restored backup, a future import, a deep link. R-30 is that an
 * unrecognised term protects nobody, and a form that silently accepted one would be claiming a
 * protection the domain cannot provide.
 */
export function validateAllergies(values: readonly string[]): string | undefined {
  const known = new Set<string>(CANONICAL_ALLERGENS);
  return values.every((value) => known.has(value)) ? undefined : VALIDATION_MESSAGES.allergyUnknown;
}

/**
 * The dislike list, against the bound the schema will apply.
 *
 * Counted after cleaning, because that is what the reducer stores: `'a,,b'` is two ingredients, and
 * telling the user they have three would be counting their commas.
 */
export function validateDislikes(values: readonly string[]): string | undefined {
  const cleaned = new Set(values.map((one) => one.trim()).filter((one) => one !== ''));
  return cleaned.size > MAX_DISLIKES ? VALIDATION_MESSAGES.dislikesTooMany : undefined;
}

/** True when nothing blocks submission. Derived, so a screen cannot forget a field. */
export function isDietarySetupValid(errors: FieldErrors): boolean {
  return Object.values(errors).every((message) => message === undefined);
}
