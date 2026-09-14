/**
 * One row of Saved — a meal card, and the allergen conflict marker that belongs to it (T-17-02).
 *
 * **The marker is inside this component, not beside it, and that is the whole reason this file
 * exists as one unit.** It is the safety surface: a row component that *can* be rendered without its
 * marker is a row that will eventually be rendered without it, by someone adding a third list or
 * reusing the card a year from now. So there is no "card" component and no separate "marker"
 * component to forget — asking for a row gets you both, and the only way to render a meal in Saved
 * without its warning is to delete code inside this file, which the suite catches.
 *
 * Used by both sections, which it can be because a `CustomMeal` is a `Meal` minus `source` and
 * `catalogVersion`, neither of which a card renders.
 *
 * **A conflicting meal in Saved is marked, and Explore's rows deliberately are not.** Saved is a
 * list of things the user chose to keep: they have already decided, and the form already told them
 * that declaring an allergen keeps conflicting meals away from them. Explore is a browse list, and
 * marking a whole catalog someone is merely scanning teaches them to ignore the mark. Both of Saved's
 * sections mark, because a user can tick "peanut" on a recipe they wrote themselves just as easily as
 * they can favourite a catalog meal that carries it.
 *
 * **The conflict comes from the domain's `conflictingAllergens`, never from a local matcher.** The
 * domain reads ingredient names as well as declared tags, so a recipe tagged with nothing whose
 * ingredient list says "peanut butter" still conflicts. A hand-rolled `allergenTags.filter(...)`
 * agrees with it on every meal that happens to be tagged and disagrees on exactly the meal that
 * matters — which is why the suite's fixtures all conflict through an ingredient name with the tags
 * stripped.
 *
 * **Not memoised, and that is a deliberate reversal.** It was, for the reason Explore's row docstring
 * gives — but the marker needs `allergies`, which is a fresh array reference on every `preferences`
 * read, so the memo would have been defeated on every render while still reading as a guarantee. A
 * memo that cannot hold is worse than none: it tells the next reader the re-render was considered and
 * handled. The honest fixes are a `MealCard` prop for the warning or a content comparison, both filed
 * under NEEDS-INTEGRATION rather than faked here.
 */

import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { CustomMeal, Meal } from '@nutritime/contracts';
import { conflictingAllergens, formatMoney } from '@nutritime/domain';
import { AppText, Icon, MealCard } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';

/**
 * The conflict sentence. Names every matched allergen, because "contains an allergen" is not
 * actionable and the user may have declared several.
 */
function conflictSentence(allergens: readonly string[]): string {
  const list =
    allergens.length === 1
      ? allergens[0]
      : `${allergens.slice(0, -1).join(', ')} and ${allergens[allergens.length - 1] ?? ''}`;
  return `Contains ${list ?? ''}, which you have declared as an allergy. Check the label before eating this.`;
}

export interface SavedMealRowProps {
  /** `Meal | CustomMeal`, because `CustomMeal` is a `Meal` minus its two catalog fields. */
  readonly meal: Meal | CustomMeal;
  /** The user's **declared** allergies — see `SavedScreen.tsx` for why not the canonical set. */
  readonly allergies: readonly string[];
  readonly testID: string;
  readonly onOpen: (mealId: string) => void;
}

export function SavedMealRow({ meal, allergies, testID, onOpen }: SavedMealRowProps): ReactNode {
  const { components, colors, typography } = useTheme();
  const onPress = useCallback(() => {
    onOpen(meal.id);
  }, [meal.id, onOpen]);

  const conflicts = conflictingAllergens(meal, allergies);

  return (
    <View style={{ alignSelf: 'stretch', gap: components.card.gap }}>
      {/*
        **Above the card, not below it.** A screen reader reaches children in order, and a safety
        warning placed after the thing it warns about is one the user meets too late.
      */}
      {conflicts.length > 0 ? (
        <View
          testID={`saved-conflict-${meal.id}`}
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            alignSelf: 'stretch',
            gap: components.card.gap,
          }}
        >
          {/* Decorative: the sentence beside it names the allergen, which is what PRD §10.5
              requires — the colour and the glyph are both redundant with the words. */}
          <Icon name="danger" size={typography.body.lineHeight} color={colors.status.danger} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodyStrong" tone="secondary">
              {conflictSentence(conflicts)}
            </AppText>
          </View>
        </View>
      ) : null}
      <MealCard
        testID={testID}
        name={meal.name}
        imageUrl={meal.imageUrl}
        // The domain's formatter, so this screen and the details screen cannot disagree about how
        // $8.50 is written.
        priceLabel={formatMoney(meal.price)}
        preparationMinutes={meal.preparationMinutes}
        tags={meal.dietTags}
        unavailable={!meal.available}
        onPress={onPress}
      />
    </View>
  );
}
