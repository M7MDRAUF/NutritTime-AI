/**
 * Create and edit a meal the user authored themselves (T-17-03 … T-17-07, FR-013).
 *
 * **The draft lives here and only a composed record reaches the store.** That is P14's CRITICAL
 * fix generalised: the screen that shipped it dispatched on every keystroke, the store held a
 * value its key's schema rejected, `repository.set` does not re-validate by design, the write
 * persisted, and the **next launch quarantined the whole entry** — erasing the user's allergy
 * list with nothing on screen. So `MealFormDraft` is all strings, `composeCustomMeal` and
 * `composeCustomMealUpdate` are the only things in this app that produce a `CustomMeal`, and this
 * screen dispatches exactly once per Save.
 *
 * **A refused create is SILENT, and there are three causes of it** — the 200 bound, an id already
 * present, and a record `customMealSchema` rejects. Each makes `customMealsReducer` return
 * `state` *identically*; `dispatch` returns `void`; and `saveBlocked` never fires, because no
 * write is attempted at all. There is no error to read. A form that closed here would have told
 * the user their meal was saved when it was not, which is the same silent-data-loss shape. Hence
 * all four rules of CONTRACTS §2, every one of them load-bearing:
 *
 *  - `selectAtCustomMealsBound` is checked **before** a create is dispatched, so the user reads
 *    "the list is full" rather than "this could not be saved";
 *  - `existingIds` is the store's real id list, never `[]` — with `[]` the collision guard inside
 *    `composeCustomMeal` is inert *and* the reducer refuses the duplicate silently, so a
 *    collision would make the meal vanish with no message;
 *  - the write is confirmed with `hasCustomMeal` **on the next rendered value**, never on the
 *    press (`pendingSave` + an effect, because the press cannot see the state it caused);
 *  - a confirmation that fails **says so and keeps the form open**, and never retries as an
 *    `update` — an update would overwrite whatever record already holds that id.
 *
 * **That confirmation proves the DISPATCH landed, not the write — and one state makes the
 * difference fatal.** When the `customMeals` key read as `unavailable`, `createStore` skips the
 * write by design (TSD §6.3: the bytes on disk are unknown, so this session must not write over
 * them) and skips it *silently*: `saveError` null, `saveBlocked` false, because nothing was
 * attempted. The reducer still accepts the record, so every success signal agrees — and the form
 * would close on a meal that is gone at the next launch. So `entryStatus` is checked **before**
 * either dispatch, and a save that cannot be persisted never reports success.
 *
 * **The allergen tags are checked against the user's declared allergies with the DOMAIN's
 * matcher** (`conflictingAllergens`, TSD §4.4), because a custom meal is one of the few records
 * the recommendation lane never sees: the server serves the catalog, so nothing else in the app
 * will ever read this record's tags. This screen is where that conflict is said out loud, and the
 * field's caption says what the tags do rather than promising filtering that cannot happen.
 *
 * **When errors are shown follows S-43**, which P14 recorded and `DietarySetupScreen` encodes:
 * every error is computed from the draft on every render (they have to be, or a correction would
 * not clear), then filtered by whether the field has been visited. A half-typed price is not a
 * wrong price, it is an unfinished one. A field stays visited, so a correction is forgiven on the
 * next keystroke, and Save un-filters everything — otherwise a deliberate press on an untouched
 * invalid field would appear to do nothing.
 *
 * **A `mealId` that is not in the store is a real state**, not an edge case: a stale deep link, or
 * a record deleted on another screen. It renders not-found rather than an empty create form
 * wearing an edit title, which would invite the user to retype a meal they already have.
 *
 * **The clock is the storage runtime's**, not `Date.now()`: `runtime.now` is what stamps the
 * envelope this record is written into, and injecting it is what keeps `createdAt`/`updatedAt`
 * assertable instead of dependent on the time of day (TSD §6.4's reasoning for the same seam).
 *
 * **What is in `MealFormControls.tsx` and what stayed here.** That file holds the controls — the
 * chip groups, the two row shapes, the four nutrition boxes and the error row they share — and
 * knows nothing of a draft, a store or a rule. The four things above are one mechanism, so they
 * are all still in this file: the draft state, the `validateMealForm` call, the visited-field
 * filter and the create-confirmation lane. Splitting any of them out would put half of the guard
 * against a half-typed value somewhere a reviewer would have to go looking for it, which is how
 * P14 happened.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { CANONICAL_ALLERGENS, DIET_TAGS, MEAL_PERIODS } from '@nutritime/contracts';
import type { CustomMeal } from '@nutritime/contracts';
import { conflictingAllergens } from '@nutritime/domain';
import {
  AccessibleButton,
  AppText,
  Divider,
  EmptyState,
  FormField,
  Sheet,
  StatusMessage,
} from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { useStorageContext } from '../../state/StorageProvider.js';
import {
  MAX_CUSTOM_MEALS,
  customMealsActions,
  customMealsStore,
  hasCustomMeal,
  selectAtCustomMealsBound,
  selectCustomMeal,
  selectCustomMeals,
} from '../../state/customMeals/index.js';
import { preferencesStore, selectPreferences } from '../../state/preferences/index.js';
import {
  MEAL_FORM_MESSAGES,
  composeCustomMeal,
  composeCustomMealUpdate,
  draftFromCustomMeal,
  generateMealId,
  validateMealForm,
} from './mealFormValidation.js';
import type { MealFormDraft, MealFormErrors, MealFormField } from './mealFormValidation.js';
import {
  CREATE_DRAFT,
  ChipGroup,
  GroupError,
  IngredientRow,
  NUTRIENT_SPECS,
  NutritionField,
  StepRow,
  namedList,
  toggled,
} from './MealFormControls.js';
import type { TextField } from './MealFormControls.js';

const NO_ERRORS: MealFormErrors = {};

/**
 * What the last press produced, when the user has to be told something about it.
 *
 * One state for three different failures, because they reach the user the same way — a message
 * where they are looking, announced when it appears — and because only one of them can be true
 * of a single press:
 *
 *  - `invalid`: fields are wrong. **This is the one V7 caught.** Pressing Save on an invalid form
 *    mounts up to fourteen `role="alert"` regions at once, `accessibilityLiveRegion` is
 *    Android-only, and `FormField` has no iOS announcement — so to VoiceOver the button was dead.
 *    This summary carries `announceOnMount`, which `StatusMessage` implements with
 *    `AccessibilityInfo.announceForAccessibility` on iOS.
 *  - `unstorable`: the `customMeals` key read as `unavailable`, so nothing can be written at all.
 *  - `refused`: the dispatch went nowhere. Defensive; see the confirmation effect below.
 */
