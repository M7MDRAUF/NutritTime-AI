/**
 * Dietary setup (T-14-04, T-14-05). All six preference fields, editable, validated on blur.
 *
 * **The allergy field is a fixed list, not a text box**, and that is the single most consequential
 * decision on this screen. R-30: an allergy term the lexicon does not know is matched only as a
 * literal ingredient-name substring, so `cilantro` typed into a text box would protect nobody while
 * looking exactly like protection. `ALLERGY_CHOICES` is the canonical taxonomy, and
 * `canonicalAllergies` in the store is the second half of the same guard.
 *
 * **Two modes, one screen.** Reached from onboarding it is a first-run form with a Save that
 * completes onboarding; reached from Settings it edits a profile that already exists.
 * `DietarySetupParams.returnTo` says which, and the difference is confined to the button and what
 * happens after it — the fields are identical, because a user editing their allergies later deserves
 * the same form as a user entering them the first time.
 *
 * **Every change dispatches immediately; Save is not what persists.** The store's write queue
 * coalesces, so a tap on a diet chip is saved without a Save button, and this screen's Save exists
 * only to say "I am finished" — which is what completes onboarding. That means a user who force-
 * quits halfway through keeps what they had already chosen, which for an allergy list is the
 * behaviour that matters.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { BUDGET_BANDS, DIET_TAGS, NUTRITION_GOALS } from '@nutritime/contracts';
import type { BudgetBand, DietTag, NutritionGoal } from '@nutritime/contracts';
import {
  AccessibleButton,
  AppText,
  Chip,
  Divider,
  FormField,
  StatusMessage,
} from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { preferencesActions, preferencesStore } from '../../state/preferences/index.js';
import { onboardingActions, onboardingStore } from '../../state/onboarding/index.js';
import {
  ALLERGY_CHOICES,
  MAX_NAME_LENGTH,
  isDietarySetupValid,
  validateAllergies,
  validateDislikes,
  validateMealTimes,
} from './dietaryValidation.js';
import type { FieldErrors, MealTimeField } from './dietaryValidation.js';
import { ChipRow, chipLabel } from './ChipRow.js';

const MEAL_TIME_FIELDS: readonly MealTimeField[] = ['breakfast', 'lunch', 'dinner'];

/** Every field a rule in `dietaryValidation.ts` can report on. */
type ValidatedField = keyof FieldErrors;

/**
 * The visible label of every field a rule can report on — **one table, two readers.**
 *
 * The three meal-time `FormField`s take their label from here and so does the error summary, so
 * the summary can only ever name a field by the words that field actually shows. The alternative
 * was a second, summary-only label map, and `Plan.md`'s R-58 — "Three copies of 'how a store's
 * failure is presented to a user'", one of them this very file — is what that becomes.
 *
 * Keyed by `keyof FieldErrors`, so a new rule in `dietaryValidation.ts` is a **compile error here**
 * rather than a failure the summary silently cannot name.
 */
const FIELD_LABELS: Readonly<Record<ValidatedField, string>> = {
  allergies: 'Allergies',
  dislikes: 'Ingredients you would rather avoid',
  breakfast: 'Breakfast time',
  lunch: 'Lunch time',
  dinner: 'Dinner time',
};

/**
 * Form order, not the order the validator builds its object in: a summary is a set of directions
 * down the page, and naming `lunch` before `dislikes` sends a user back up past a field they had
 * already passed.
 *
 * `allergies` is listed even though it **cannot fail through this UI** — every write path
 * canonicalises, which is why the chips render no inline error (see the note at the chip row).
 * It costs nothing and is the only surface that failure would have, because `isDietarySetupValid`
 * counts it and would otherwise refuse a Save with nothing at all on screen.
 */
const SUMMARY_ORDER: readonly ValidatedField[] = [
  'allergies',
  'dislikes',
  'breakfast',
  'lunch',
  'dinner',
];

