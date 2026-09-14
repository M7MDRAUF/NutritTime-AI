/**
 * The custom half of Saved — the user's own recipes (T-17-02, T-17-07).
 *
 * Reads no store: the list, the bound and the storage status arrive as props. **No loading state and
 * no local-only state**, deliberately — it renders a store that is already hydrated before any screen
 * mounts, so there is no request to wait on and no server to be unreachable from. `SavedScreen.tsx`'s
 * docstring carries the full reasoning.
 *
 * Two states here are the ones a user can be hurt by, and both are silent without this file:
 *
 *  - **`entryStatus === 'unavailable'`** — the key could not be read, so `createStore` refuses to
 *    write over it (TSD §6.3) and reports nothing (`saveError` null, `saveBlocked` false). Left
 *    unsaid, the user is told the list is empty, writes a recipe, watches it appear, and loses it at
 *    the next launch. So the empty state is suppressed and the warning says a recipe added now will
 *    not be kept.
 *  - **`atBound`** — TSD §6.4 makes bounds refusals, and the `customMeals` reducer refuses the 201st
 *    by returning `state` identically, which is silent to the caller. So the create affordance is
 *    replaced by a message with no action at all.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { CustomMeal } from '@nutritime/contracts';
import {
  AccessibleButton,
  AppText,
  EmptyState,
  StatusMessage,
} from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { EntryStatus } from '../../infrastructure/storage/repository.js';
import { MAX_CUSTOM_MEALS } from '../../state/customMeals/index.js';
import { SavedMealRow } from './SavedMealRow.js';

export interface CustomSectionProps {
  readonly meals: readonly CustomMeal[];
  readonly atBound: boolean;
  readonly entryStatus: EntryStatus;
  readonly allergies: readonly string[];
  readonly onOpen: (mealId: string) => void;
  readonly onCreate: () => void;
}

export function CustomSection({
  meals,
  atBound,
  entryStatus,
  allergies,
  onOpen,
  onCreate,
}: CustomSectionProps): ReactNode {
  const { components } = useTheme();
  const unreadable = entryStatus === 'unavailable';

  return (
    <View testID="saved-custom" style={{ alignSelf: 'stretch', gap: components.card.gap }}>
      <AppText variant="subheading" level={2}>
        Your own recipes
      </AppText>

      {entryStatus === 'recovered' ? (
        <StatusMessage
          testID="saved-custom-recovered"
          tone="warning"
          icon="alertCircle"
          title="Your own recipes were reset"
          description="The saved list of recipes you wrote could not be read, so it is empty. Anything you had written down will have to be entered again."
          stillAvailable="Your favourite meals are stored separately and are unaffected."
        />
      ) : null}

      {/*
        **The state that made the app lie.** The key could not be read, so `createStore` refuses to
        write over it (TSD §6.3) — silently: `saveError` stays null, `saveBlocked` stays false.
        Without this the user reads "You have not written any recipes yet", writes one, watches it
        appear, and loses it at the next launch with nothing having said so. The create affordance
        stays (the failure may be transient, and a dead end is worse) but the warning has to reach
        them BEFORE they spend ten minutes typing.
      */}
      {unreadable ? (
        <StatusMessage
          testID="saved-custom-unavailable"
          tone="danger"
          icon="danger"
          title="Your recipes could not be read"
          description="This list is not empty — it could not be loaded, so nothing is shown. A recipe you add now will not be kept after you close the app. Reopen the app before writing anything you want to keep."
          stillAvailable="Your favourite meals, browsing and search are unaffected, and no recipe has been deleted."
        />
      ) : null}

      {/*
        **One create affordance, in one place** — either the button or the refusal, never both and
        never two buttons with the same label. TSD §6.4: at the bound the message says the list is
        full and offers NO retry, because retrying the same value can never succeed and a button
        that will always refuse is a lie in the interface.
      */}
      {atBound ? (
        <StatusMessage
          testID="saved-custom-full"
          tone="warning"
          icon="alertCircle"
          title="Your recipe list is full"
          description={`This device stores ${String(MAX_CUSTOM_MEALS)} of your own recipes, and you have that many. Delete one to make room for another.`}
          stillAvailable="Opening, editing and deleting the recipes you already have all still work."
        />
      ) : (
        <AccessibleButton
          testID="saved-new-meal"
          label="New meal"
          icon="plus"
          variant="primary"
          onPress={onCreate}
        />
      )}

      {/* Suppressed under `unavailable`, for the reason given in `FavoritesSection`. */}
      {meals.length === 0 ? (
        unreadable ? null : (
          <EmptyState
            testID="saved-custom-empty"
            title="You have not written any recipes yet"
            description="A meal you add here is yours: it stays on this device and is never sent anywhere."
          />
        )
      ) : (
        meals.map((meal, index) => (
          /**
           * **The id alone is not a sufficient key here.** `favorites` holds **ids**, so `['a','a']`
           * and `['a']` denote the same set and its `create` de-duplicates; `customMeals` holds
           * **records**, so two entries under one id are two meals the user authored and the store
           * keeps both deliberately — de-duplicating at hydration would delete one silently, which
           * is P14's defect class. The duplicate-key cost lands here instead, and it is the
           * renderer's to pay. Nothing is de-duplicated for display either: hiding a meal the user
           * wrote to keep React quiet is the same data loss, one layer up.
           *
           * Index first, because an id may contain a colon and `${id}:${index}` could then collide.
           */
          <SavedMealRow
            key={`${String(index)}:${meal.id}`}
            meal={meal}
            allergies={allergies}
            testID={`saved-recipe-${meal.id}`}
            onOpen={onOpen}
          />
        ))
      )}
    </View>
  );
}