type Outcome =
  | { readonly kind: 'invalid'; readonly count: number }
  | { readonly kind: 'unstorable'; readonly action: 'save' | 'delete' }
  | { readonly kind: 'refused'; readonly action: 'save' | 'delete' }
  | null;

interface OutcomeMessage {
  readonly testID: string;
  readonly title: string;
  readonly description: string;
  readonly stillAvailable: string;
}

/**
 * The copy for each outcome, beside the branch that produces it.
 *
 * PRD §12: what happened, what still works, what to do next. **No outcome here ever says a save
 * succeeded**, and two of them exist precisely so the screen cannot claim one.
 */
function outcomeMessage(outcome: NonNullable<Outcome>): OutcomeMessage {
  if (outcome.kind === 'invalid') {
    return {
      testID: 'meal-form-invalid',
      title: 'This meal is not saved yet',
      description:
        outcome.count === 1
          ? 'One field needs attention. It is marked below with what to change.'
          : `${String(outcome.count)} fields need attention. Each one is marked below with what to change.`,
      stillAvailable: 'Nothing you have typed is lost.',
    };
  }
  if (outcome.kind === 'unstorable') {
    return {
      testID: 'meal-form-unstorable',
      // Never "saved" and never "deleted": the key could not be read, so the store will not write
      // over it (TSD §6.3) — and an in-memory change nobody can persist would be gone at the next
      // launch with no message, which is the silence this whole screen is built against.
      title:
        outcome.action === 'save' ? 'This meal cannot be saved' : 'This meal cannot be deleted',
      description:
        'Your saved meals could not be read on this device, so nothing is being written over them.',
      stillAvailable:
        outcome.action === 'save'
          ? 'Everything you typed is still here. Close and reopen the app, then try again.'
          : 'This meal is untouched. Close and reopen the app, then try again.',
    };
  }
  return {
    testID: outcome.action === 'save' ? 'meal-form-save-failed' : 'meal-form-delete-failed',
    title: outcome.action === 'save' ? 'This meal was not saved' : 'This meal was not deleted',
    description:
      outcome.action === 'save'
        ? 'The saved list did not accept it, so nothing was changed.'
        : 'The saved list still holds it, so nothing was changed.',
    stillAvailable: 'Everything you typed is still here. Check the fields above and try again.',
  };
}