/**
 * `a` · `a and b` · `a, b and c`. Local rather than imported: `MealFormScreen`'s `namedList` is
 * under `features/saved`, and a cross-feature coupling for four lines of string joining costs more
 * than the four lines. Recorded as a duplication rather than hidden.
 */
function namedList(items: readonly string[]): string {
  const last = items.at(-1);
  if (last === undefined) {
    return '';
  }
  return items.length === 1 ? last : `${items.slice(0, -1).join(', ')} and ${last}`;
}

interface InvalidSummary {
  readonly title: string;
  readonly description: string;
  readonly stillAvailable: string;
}

/**
 * The summary's copy, in PRD §12's shape: what happened, what still works, what to do next — the
 * fields it names *are* the what-to-do-next.
 *
 * **It never says "not saved", which is the one place it must differ from `MealFormScreen`'s.**
 * That form dispatches once, on Save, so a refused press there wrote nothing. This one dispatches
 * on every change and Save only says "I am finished" (see the header note), so the choices already
 * made are held whatever this press did — "This meal is not saved yet", copied across, would have
 * told the user something false about their own allergy list.
 *
 * Fixed local copy interpolating nothing but this screen's label table and a count (PRD §12), and
 * every string run through `deniedClaimIn`: R-70's lesson is that a guard aimed at one source of
 * text does not cover another, and this is new user-facing text.
 */
function invalidSummary(fields: readonly ValidatedField[]): InvalidSummary {
  const named = namedList(fields.map((field) => FIELD_LABELS[field]));
  return {
    title: 'This form is not finished yet',
    description:
      fields.length === 1
        ? `One answer needs a different value: ${named}.`
        : `${String(fields.length)} answers need a different value: ${named}.`,
    // True in every storage state, which "your choices are saved" would not be: an `unavailable`
    // key or a refused write is reported by its own notice below and this sentence must not
    // contradict it.
    stillAvailable: 'Nothing you have chosen here is lost — every other answer is still set.',
  };
}

