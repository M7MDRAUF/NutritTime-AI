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
  isDietarySetupValid,
  validateAllergies,
  validateDislikes,
  validateMealTimes,
} from './dietaryValidation.js';
import type { MealTimeField } from './dietaryValidation.js';
import { ChipRow, chipLabel } from './ChipRow.js';

const MEAL_TIME_FIELDS: readonly MealTimeField[] = ['breakfast', 'lunch', 'dinner'];

const MEAL_TIME_LABELS: Readonly<Record<MealTimeField, string>> = {
  breakfast: 'Breakfast time',
  lunch: 'Lunch time',
  dinner: 'Dinner time',
};

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

  const markTouched = useCallback((field: string) => {
    setTouched((current) => (current.has(field) ? current : new Set([...current, field])));
  }, []);

  const allErrors = useMemo(
    () => ({
      // The DRAFT, not the stored value: the stored value is valid by construction now, so
      // validating it would never report anything and the user would never be told.
      ...validateMealTimes(draftTimes),
      allergies: validateAllergies(preferences.allergies),
      dislikes: validateDislikes(preferences.dislikedIngredients),
    }),
    [
      draftTimes.breakfast,
      draftTimes.lunch,
      draftTimes.dinner,
      preferences.allergies,
      preferences.dislikedIngredients,
    ],
  );

  /** Shown only for a visited field — or for every field once Save has been pressed. */
  const errorFor = (field: string): string | undefined =>
    touched.has(field) || submitted
      ? (allErrors as Record<string, string | undefined>)[field]
      : undefined;

  const valid = isDietarySetupValid(allErrors);

  const onSave = (): void => {
    setSubmitted(true);
    if (!valid) {
      // Nothing to save and nothing to navigate to: the errors are already on screen, because
      // `submitted` now un-filters them. Leaving the user here with the messages visible is the
      // whole point of the flag.
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
        The save state, when there is one to report. `saveBlocked` is a different message from
        `saveError` because there is nothing to retry (TSD §6.3) - and `preferences` has no bound,
        so reaching it here would itself be a defect worth seeing.
      */}
      {status.saveError !== null ? (
        <StatusMessage
          testID="dietary-setup-save-error"
          tone="danger"
          icon="alertCircle"
          title={status.saveBlocked ? 'That list is full' : 'Your changes are not saved'}
          description={status.saveError}
          {...(status.saveBlocked ? {} : { actionLabel: 'Try again', onAction: status.retrySave })}
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
      */}
      {status.entryStatus === 'recovered' ? (
        <StatusMessage
          testID="dietary-setup-recovered"
          tone="warning"
          icon="alertCircle"
          title="Your preferences were reset"
          description="The saved copy could not be read, so these are the defaults — including an empty allergy list. Please set your allergies again."
        />
      ) : null}

      {status.entryStatus === 'unavailable' ? (
        <StatusMessage
          testID="dietary-setup-unavailable"
          tone="warning"
          icon="warning"
          title="Changes will not be kept"
          description="Your saved preferences could not be read on this device, so nothing is being written over them. What you set here applies until you close the app."
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
        maxLength={60}
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
        label="Ingredients you would rather avoid"
        value={preferences.dislikedIngredients.join(', ')}
        onChangeText={(value) => {
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
          label={MEAL_TIME_LABELS[field]}
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
