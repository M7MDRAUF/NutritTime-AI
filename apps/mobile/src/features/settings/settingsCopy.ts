/**
 * Every word Settings says about destroying data, and the one union that names the actions.
 *
 * Extracted from `SettingsScreen.tsx` when it passed SQG-09's 350 lines, and it is a real seam
 * rather than line-shuffling: none of this touches React, so what a confirmation *says* can be read
 * and reasoned about without a renderer — which matters here more than anywhere else in the app,
 * because a confirmation's copy is the whole safety mechanism in front of an irreversible action.
 *
 * **`DestructiveId` lives HERE, with the copy, and that placement is the anti-drift mechanism.**
 * The obvious way to split a screen is to move the strings out and leave the behaviour behind, and
 * that is exactly how a copy module starts lying: the copy described three fields while
 * `replace(DEFAULT_PREFERENCES)` reset nine, which is a finding this file's own history carries.
 * So the union that `SettingsScreen`'s `confirm` switch branches on is the same union
 * `confirmationFor` switches on, and **neither switch has a `default`** — a fifth destructive
 * action is therefore a compile error in both places at once: in the handler that would perform it
 * and in the copy that would have to describe it. Adding one without telling the user what it
 * destroys does not compile.
 *
 * Nothing here is assembled from an exception, a driver string or a stored value — PRD §12. The
 * only variable parts are record counts.
 */

import type { ThemeMode } from '@nutritime/contracts';

/**
 * **PRD §15's required attribution, verbatim. This is a licence obligation, not copy.**
 *
 * The catalog this entire app reasons over was seeded from TheMealDB, whose terms require this
 * exact credit, and PRD §15 prints the sentence including the URL: "The app displays the required
 * attribution: *Recipe data and imagery: TheMealDB (https://www.themealdb.com/)*". So it must not
 * be reworded, shortened, split, or have the URL lifted out of it — `Settings.dom.test.tsx`
 * asserts the whole sentence with `toBe` for that reason, because a fragment match would survive
 * precisely the edit the requirement forbids.
 *
 * **Here, and as text rather than a link.** Settings is where an app states this once instead of
 * per record — `SourceAttribution` already carries the per-record source, image-source and licence
 * metadata on the detail screen, which is §15's other half. Nothing in `apps/mobile` opens a
 * browser, so a tappable credit would be a control that does nothing; a URL the user can read and
 * type is worth more than a link that is not one.
 *
 * A constant rather than JSX text, so that no line-wrap can put a newline inside a string a licence
 * fixes character by character.
 *
 * USDA FoodData Central needs no equivalent line: PRD §15 records it as United States Government
 * work in the public domain.
 */
export const REQUIRED_ATTRIBUTION =
  'Recipe data and imagery: TheMealDB (https://www.themealdb.com/)';

/**
 * The four destructive actions, and the only values the confirmation sheet is ever opened with.
 *
 * A union rather than four booleans: two sheets open at once is not a state the screen can reach,
 * and one id in `pending` makes "the sheet shows the copy for the action pressed" true by
 * construction rather than by four flags agreeing.
 */
export type DestructiveId = 'favorites' | 'customMeals' | 'preferences' | 'all';

/** The three that are cleared by a dispatch, and therefore have a store status to report. */
export type ClearableId = Exclude<DestructiveId, 'all'>;

/** What each set is called in front of the user. One spelling, shared by the copy and the notices. */
export const SET_LABELS: Readonly<Record<ClearableId, string>> = {
  favorites: 'your favourites',
  customMeals: 'your own meals',
  preferences: 'your preferences',
};

/** The same three as a sentence opener, so a title is not a lower-case fragment. */
export const SAVE_FAILED_TITLES: Readonly<Record<ClearableId, string>> = {
  favorites: 'Your favourites were not saved',
  customMeals: 'Your own meals were not saved',
  preferences: 'Your preferences were not saved',
};

/** How each theme mode reads. Typed exhaustively, so a fourth `ThemeMode` is a compile error. */
export const THEME_LABELS: Readonly<Record<ThemeMode, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export interface Confirmation {
  readonly title: string;
  /** What is lost, and what is NOT. Fixed local copy (PRD §12), assembled only from counts. */
  readonly body: string;
  readonly confirmLabel: string;
}

/** `1 favourite` / `2 favourites`, so the copy is not a fragment at one record. */
function count(quantity: number, singular: string, plural: string): string {
  return `${quantity} ${quantity === 1 ? singular : plural}`;
}

/** `a` · `a and b` · `a, b and c`, so a two-item list does not read as a fragment either. */
export function joinSets(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? '';
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
}

/**
 * The confirmation copy for one action. **Each clear names the sets it does not touch** — not
 * reassurance for its own sake: the four buttons sit in one list, and a user who suspects "clear
 * favourites" might also drop the meals they authored has a reason to avoid the control that is safe.
 *
 * Exhaustive over `DestructiveId` with no `default`, for the reason in the module docstring.
 */
export function confirmationFor(
  id: DestructiveId,
  favorites: number,
  customMeals: number,
): Confirmation {
  switch (id) {
    case 'favorites':
      return {
        title: 'Clear your favourites?',
        body: `This removes ${count(favorites, 'favourited meal', 'favourited meals')} from this device. Your own meals and your preferences are not touched.`,
        confirmLabel: 'Clear favourites',
      };
    case 'customMeals':
      return {
        title: 'Delete the meals you created?',
        body: `This deletes ${count(customMeals, 'meal', 'meals')} you wrote yourself. They are only on this device, so they cannot be recovered. Your favourites and your preferences are not touched.`,
        confirmLabel: 'Delete my meals',
      };
    case 'preferences':
      return {
        title: 'Reset your preferences?',
        // Every field `DEFAULT_PREFERENCES` replaces, named. `replace` also drops `name`, which is
        // optional and therefore absent from the defaults — copy that under-states the scope of a
        // destructive action is a defect, not brevity, and this sentence used to name three of nine.
        body: 'This puts your name, diet, allergies, disliked ingredients, goal, budget, meal times, AI setting and theme back to their defaults — including an empty allergy list, so nothing will be filtered out until you set your allergies again. Your favourites and your own meals are not touched.',
        confirmLabel: 'Reset preferences',
      };
    case 'all':
      return {
        title: 'Erase everything on this device?',
        body: `This erases your preferences and allergy list, ${count(favorites, 'favourite', 'favourites')}, ${count(customMeals, 'meal you created', 'meals you created')}, and your app settings. You will be taken back through setup. Nothing is stored anywhere else, so this cannot be undone.`,
        confirmLabel: 'Erase everything',
      };
  }
}