export function DietarySetupScreen({ route, navigation }: ScreenProps<'DietarySetup'>): ReactNode {
  const { colors, components } = useTheme();
  const state = preferencesStore.useValue();
  const dispatch = preferencesStore.useDispatch();
  const status = preferencesStore.useStatus();
  const completeOnboarding = onboardingStore.useDispatch();

  const fromOnboarding = route.params?.returnTo !== 'Settings';
  const preferences = state.preferences;

  /**
   * Which fields the user has left, so an untouched field shows no error.
   *
   * This is the whole of "validate on blur": errors are computed from the values on every render —
   * they have to be, or a correction would not clear — and then **filtered by whether the field has
   * been visited.** `08:` is not a wrong time, it is an unfinished one, and telling someone they are
   * wrong mid-keystroke is how a form becomes hostile.
   *
   * A field stays touched once visited, so after an error has appeared a correction clears it on the
   * next keystroke rather than making the user leave the field again to be forgiven.
   */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  /**
   * Presses of Save, and the only thing it is for is keying the error summary.
   *
   * `StatusMessage`'s `announceOnMount` is `role="alert"`, and an alert's **insertion** is the
   * announcement — so a second press on an unchanged form would render identical copy, never
   * remount, and say nothing. To a screen-reader user that is the dead button all over again.
   * Keying the summary by attempt remounts it, which is what makes the announcement repeat.
   * `MealFormScreen` keys its own outcome message the same way and for the same reason.
   */
  const [attempts, setAttempts] = useState(0);

  /**
   * The half-typed meal times, held HERE rather than in the store.
   *
   * **The store refuses a value `parseClockTime` cannot read**, because one used to reach it: a
   * single keystroke of `'08:'` was written to disk (quarantining the whole `preferences` key on the
   * next launch, which silently erased the user's allergies) and crashed Home's render, since
   * `useRecommendations` classifies the period during render and Home sits mounted beneath this
   * form in the `app` phase.
   *
   * So the field shows the draft and the store holds only times. `undefined` means "no draft,
   * show what is stored", which is what makes the field reflect an external change — a reset at
   * P18, say — instead of being frozen at whatever the user last typed.
   */
  const [drafts, setDrafts] = useState<Readonly<Partial<Record<MealTimeField, string>>>>({});

  const draftTimes = {
    breakfast: drafts.breakfast ?? preferences.mealTimes.breakfast,
    lunch: drafts.lunch ?? preferences.mealTimes.lunch,
    dinner: drafts.dinner ?? preferences.mealTimes.dinner,
  };

  /**
   * The dislikes text, held here for the same reason the meal times are — and it is the same defect.
   *
   * **The store caps the list at `MAX_DISLIKES`**, so a field bound to `preferences
   * .dislikedIngredients` showed the user 30 entries after they had entered 31, erased the comma
   * they had just typed on every keystroke (`['a', '']` cleans to `['a']`, so `', '` vanished
   * mid-word), and — because the rule was then run over the **stored** list — could never report
   * anything: the predicate it tests had already been made false by the cap. Ten ingredients
   * disappeared with no message, on a form whose subject is telling the user what it did with their
   * input (PRD §12: what happened, what still works, what to do next).
   *
   * So the draft takes the keystroke, the rule reads the draft, and the store keeps its cap.
   * `undefined` means "no draft, show what is stored", which is what lets an external change — a
   * reset at P18 — reach the field instead of it being frozen at whatever was last typed.
   */
  const [dislikesDraft, setDislikesDraft] = useState<string | undefined>(undefined);
  const dislikesText = dislikesDraft ?? preferences.dislikedIngredients.join(', ');

  const markTouched = useCallback((field: string) => {
    setTouched((current) => (current.has(field) ? current : new Set([...current, field])));
  }, []);

  const allErrors = useMemo(
    () => ({
      // The DRAFT, not the stored value: the stored value is valid by construction now, so
      // validating it would never report anything and the user would never be told. That holds for
      // the dislikes list exactly as it holds for the meal times — the reducer's cap is what makes
      // the stored list unreportable, so the rule has to see the text the user entered.
      ...validateMealTimes(draftTimes),
      allergies: validateAllergies(preferences.allergies),
      dislikes: validateDislikes(dislikesText.split(',')),
    }),
    [
      draftTimes.breakfast,
      draftTimes.lunch,
      draftTimes.dinner,
      preferences.allergies,
      dislikesText,
    ],
  );

  /** Shown only for a visited field — or for every field once Save has been pressed. */
  const errorFor = (field: string): string | undefined =>
    touched.has(field) || submitted
      ? (allErrors as Record<string, string | undefined>)[field]
      : undefined;

  const valid = isDietarySetupValid(allErrors);

  /**
   * What the summary names, recomputed every render rather than latched at the press.
   *
   * It has to be: the per-field messages already clear on the next keystroke (S-43), and a summary
   * frozen at the press would go on naming a field the user had just fixed. Because the summary is
   * keyed by `attempts` and not by this list, shrinking it does **not** remount and therefore does
   * not re-announce — the list quietly narrows while the user works, and only a new press speaks.
   */
  const invalidFields = SUMMARY_ORDER.filter((field) => allErrors[field] !== undefined);

  const onSave = (): void => {
    setSubmitted(true);
    // Before the validity branch, because both branches are an attempt and only the summary reads
    // it. A press that succeeds mounts no summary, so the increment is inert there.
    setAttempts((current) => current + 1);
    if (!valid) {
      /**
       * Nothing to save and nothing to navigate to. `submitted` un-filters the per-field messages
       * and they stay exactly where they are, which is what `dietary-setup.md`'s "retain inline
       * errors" asks for.
       *
       * **The earlier version of this comment said that was the whole point of the flag, and that
       * is how this gap survived to P28 wearing a rationale** (`BRIEF.md` §6.1j). The messages
       * being on screen is what a sighted user needs and it is not an announcement: a refused
       * press mounted four `aria-live="assertive"` regions at once with no lede, and assertive
       * means each interrupts the last. `design-system/DECISIONS.md`'s `dietary-setup` row adopted
       * an error summary for this screen — "error summary at the top of the form … inline errors
       * retained" — and X-47 records that it was built on `MealFormScreen` and not here. The
       * summary above the fields is the other half of this branch.
       */
      return;
    }
    if (fromOnboarding) {
      completeOnboarding(onboardingActions.complete());
      // No `navigate`: completing onboarding changes the boot phase, and the phase decides which
      // screens exist (TSD §6.1). Navigating as well would race the tree being rebuilt.
      return;
    }
    navigation.goBack();
  };

  return (
    <ScrollView
      testID="dietary-setup-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
      keyboardShouldPersistTaps="handled"
    >
      <AppText variant="title" tone="primary" level={1}>
        {fromOnboarding ? 'Set up your preferences' : 'Edit your preferences'}
      </AppText>

      {/*
        **X-47's summary: the lede a refused Save had none of.** Measured before this landed, four
        `aria-live="assertive"` regions mounted together — `dislikes` plus the three meal times —
        with nothing above them. Assertive means each interrupts the last, so that is a collision
        rather than an announcement, on the first form a screen-reader user meets.

        **At the top, which is a deliberate divergence from `MealFormScreen`.** Its mechanism is
        copied exactly (`StatusMessage` + `announceOnMount`, keyed by attempt); its *placement* is
        not, because that form argues from its own length — "a summary at the top of a form this
        long is a summary a sighted user never sees" — while `design-system/pages/dietary-setup.md`
        adopts "Place it at the top of the form" for THIS screen by name.

        **It is not a fifth assertive region.** `announceOnMount` is `role="alert"` with
        `aria-live="polite"`, which downgrades the assertive the role implies: it speaks once on
        insertion and adds nothing to the flood. The flood is `FormField`'s — every field error
        there is `assertive` — and that is a shared component TSD §6.7 fixes, so the change it
        needs is recorded, not made here.

        **And no focus move.** X-47 measured zero focus calls in every production file under
        `apps/mobile/src` — the literal call is spelled out nowhere here on purpose, so that search
        keeps returning zero — `Plan.md` §20 requires focus "preserved on validation failure", and
        whether a summary should ever take it is an open user decision.
      */}
      {invalidFields.length === 0 || !submitted ? null : (
        <StatusMessage
          key={`dietary-setup-invalid-${String(attempts)}`}
          testID="dietary-setup-invalid"
          tone="warning"
          // `alertCircle`, not `warning`: the user is mid-correction and nothing has failed —
          // the same distinction `FormField` draws for its own inline errors.
          icon="alertCircle"
          title={invalidSummary(invalidFields).title}
          description={invalidSummary(invalidFields).description}
          stillAvailable={invalidSummary(invalidFields).stillAvailable}
          announceOnMount
        />
      )}

      {/*
        The save state, when there is one to report. `saveBlocked` is a different message from
        `saveError` because there is nothing to retry (TSD §6.3) - and `preferences` has no bound,
        so reaching it here would itself be a defect worth seeing.

        **`announceOnMount`, because this notice ARRIVES.** It is mounted by a write that was
        refused after the user had already made their choices, which is T-23-05's "async results
        announced" in its most expensive form: without it, a screen-reader user goes on setting
        preferences that are not being kept and is told nothing until the next launch loses them.
        `StatusMessage` implements it as `role="alert"`, whose INSERTION is the announcement, plus
        an `announceForAccessibility` call on iOS.
      */}
      {status.saveError !== null ? (
        <StatusMessage
          testID="dietary-setup-save-error"
          tone="danger"
          icon="alertCircle"
          title={status.saveBlocked ? 'That list is full' : 'Your changes are not saved'}
          description={status.saveError}
          {...(status.saveBlocked ? {} : { actionLabel: 'Try again', onAction: status.retrySave })}
          announceOnMount
        />
      ) : null}

      {/*
        `unavailable` means the read failed, so the store will not write over the key (TSD §6.3).
        The user has to know that, or they will make a careful set of choices and lose them.
      */}
      {/*
        **`recovered` means the stored entry was quarantined and the profile reset to defaults** —
        including `allergies: []`. That is the one reset a user has to be told about: the app looks
        normal, Home paints meals, and nothing is filtering them. Surfaced here and on Home.

        **And it is the one that most needs announcing**, which is why Home's copy carries
        `announceOnMount` and this one now does too. The state says the declared allergy list is
        empty and every meal therefore passes the filter; a user who cannot see the amber panel has
        no other way to learn it. `entryStatus` comes from the hydration snapshot and cannot change
        for the life of the provider, so the branch mounts once and speaks once — which is the
        distinction Plan §20 draws between focus and announcement "moved deliberately" and noise.
      */}
      {status.entryStatus === 'recovered' ? (
        <StatusMessage
          testID="dietary-setup-recovered"
          tone="warning"
          icon="alertCircle"
          title="Your preferences were reset"
          description="The saved copy could not be read, so these are the defaults — including an empty allergy list. Please set your allergies again."
          announceOnMount
        />
      ) : null}

      {/*
        Announced for the same reason: it arrives at hydration, it says the choices made on this
        screen will not survive the app closing, and nothing later in the session repeats it.
      */}
      {status.entryStatus === 'unavailable' ? (
        <StatusMessage
          testID="dietary-setup-unavailable"
          tone="warning"
          icon="warning"
          title="Changes will not be kept"
          description="Your saved preferences could not be read on this device, so nothing is being written over them. What you set here applies until you close the app."
          announceOnMount
        />
      ) : null}

      <FormField
        testID="field-name"
        label="Your name"
        value={preferences.name ?? ''}
        onChangeText={(value) => {
          dispatch(preferencesActions.changeName(value));
        }}
        onBlur={() => {
          markTouched('name');
        }}
        hint="Optional. Used only to greet you."
        // The schema's own bound, shared with the reducer's cap so the field and the store cannot
        // disagree about what a storable name is.
        maxLength={MAX_NAME_LENGTH}
        autoCapitalize="words"
      />

      <Divider />

      <AppText variant="label" tone="secondary">
        Diet
      </AppText>
      <ChipRow
        testIDPrefix="diet"
        values={DIET_TAGS}
        selected={preferences.diet}
        onSelect={(value: DietTag) => {
          dispatch(preferencesActions.changeDiet(value));
        }}
      />

      <AppText variant="label" tone="secondary">
        Allergies
      </AppText>
      {/*
        **A fixed list, not a text box** (R-30). A term the lexicon does not know is matched only as
        a literal ingredient-name substring, so a typed `cilantro` would look like protection and
        provide none.
      */}
      <AppText variant="caption" tone="tertiary">
        Meals containing these are never recommended.
      </AppText>
      {/*
        **No `accessibilityRole` on this wrapper, and that is React Native's limit rather than a
        choice.** ARIA would use `group` for a multi-select set; RN 0.86's `AccessibilityRole` has
        no `group` at all (its list is `none button togglebutton link search image keyboardkey text
        adjustable imagebutton header summary alert checkbox combobox menu menubar menuitem
        progressbar radio radiogroup scrollbar spinbutton switch tab tabbar tablist timer list
        toolbar`), and `radiogroup` would be a lie — these are multi-select.

        What is announced instead is what actually carries the meaning: the visible "Allergies"
        heading above, and each chip's own `checkbox` role with its checked state (S-13). A label on
        a roleless container is ignored by most screen readers, so setting one would be decoration.
        Same class of gap as X-23 and X-25.
      */}
      <View
        testID="field-allergies"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.card.gap }}
      >
        {ALLERGY_CHOICES.map((allergen) => (
          <Chip
            key={allergen}
            testID={`chip-allergy-${allergen}`}
            label={chipLabel(allergen)}
            toggle
            selected={preferences.allergies.includes(allergen)}
            onPress={() => {
              markTouched('allergies');
              const next = preferences.allergies.includes(allergen)
                ? preferences.allergies.filter((one) => one !== allergen)
                : [...preferences.allergies, allergen];
              dispatch(preferencesActions.changeAllergies(next));
            }}
          />
        ))}
      </View>
      {/*
        **There is deliberately no rendered error for the allergy field.**

        Every write path canonicalises — `create`, `allergiesChanged` and `replaced` all run
        `canonicalAllergies` — so `validateAllergies` can never fail through this screen, and a
        surface that cannot be reached is dead UI that reads as coverage.

        The validator stays, because it guards the paths that do NOT come through here: a restored
        backup, a future import, a migration. If one of those ever feeds the store directly, the
        rule is already written and this is where its message belongs.
      */}

      <AppText variant="label" tone="secondary">
        Goal
      </AppText>
      <ChipRow
        testIDPrefix="goal"
        values={NUTRITION_GOALS}
        selected={preferences.goal}
        onSelect={(value: NutritionGoal) => {
          dispatch(preferencesActions.changeGoal(value));
        }}
      />

      <AppText variant="label" tone="secondary">
        Budget
      </AppText>
      <ChipRow
        testIDPrefix="budget"
        values={BUDGET_BANDS}
        selected={preferences.budget}
        onSelect={(value: BudgetBand) => {
          dispatch(preferencesActions.changeBudget(value));
        }}
      />

      <Divider />

      <FormField
        testID="field-dislikes"
        label={FIELD_LABELS.dislikes}
        value={dislikesText}
        onChangeText={(value) => {
          // The draft takes the keystroke so the user keeps their own characters (and their
          // commas); the store takes the cleaned, capped list. When those two disagree — a 31st
          // ingredient — `validateDislikes` reads the draft and says so.
          setDislikesDraft(value);
          dispatch(preferencesActions.changeDislikedIngredients(value.split(',')));
        }}
        onBlur={() => {
          markTouched('dislikes');
        }}
        {...(errorFor('dislikes') === undefined ? {} : { error: errorFor('dislikes') })}
        // Free text on purpose, unlike allergies: a dislike is a preference matched by token
        // against ingredient names, so any word is useful and none of it is a safety claim.
        hint="Separate with commas. These lower a meal's score; they do not remove it."
        maxLength={200}
        autoCapitalize="none"
      />

      <Divider />

      <AppText variant="label" tone="secondary">
        When you usually eat
      </AppText>
      <AppText variant="caption" tone="tertiary">
        Used to decide what to suggest right now.
      </AppText>
      {MEAL_TIME_FIELDS.map((field) => (
        <FormField
          key={field}
          testID={`field-${field}`}
          label={FIELD_LABELS[field]}
          value={draftTimes[field]}
          onChangeText={(value) => {
            // The draft always takes the keystroke, so the user sees their own characters. The
            // store takes it only when it is a time the domain can read — `changeMealTime` refuses
            // anything else, and this is the half that keeps the field usable while they type.
            setDrafts((current) => ({ ...current, [field]: value }));
            dispatch(preferencesActions.changeMealTime(field, value));
          }}
          onBlur={() => {
            markTouched(field);
          }}
          {...(errorFor(field) === undefined ? {} : { error: errorFor(field) })}
          placeholder="08:00"
          required
          keyboardType="numbers-and-punctuation"
          maxLength={5}
        />
      ))}

      <AccessibleButton
        testID="dietary-setup-save"
        label={fromOnboarding ? 'Start using NutriTime' : 'Done'}
        variant="primary"
        onPress={onSave}
      />
    </ScrollView>
  );
}