export function MealFormScreen({ route, navigation }: ScreenProps<'MealForm'>): ReactNode {
  const { colors, components } = useTheme();
  const { runtime } = useStorageContext();
  const state = customMealsStore.useValue();
  const dispatch = customMealsStore.useDispatch();
  const status = customMealsStore.useStatus();

  const mealId = route.params?.mealId;
  // Absent `mealId` means create, present means edit: one screen, two journeys (PRD §8.3).
  const existing = mealId === undefined ? undefined : selectCustomMeal(state, mealId);
  const atBound = selectAtCustomMealsBound(state);

  const [draft, setDraft] = useState<MealFormDraft>(() =>
    existing === undefined ? CREATE_DRAFT : draftFromCustomMeal(existing),
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  /** Errors the composers reported — the schema backstop and the id collision. */
  const [composeErrors, setComposeErrors] = useState<MealFormErrors>(NO_ERRORS);
  /** The record whose arrival in the store has not been confirmed yet. Never trust the press. */
  const [pendingSave, setPendingSave] = useState<CustomMeal | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  /**
   * Presses of Save, only to key the outcome message.
   *
   * `StatusMessage` announces on **mount**, so a second press with the same errors would render
   * identical copy, never remount, and say nothing — the dead-button experience again. Keying the
   * message by attempt remounts it, which is what makes the announcement repeat.
   */
  const [attempts, setAttempts] = useState(0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** A save that landed. The screen is leaving, and nothing may be dispatched from it again. */
  const [done, setDone] = useState(false);

  /**
   * Where this screen goes when it is finished, and why it is not a bare `goBack`.
   *
   * `MealForm` is deep-linkable (`navigation/linking.ts`), so it can be the first screen in the
   * stack — and then `goBack()` is a no-op and the user is stranded on a form they have already
   * saved, with a second press about to be latched away by `done`. `MealDetailsScreen` solved the
   * identical case with `canGoBack()`; the Saved tab is where a custom meal lives, so that is the
   * fallback here.
   */
  const leave = useCallback((): void => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate('Tabs', { screen: 'SavedTab' });
  }, [navigation]);

  const forget = (): void => {
    // A correction forgives on the next keystroke (S-43), and so does a failed save: leaving
    // either on screen while the user edits would be telling them off for a value they changed.
    setComposeErrors(NO_ERRORS);
    setOutcome(null);
  };

  const setText = (field: TextField, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    forget();
  };

  const change = (patch: (current: MealFormDraft) => Partial<MealFormDraft>): void => {
    setDraft((current) => ({ ...current, ...patch(current) }));
    forget();
  };

  const markTouched = useCallback((...fields: readonly MealFormField[]): void => {
    setTouched((current) =>
      fields.every((field) => current.has(field)) ? current : new Set([...current, ...fields]),
    );
  }, []);

  /**
   * Which of the user's declared allergies this draft conflicts with.
   *
   * **The domain's matcher, never one written here** (TSD §4.4, Plan §2, and `MealDetailsBody`
   * makes the same call for the same reason). Two matchers would disagree about `peanut oil` —
   * inferred from an ingredient name, never tagged — and about `water chestnut`, which a naive
   * scan matches and the lexicon suppresses, while each passed its own tests.
   *
   * `MealFormDraft` is structurally an `AllergenSubject`, so the live draft can be asked directly:
   * the notice appears on the keystroke that makes it true, not after a save.
   */
  const allergies = selectPreferences(preferencesStore.useValue()).allergies;
  const conflicts = useMemo(
    () =>
      conflictingAllergens(
        { allergenTags: draft.allergenTags, ingredients: draft.ingredients },
        allergies,
      ),
    [draft.allergenTags, draft.ingredients, allergies],
  );

  const validation = useMemo(() => validateMealForm(draft), [draft]);
  const errors: MealFormErrors = { ...validation, ...composeErrors };
  const errorFor = (field: MealFormField): string | undefined =>
    touched.has(field) || submitted ? errors[field] : undefined;
  /** Spread in or left out entirely rather than passed as `undefined` — the idiom
   * `DietarySetupScreen` uses, and the one that keeps "no error" out of the props at all. */
  const errorProp = (field: MealFormField): { readonly error?: string } => {
    const message = errorFor(field);
    return message === undefined ? {} : { error: message };
  };

  /**
   * The confirmation, and the reason it is an effect rather than the end of `onSave`.
   *
   * `dispatch` returns `void` and a refusal returns `state` identically, so the press cannot see
   * whether the record landed. This runs on the **next render**, against the value that dispatch
   * produced. Reference identity is checked as well as presence: for an update the id was already
   * there, so `hasCustomMeal` alone would report success for an edit the reducer refused.
   *
   * **What this confirms is the DISPATCH, not the write, and that distinction cost a CRITICAL.**
   * A key whose read failed is `unavailable`, `createStore` then skips the write deliberately
   * (TSD §6.3), and it does so *silently* — `saveError` stays null and `saveBlocked` stays false,
   * because no write was attempted to fail. So the reducer accepts the record, this check finds
   * it, and the screen would close on a meal that was never persisted. That state is refused
   * **before** the dispatch, in `onSave` and `onDelete`, which is the only place it can be
   * refused honestly; this effect covers the three reducer-level refusals and nothing else.
   */
  useEffect(() => {
    if (pendingSave === null) {
      return;
    }
    const landed =
      hasCustomMeal(state, pendingSave.id) &&
      selectCustomMeal(state, pendingSave.id) === pendingSave;
    setPendingSave(null);
    if (landed) {
      setDone(true);
      leave();
      return;
    }
    setOutcome({ kind: 'refused', action: 'save' });
  }, [pendingSave, state, leave]);

  useEffect(() => {
    if (pendingDelete === null) {
      return;
    }
    const gone = !hasCustomMeal(state, pendingDelete);
    setPendingDelete(null);
    if (gone) {
      setDone(true);
      leave();
      return;
    }
    setOutcome({ kind: 'refused', action: 'delete' });
  }, [pendingDelete, state, leave]);

  const onSave = (): void => {
    /**
     * **One record per Save, whatever the user's thumb does.**
     *
     * A create generates a fresh id every time, so a second press that got through would compose a
     * second record the reducer would happily accept — duplication this screen exists to prevent,
     * and invisible until the user opens Saved and finds their meal twice. `done` latches the save
     * that landed (the screen is on its way out; `goBack` is not instantaneous) and `pendingSave`
     * covers the window before the confirmation has run.
     */
    if (done || pendingSave !== null) {
      return;
    }
    // Un-filters every error, so a press on an untouched invalid field shows what is wrong
    // instead of appearing to do nothing.
    setSubmitted(true);
    setComposeErrors(NO_ERRORS);
    setOutcome(null);
    setAttempts((current) => current + 1);
    /**
     * **The storage check comes first, before validation, and deliberately.**
     *
     * If the key cannot be written, which fields are wrong is not the user's problem — sending
     * them to fix three boxes for a save that cannot happen either way would waste their time and
     * then fail anyway. Refused here rather than after the dispatch, because after the dispatch
     * there is nothing to observe: the reducer accepts the record, the write is skipped in
     * silence, and every success signal this screen has would agree that it worked.
     */
    if (status.entryStatus === 'unavailable') {
      setOutcome({ kind: 'unstorable', action: 'save' });
      return;
    }
    const invalid = Object.keys(validation).length;
    if (invalid > 0) {
      // The summary V7 asked for. The field-bound errors are already on screen and are what a
      // sighted user reads; this is what a screen reader is told, and what makes the button's
      // refusal audible instead of fourteen simultaneous alerts with no lede.
      setOutcome({ kind: 'invalid', count: invalid });
      return;
    }
    if (existing !== undefined) {
      // Editing an existing meal saves at the bound too: it stores no additional record, and a
      // naive bound check here would strand the user with an uneditable list.
      const composed = composeCustomMealUpdate(draft, existing, { now: runtime.now });
      if (!composed.ok) {
        // Field-bound like a validation error, so it gets the same summary and the same
        // announcement: the id collision lands on the name field, and a refusal a screen reader
        // is not told about is the dead button all over again.
        setComposeErrors(composed.errors);
        setOutcome({ kind: 'invalid', count: Object.keys(composed.errors).length });
        return;
      }
      dispatch(customMealsActions.update(composed.meal));
      setPendingSave(composed.meal);
      return;
    }
    if (atBound) {
      // The bound message is already on screen and there is nothing to retry (TSD §6.4). Reaching
      // the reducer would be refused silently and the user would read the wrong explanation.
      return;
    }
    const composed = composeCustomMeal(draft, {
      now: runtime.now,
      newId: () => generateMealId(),
      // The store's real ids, read from the same state this create is dispatched to. `[]` here
      // would make the collision guard inert and a collision silent.
      existingIds: selectCustomMeals(state).map((meal) => meal.id),
    });
    if (!composed.ok) {
      setComposeErrors(composed.errors);
      return;
    }
    dispatch(customMealsActions.create(composed.meal));
    setPendingSave(composed.meal);
  };

  const onDelete = (): void => {
    setConfirmingDelete(false);
    // Same latch as `onSave`: once a dispatch of ours has landed this screen is leaving, and a
    // second one from it would act on a record the user is no longer looking at.
    if (done || pendingDelete !== null) {
      return;
    }
    if (existing === undefined) {
      return;
    }
    // A delete that cannot be written is worse than a save that cannot: the record would vanish
    // from the list and be back at the next launch, which reads as the app undoing the user.
    if (status.entryStatus === 'unavailable') {
      setOutcome({ kind: 'unstorable', action: 'delete' });
      return;
    }
    dispatch(customMealsActions.remove(existing.id));
    setPendingDelete(existing.id);
  };

  if (mealId !== undefined && existing === undefined) {
    /**
     * Not-found, and the copy is true of both ways here: a stale deep link and a record just
     * deleted from this screen. Announcing "edit" over an empty form would invite the user to
     * retype a meal they may still have.
     */
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.surface.canvas,
          padding: components.card.padding,
        }}
      >
        <EmptyState
          testID="meal-form-not-found"
          title="That meal is not here"
          description="It may have been deleted, or the screen was opened from a link that is out of date."
          stillAvailable="Your other saved meals are unchanged."
          actionLabel="Back to saved meals"
          onAction={leave}
        />
      </View>
    );
  }

  /** The two list-level errors, which belong to the list rather than to any one row. */
  const rowsError = errorFor('ingredients');
  const stepsError = errorFor('instructions');

  return (
    <ScrollView
      testID="meal-form-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
      keyboardShouldPersistTaps="handled"
    >
      <AppText variant="title" tone="primary" level={1}>
        {existing === undefined ? 'New meal' : 'Edit meal'}
      </AppText>

      {/*
        **The conflict notice, second and in the danger tone**, exactly as `MealDetailsBody` places
        and words its own: a sentence about "this meal" needs the name above it, and a warning
        under four paragraphs of method has warned nobody. It recomputes from the draft on every
        render, so it appears on the keystroke that makes it true rather than after a save.
      */}
      {conflicts.length > 0 ? (
        <StatusMessage
          testID="meal-form-allergen-conflict"
          tone="danger"
          icon="warning"
          // NAMED. "Contains allergens" is not something a user can act on.
          title={`This meal conflicts with your ${namedList(conflicts)} allergy`}
          description={`You declared ${namedList(conflicts)} as an allergy, and this meal either carries that tag or names it among its ingredients.`}
          stillAvailable="Saving it is allowed — your own meals are yours. Nothing here is a substitute for reading the label."
          announceOnMount
        />
      ) : null}

      {/*
        **`unavailable` means nothing can be written at all** (TSD §6.3: the read failed, so the
        store will not write over a key whose contents are unknown), and it is skipped in
        *silence* — no `saveError`, no `saveBlocked`, because no write is attempted. Said up front
        for the same reason `SettingsScreen` and `DietarySetupScreen` say it: a user who fills in
        thirteen fields and loses them was misled by silence, not by a message.
      */}
      {status.entryStatus === 'unavailable' ? (
        <StatusMessage
          testID="meal-form-unavailable"
          tone="warning"
          icon="warning"
          title="Meals cannot be saved right now"
          description="Your saved meals could not be read on this device, so nothing is being written over them."
          stillAvailable="You can still write this out, but it will not be kept. Close and reopen the app to try again."
        />
      ) : null}

      {/*
        T-17-07. Said before anything is typed, because the answer is not "try again" — it is
        delete one first, which is somewhere else. No action, deliberately (TSD §6.3: a blocked
        write has nothing to retry).
      */}
      {existing === undefined && atBound ? (
        <StatusMessage
          testID="meal-form-bound"
          tone="warning"
          icon="alertCircle"
          title="Your custom meals list is full"
          // The bound from the store, never a retyped literal: a copied `200` drifts from
          // `STORAGE_BOUNDS` the moment either moves, and the drift reads as a lie to the user.
          description={`This device keeps up to ${String(MAX_CUSTOM_MEALS)} custom meals, so a new one cannot be saved.`}
          stillAvailable="Your saved meals all still work. Delete one to make room for another."
        />
      ) : null}

      {/*
        The storage backstop, for a write refused after the reducer accepted it. `saveBlocked` is
        presented differently from `saveError` because there is nothing to retry.
      */}
      {status.saveError !== null ? (
        <StatusMessage
          testID="meal-form-save-error"
          tone="danger"
          icon="alertCircle"
          title={status.saveBlocked ? 'That list is full' : 'Your meal is not saved'}
          description={status.saveError}
          {...(status.saveBlocked ? {} : { actionLabel: 'Try again', onAction: status.retrySave })}
        />
      ) : null}

      <FormField
        testID="field-name"
        label="Meal name"
        value={draft.name}
        onChangeText={(value) => {
          setText('name', value);
        }}
        onBlur={() => {
          markTouched('name');
        }}
        {...errorProp('name')}
        required
        maxLength={200}
      />

      <FormField
        testID="field-description"
        label="Description"
        value={draft.description}
        onChangeText={(value) => {
          setText('description', value);
        }}
        onBlur={() => {
          markTouched('description');
        }}
        {...errorProp('description')}
        hint="Optional. What it is, in a line or two."
        multiline
        maxLength={500}
      />

      <Divider />

      <ChipGroup
        label="Time of day"
        field="mealPeriods"
        prefix="period"
        values={MEAL_PERIODS}
        selected={draft.mealPeriods}
        onToggle={(period) => {
          markTouched('mealPeriods');
          change((current) => ({ mealPeriods: toggled(current.mealPeriods, period) }));
        }}
        {...errorProp('mealPeriods')}
      />

      <ChipGroup
        label="Diet tags"
        field="dietTags"
        prefix="diet"
        values={DIET_TAGS}
        selected={draft.dietTags}
        onToggle={(tag) => {
          markTouched('dietTags');
          change((current) => ({ dietTags: toggled(current.dietTags, tag) }));
        }}
        {...errorProp('dietTags')}
      />

      {/*
        **A fixed list, not a text box** (R-30): a typed `peanuts` is not the canonical `peanut`,
        so it would look exactly like a declaration and match nothing. `CANONICAL_ALLERGENS` is
        the taxonomy the matcher knows.

        **And the caption says what these tags actually do, which is less than it used to claim.**
        It read "Used to keep this meal away from anyone with that allergy" — filtering that
        cannot happen: recommendations and the assistant are served from the catalog, and a meal
        the user authored is not in it, so nothing in that lane ever reads this record. What the
        tags do reach is the conflict notice above, on this screen and wherever else a custom meal
        is shown. A caption that overstates a safety guarantee is worse than no caption, because
        it is the sentence the user relies on.
      */}
      <ChipGroup
        label="Allergens in this meal"
        caption="Optional. These do not filter your suggestions — those come from the app's own catalog, which your meals are not part of. They are what warns you here when a meal you are writing conflicts with an allergy you have declared."
        field="allergenTags"
        prefix="allergen"
        values={CANONICAL_ALLERGENS}
        selected={draft.allergenTags}
        onToggle={(allergen) => {
          change((current) => ({ allergenTags: toggled(current.allergenTags, allergen) }));
        }}
      />

      <Divider />

      <AppText variant="label" tone="secondary">
        Ingredients
      </AppText>
      {draft.ingredients.map((row, index) => (
        <IngredientRow
          key={`ingredient-${String(index)}`}
          index={index}
          name={row.name}
          measure={row.measure}
          onChangeName={(value) => {
            change((current) => ({
              ingredients: current.ingredients.map((one, at) =>
                at === index ? { ...one, name: value } : one,
              ),
            }));
          }}
          onChangeMeasure={(value) => {
            change((current) => ({
              ingredients: current.ingredients.map((one, at) =>
                at === index ? { ...one, measure: value } : one,
              ),
            }));
          }}
          onBlur={() => {
            markTouched(`ingredient.${index}`, 'ingredients');
          }}
          onRemove={() => {
            change((current) => ({
              ingredients: current.ingredients.filter((_one, at) => at !== index),
            }));
          }}
          {...errorProp(`ingredient.${index}`)}
        />
      ))}
      {rowsError === undefined ? null : (
        <GroupError testID="error-ingredients" message={rowsError} />
      )}
      <AccessibleButton
        testID="add-ingredient"
        label="Add an ingredient"
        variant="ghost"
        icon="plus"
        onPress={() => {
          change((current) => ({
            ingredients: [...current.ingredients, { name: '', measure: '' }],
          }));
        }}
      />

      <Divider />

      <AppText variant="label" tone="secondary">
        Steps
      </AppText>
      {draft.instructions.map((step, index) => (
        <StepRow
          key={`instruction-${String(index)}`}
          index={index}
          value={step}
          onChangeText={(value) => {
            change((current) => ({
              instructions: current.instructions.map((one, at) => (at === index ? value : one)),
            }));
          }}
          onBlur={() => {
            markTouched(`instruction.${index}`, 'instructions');
          }}
          onRemove={() => {
            change((current) => ({
              instructions: current.instructions.filter((_one, at) => at !== index),
            }));
          }}
          {...errorProp(`instruction.${index}`)}
        />
      ))}
      {stepsError === undefined ? null : (
        <GroupError testID="error-instructions" message={stepsError} />
      )}
      <AccessibleButton
        testID="add-instruction"
        label="Add a step"
        variant="ghost"
        icon="plus"
        onPress={() => {
          change((current) => ({ instructions: [...current.instructions, ''] }));
        }}
      />

      <Divider />

      <FormField
        testID="field-price"
        label="Price"
        value={draft.priceText}
        onChangeText={(value) => {
          setText('priceText', value);
        }}
        onBlur={() => {
          markTouched('priceText');
        }}
        {...errorProp('priceText')}
        hint="In dollars and cents. Enter 0 if it costs you nothing."
        placeholder="4.50"
        required
        keyboardType="decimal-pad"
        maxLength={12}
      />

      <FormField
        testID="field-minutes"
        label="Preparation time in minutes"
        value={draft.preparationMinutesText}
        onChangeText={(value) => {
          setText('preparationMinutesText', value);
        }}
        onBlur={() => {
          markTouched('preparationMinutesText');
        }}
        {...errorProp('preparationMinutesText')}
        hint={MEAL_FORM_MESSAGES.minutesRange}
        placeholder="10"
        required
        keyboardType="number-pad"
        maxLength={12}
      />

      <Divider />

      <AppText variant="label" tone="secondary">
        Nutrition
      </AppText>
      {/*
        The all-or-nothing rule, stated **before** anyone can break it (FR-006, and
        `mealSchema.superRefine` enforces it). A meal whose nutrition is three-quarters known is a
        meal whose nutrition is unknown, so three-of-four is an error — and being told that after
        filling three boxes, with no warning beforehand, is how a form feels like a trap.
      */}
      <AppText variant="caption" tone="tertiary">
        Optional as a group. Leave all four blank, or fill all four and say how many servings they
        are for — a partly known figure reads as complete and is worse than none.
      </AppText>
      {NUTRIENT_SPECS.map((spec) => (
        <NutritionField
          key={spec.field}
          spec={spec}
          value={draft[spec.field]}
          onChangeText={(value) => {
            setText(spec.field, value);
          }}
          onBlur={() => {
            markTouched(spec.field);
          }}
          {...errorProp(spec.field)}
        />
      ))}

      <FormField
        testID="field-servings"
        label="Servings these figures are for"
        value={draft.servingsText}
        onChangeText={(value) => {
          setText('servingsText', value);
        }}
        onBlur={() => {
          markTouched('servingsText');
        }}
        {...errorProp('servingsText')}
        hint={MEAL_FORM_MESSAGES.servingsRange}
        keyboardType="number-pad"
        maxLength={12}
      />

      <Divider />

      {/*
        **The outcome of the last press, next to the button that was pressed.** A summary at the
        top of a form this long is a summary a sighted user never sees, because their eyes are on
        Save — and `announceOnMount` is what tells everybody else, keyed by attempt so a second
        press announces again instead of re-rendering the same mounted message in silence.

        Every branch is a refusal. Nothing here can report a success: a save that worked has
        already left the screen.
      */}
      {outcome === null ? null : (
        <StatusMessage
          key={`outcome-${String(attempts)}`}
          testID={outcomeMessage(outcome).testID}
          tone={outcome.kind === 'invalid' ? 'warning' : 'danger'}
          icon="alertCircle"
          title={outcomeMessage(outcome).title}
          description={outcomeMessage(outcome).description}
          stillAvailable={outcomeMessage(outcome).stillAvailable}
          announceOnMount
        />
      )}

      <AccessibleButton
        testID="meal-form-save"
        label={existing === undefined ? 'Save meal' : 'Save changes'}
        variant="primary"
        onPress={onSave}
      />

      {/*
        Delete exists only where there is something to delete, and so does its sheet — a
        confirmation rendered in create mode would need copy for a meal that does not exist.
        No icon: the set has no bin glyph, and `close` means dismiss while `danger` means failed.
      */}
      {existing === undefined ? null : (
        <>
          <AccessibleButton
            testID="meal-form-delete"
            label="Delete meal"
            variant="destructive"
            onPress={() => {
              // FR-014: destructive actions confirm first. Nothing is dispatched from here.
              setConfirmingDelete(true);
            }}
          />

          <Sheet
            testID="meal-form-delete-sheet"
            visible={confirmingDelete}
            onClose={() => {
              setConfirmingDelete(false);
            }}
            title="Delete this meal?"
          >
            <View style={{ gap: components.card.gap }}>
              <AppText variant="body" tone="secondary">
                {`"${existing.name}" will be removed from your saved meals. This cannot be undone.`}
              </AppText>
              <AccessibleButton
                testID="meal-form-delete-confirm"
                label="Delete meal"
                variant="destructive"
                onPress={onDelete}
              />
              {/* The way out is a real button, not only the backdrop: a cancel nobody can find is
                  a confirmation that eventually gets pressed by accident. */}
              <AccessibleButton
                testID="meal-form-delete-cancel"
                label="Keep meal"
                variant="secondary"
                onPress={() => {
                  setConfirmingDelete(false);
                }}
              />
            </View>
          </Sheet>
        </>
      )}
    </ScrollView>
  );
}
