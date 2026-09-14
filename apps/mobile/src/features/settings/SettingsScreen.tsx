/**
 * Settings (T-18-02 … T-18-07, PRD FR-014). The one screen from which a user destroys their data.
 *
 * Four decisions here are load-bearing rather than stylistic.
 *
 * **1. The preference form is REUSED, not re-implemented.** Plan §5 P18 says so explicitly and
 * `DietarySetupParams.returnTo: 'Settings'` exists for exactly this, so "edit preferences and meal
 * times" is one `navigate` rather than a second copy of six fields. A second copy would be a second
 * spelling of the allergy rule, and `DietarySetupScreen` is where R-30's containment lives — a fixed
 * allergen list rather than a text box. Rebuilding the form here risks a settings screen that lets a
 * user type an allergy the matcher cannot act on.
 *
 * **2. A selective clear is a DISPATCH, never a key removal.** Each goes through its store's
 * existing projection, so memory and disk stay in agreement and the user is not thrown out of
 * Settings mid-gesture. Only the full reset removes keys, and only because the `onboarding` store
 * deliberately has **no reset action** — `onboardingState.ts` says why: "an action that un-completes
 * onboarding would be reachable from any screen holding a dispatch, and sending a user back through
 * setup is a destructive action that TSD §6.7 puts behind a confirmation". So the full reset is the
 * only path that can un-complete onboarding, and it is `useDataReset().resetAll()`.
 *
 * **3. `resetAll()` is fire-and-forget, and `resetting` is never true here.** Both are consequences
 * of the reset mechanism: the clear runs with the storage subtree — this screen included —
 * unmounted, which is what stops a store issuing a write over the keys being removed. So nothing is
 * awaited and no state is touched afterwards, because there is no "afterwards" for this component;
 * and **no spinner, no disabled button and no other UI is gated on `resetting`**, because no
 * consumer of `useDataReset` can be mounted while it is true — a control gated on it could never
 * fire and its test could never fail. During the clear the user sees the provider's `fallback`.
 * `resetError` is the opposite case and IS surfaced: it lives above the unmount, survives it, and
 * names the sets that came back.
 *
 * **4. Every confirmation carries the loss in its copy, with counts.** PRD FR-014: "Destructive
 * actions confirm first". "Are you sure?" confirms nothing — the sheet says which set goes, how many
 * records that is, and which sets are untouched, because "clear favourites" and "erase everything"
 * are one list apart on this screen.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { THEME_MODES } from '@nutritime/contracts';
import {
  AccessibleButton,
  AppText,
  Chip,
  Divider,
  Sheet,
  StatusMessage,
} from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { DEFAULT_PREFERENCES } from '../../infrastructure/storage/definitions.js';
import { preferencesActions, preferencesStore } from '../../state/preferences/index.js';
import {
  favoritesActions,
  favoritesStore,
  selectFavoriteIds,
} from '../../state/favorites/index.js';
import {
  customMealsActions,
  customMealsStore,
  selectCustomMeals,
} from '../../state/customMeals/index.js';
import { selectDisclaimerAcknowledged, uiStore } from '../../state/ui/index.js';
import { REQUIRED_ATTRIBUTION, THEME_LABELS, confirmationFor } from './settingsCopy.js';
import type { DestructiveId } from './settingsCopy.js';
import { StoreStatusNotices } from './StoreStatusNotices.js';
import type { StoreStatusNoticesProps } from './StoreStatusNotices.js';
import { useDataReset } from './DataResetProvider.js';

export function SettingsScreen({ navigation }: ScreenProps<'Settings'>): ReactNode {
  const { colors, components } = useTheme();

  const preferencesState = preferencesStore.useValue();
  const dispatchPreferences = preferencesStore.useDispatch();
  const favoritesState = favoritesStore.useValue();
  const dispatchFavorites = favoritesStore.useDispatch();
  const customMealsState = customMealsStore.useValue();
  const dispatchCustomMeals = customMealsStore.useDispatch();
  const uiState = uiStore.useValue();
  const { resetAll, resetError } = useDataReset();

  /**
   * **The status of every store this screen clears, not just `preferences`.**
   *
   * A dispatch is not a write. `createStore`'s queue writes after the fact and can fail, and it
   * writes nothing at all over a key whose read was `unavailable` (TSD §6.3, deliberately) — so
   * without these three the screen could say "this removes 2 favourited meals", empty the list on
   * screen, and hand back every favourite at the next launch with no message anywhere. A confirmed
   * destructive action that silently did not happen is the worst outcome this screen can produce,
   * and it was reachable by suppressing one key's `repository.set`.
   */
  const favoritesStatus = favoritesStore.useStatus();
  const customMealsStatus = customMealsStore.useStatus();
  const preferencesStatus = preferencesStore.useStatus();
  const clearables: StoreStatusNoticesProps['statuses'] = [
    { id: 'favorites', status: favoritesStatus },
    { id: 'customMeals', status: customMealsStatus },
    { id: 'preferences', status: preferencesStatus },
  ];

  const [pending, setPending] = useState<DestructiveId | null>(null);

  const preferences = preferencesState.preferences;
  const favorites = selectFavoriteIds(favoritesState).length;
  const customMeals = selectCustomMeals(customMealsState).length;

  const close = useCallback(() => {
    setPending(null);
  }, []);

  const confirm = useCallback(() => {
    switch (pending) {
      case 'favorites':
        dispatchFavorites(favoritesActions.clear());
        break;
      case 'customMeals':
        dispatchCustomMeals(customMealsActions.clear());
        break;
      case 'preferences':
        // `replace`, not a field-by-field walk: `preferences/replaced` sanitises on the way in and
        // moves `allergiesRevision` when the allergy set changes, which is what discards the
        // recommendations currently on screen (FR-003). Six dispatches would queue six writes and
        // leave that invalidation to chance.
        dispatchPreferences(preferencesActions.replace(DEFAULT_PREFERENCES));
        break;
      case 'all':
        /**
         * **Not awaited, and the sheet is deliberately NOT closed here.** `resetAll` unmounts this
         * screen before it clears a key: awaiting it and then calling `setPending(null)` would be a
         * write to a discarded instance, and closing the sheet "after" it resolved would be code
         * that never runs. The subtree returns as a fresh mount with `pending` at `null`, so the
         * sheet is gone because this component no longer exists — hence the `return`, not a `break`.
         */
        void resetAll();
        return;
      case null:
        // Unreachable — the sheet only renders when `pending` is set. Explicit rather than a
        // `default`, so a fifth `DestructiveId` is a compile error here.
        return;
    }
    close();
  }, [pending, close, dispatchFavorites, dispatchCustomMeals, dispatchPreferences, resetAll]);

  const confirmation = pending === null ? null : confirmationFor(pending, favorites, customMeals);

  return (
    <ScrollView
      testID="settings-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
    >
      <AppText variant="title" tone="primary" level={1}>
        Settings
      </AppText>

      {/* Fixed local copy naming the SETS that came back, never a driver string. A partial reset
          that says nothing is worse than one that names what survived. */}
      {resetError === null ? null : (
        <StatusMessage
          testID="settings-reset-error"
          tone="danger"
          icon="alertCircle"
          title="Some data is still on this device"
          description={resetError}
          announceOnMount
        />
      )}

      {/* **A confirmed clear whose write failed must say so, and a clear against an unreadable key
          destroyed nothing at all.** Both live in `StoreStatusNotices`, with the retry rule and the
          "never an exception's message" rule written out there. */}
      <StoreStatusNotices statuses={clearables} />

      <AppText variant="label" tone="secondary">
        Preferences
      </AppText>
      <AppText variant="caption" tone="tertiary">
        Diet, allergies, dislikes and the times you usually eat.
      </AppText>
      {/* **The P14 form, not a second copy of it** (Plan §5 P18). `returnTo: 'Settings'` is what
          turns its Save into a `goBack` instead of completing onboarding. */}
      <AccessibleButton
        testID="settings-edit-preferences"
        label="Edit preferences and meal times"
        variant="secondary"
        icon="chevronRight"
        onPress={() => {
          navigation.navigate('DietarySetup', { returnTo: 'Settings' });
        }}
      />
      <Divider />
      <AppText variant="label" tone="secondary">
        AI
      </AppText>
      <AppText variant="caption" tone="tertiary">
        With this off, meals are still suggested and explained by the app rather than the model, and
        the assistant is unavailable.
      </AppText>
      {/* `toggle`, so this is a `checkbox` with a real checked state rather than a button that
          merely looks active (S-13) — and the check glyph carries the state as well as the fill,
          because PRD §10.5 forbids colour as the only signal. */}
      <View style={{ flexDirection: 'row' }}>
        <Chip
          testID="settings-ai-toggle"
          label="Use AI"
          toggle
          selected={preferences.aiEnabled}
          onPress={() => {
            dispatchPreferences(preferencesActions.changeAiEnabled(!preferences.aiEnabled));
          }}
        />
      </View>
      <AppText variant="label" tone="secondary">
        Appearance
      </AppText>
      {/* **The selected mode is carried by the accessible NAME and by visible text, not by the
          tint.** `ChipRow` was used here first and cannot carry either: it passes no per-chip
          `accessibilityLabel`, and its chips are `button` + `selected`, which on the web surface
          conveys nothing at all — `aria-selected` is invalid on `button` and react-native-web 0.21
          maps no `accessibilityState`. So the fill was the only signal, which PRD §10.5 forbids and
          a colour-blind user cannot read. `ChipRow` is P14's file, so the fix is here: the group
          name and the state are folded into each chip's name, exactly as `FormField` folds its
          error into its name (S-33) for the same React Native gap (X-23), and the selection is
          also stated in words below.

          `ThemeProvider` takes `mode` as a PROP (TSD §6.6: "there is one source of truth"), so what
          makes this change the scheme immediately is the root passing the stored value in — see
          this task's `## NEEDS-INTEGRATION`. */}
      <View
        testID="field-theme"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.card.gap }}
      >
        {THEME_MODES.map((mode) => (
          <Chip
            key={mode}
            testID={`chip-theme-${mode}`}
            label={THEME_LABELS[mode]}
            selected={mode === preferences.themeMode}
            accessibilityLabel={
              mode === preferences.themeMode
                ? `Theme: ${THEME_LABELS[mode]}, selected`
                : `Theme: ${THEME_LABELS[mode]}`
            }
            onPress={() => {
              dispatchPreferences(preferencesActions.changeThemeMode(mode));
            }}
          />
        ))}
      </View>
      <AppText variant="caption" tone="tertiary" testID="settings-theme-selected">
        {`Theme: ${THEME_LABELS[preferences.themeMode]}. System follows your device.`}
      </AppText>

      <Divider />
      <AppText variant="label" tone="secondary">
        Your data
      </AppText>
      {/* From the `ui` store, and stated rather than offered as a control: acknowledging the safety
          disclaimer is one-way, which is why `uiState.ts` publishes no action to undo it. Only the
          full reset below clears it, and only from behind its own confirmation. */}
      <AppText variant="caption" tone="tertiary" testID="settings-disclaimer">
        {selectDisclaimerAcknowledged(uiState)
          ? 'You have seen the notice about allergen data being neither complete nor verified.'
          : 'You have not yet seen the notice about allergen data being neither complete nor verified.'}
      </AppText>

      <AccessibleButton
        testID="settings-clear-favorites"
        label={`Clear favourites (${String(favorites)})`}
        variant="secondary"
        onPress={() => {
          setPending('favorites');
        }}
        accessibilityHint="Asks you to confirm first."
      />
      <AccessibleButton
        testID="settings-clear-customMeals"
        label={`Delete my own meals (${String(customMeals)})`}
        variant="secondary"
        onPress={() => {
          setPending('customMeals');
        }}
        accessibilityHint="Asks you to confirm first."
      />
      <AccessibleButton
        testID="settings-clear-preferences"
        label="Reset preferences to defaults"
        variant="secondary"
        onPress={() => {
          setPending('preferences');
        }}
        accessibilityHint="Asks you to confirm first."
      />
      <AccessibleButton
        testID="settings-reset-all"
        label="Erase all data on this device"
        variant="destructive"
        onPress={() => {
          setPending('all');
        }}
        accessibilityHint="Asks you to confirm first. This also takes you back through setup."
      />

      <Divider />
      <AppText variant="label" tone="secondary">
        Data sources
      </AppText>
      {/* **PRD §15's required wording, and a licence obligation rather than copy** — it must not be
          reworded, shortened or split, and the URL is part of the required string. The reasoning,
          and why it is text rather than a link, is on `REQUIRED_ATTRIBUTION` in `settingsCopy.ts`. */}
      <AppText variant="caption" tone="tertiary" testID="settings-attribution">
        {REQUIRED_ATTRIBUTION}
      </AppText>

      {/* One sheet, rendered only while an action is pending, so its copy can never be a previous
          action's. `Sheet`'s close button and backdrop are two more ways to cancel; the explicit
          Keep button is the first, because a destructive dialog whose only non-destructive exit is
          an unlabelled X is a dialog that gets confirmed by accident. */}
      {confirmation === null ? null : (
        <Sheet testID="settings-confirm-sheet" visible onClose={close} title={confirmation.title}>
          <View style={{ gap: components.card.gap }}>
            <AppText variant="body" tone="secondary">
              {confirmation.body}
            </AppText>
            <AccessibleButton
              testID="settings-confirm"
              label={confirmation.confirmLabel}
              variant="destructive"
              onPress={confirm}
            />
            <AccessibleButton
              testID="settings-cancel"
              label="Keep my data"
              variant="secondary"
              onPress={close}
            />
          </View>
        </Sheet>
      )}
    </ScrollView>
  );
}
