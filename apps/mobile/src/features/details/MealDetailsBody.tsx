/**
 * FR-011's nine fields, and the allergen notice that is the reason this screen is a safety
 * surface.
 *
 * **Split from `MealDetailsScreen.tsx` at SQG-09's cap, with the orchestrator's authorisation,
 * and the seam is real rather than mechanical.** The screen owns the params, the request, the
 * two stores and the five states; this module owns what a loaded meal looks like. It takes one
 * `Meal` and nothing else from its caller, which is what makes every field and every allergen
 * combination reachable from a test without a client, a route or a navigator. The measurement
 * that forced the split is worth recording: the screen's comment-free code alone was 332 lines,
 * so 350 *with* the docstrings this codebase requires was unreachable.
 *
 * **The allergen match is the domain's, never this module's.** `conflictingAllergens` is called,
 * not re-implemented. TSD §4.4 owns the lexicon, the suppressors and the inference from
 * ingredient names, and Plan §2 forbids a screen recomputing a rule the domain already
 * makes: two matchers would disagree about `peanut oil` (inferred, never tagged) and `water
 * chestnut` (matched by a naive scan, suppressed by the lexicon) while each passed its own
 * tests. Probed, and the number is the argument: with the call replaced by
 * `meal.allergenTags.filter(...)`, 24 of the suite's 25 tests stay green — only the fixture
 * whose declared tags are stripped can tell a domain call from a tag intersection.
 *
 * **`allergenTags` are rendered too, and they are a different statement.** FR-011 lists the
 * tags; the conflict notice is about *this user*. So the tags are a labelled row and the conflict
 * is a `StatusMessage` in the danger tone with an icon and a title — stronger in shape and in
 * words, never in colour alone (PRD §10.5).
 *
 * **The notice sits second**, under the name — which a sentence about "this meal" needs above
 * it — and above everything else. A warning below four paragraphs of method has not warned
 * anybody.
 *
 * It reads `preferences` itself rather than taking the allergy list as a prop, so there is no
 * path on which a caller forgets to pass it and the notice silently never renders.
 *
 * **And it reads that store's `entryStatus` as well as its value**, because an erased allergy list
 * produces exactly the same silence as a meal that conflicts with nothing. Surfacing the
 * difference is the fix for the one way this screen's safety control could fail without saying so;
 * see `allergiesUnknown` below.
 */

import type { ReactNode } from 'react';
import { Image, View } from 'react-native';
import type { Meal } from '@nutritime/contracts';
import { conflictingAllergens, formatMoney } from '@nutritime/domain';
import { AppText, StatusMessage } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import { preferencesStore, selectPreferences } from '../../state/preferences/index.js';
import { NutritionPanel } from './NutritionPanel.js';
import { SourceAttribution } from './SourceAttribution.js';

/** Fixed local copy, every sentence. Nothing here is built from a wire or a driver string. */
const COPY = {
  noImage: 'No photograph is recorded for this meal.',
  tagsHeading: 'Tags',
  allergenHeading: 'Allergens',
  noAllergens:
    'No allergens are recorded for this meal. That is not a guarantee — check the label before eating it.',
  ingredientsHeading: 'Ingredients',
  instructionsHeading: 'Method',
  conflictStillAvailable:
    'Your suggestions and the assistant already leave this meal out. The catalog lists every meal, which is how you reached it.',
  allergiesResetTitle: 'This screen cannot check your allergies',
  allergiesResetDescription:
    'Your saved preferences could not be read, so your allergy list was reset and is now empty. Set it again in Settings — until you do, there is nothing here to check this meal against.',
  allergiesUnreadableTitle: 'Your allergy list could not be read',
  allergiesUnreadableDescription:
    'It could not be loaded on this launch, so there is nothing here to check this meal against. Nothing saved has been overwritten, and reopening the app may read it.',
  allergiesUnknownStillAvailable:
    "The ingredients and the allergen tags below are the meal's own and are unaffected. Read them yourself before eating it.",
} as const;

/**
 * "peanut", "peanut and milk", "peanut, milk and egg".
 *
 * Canonical allergens are kebab-cased (`tree-nut`), so the hyphen becomes a space: a notice read
 * aloud as "tree hyphen nut" is a notice the user has to decode. The domain's output is sorted
 * already, so the order is stable and testable.
 */
function namedList(values: readonly string[]): string {
  const words = values.map((value) => value.split('-').join(' '));
  if (words.length <= 1) {
    return words[0] ?? '';
  }
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

export interface MealDetailsBodyProps {
  readonly meal: Meal;
}

export function MealDetailsBody({ meal }: MealDetailsBodyProps): ReactNode {
  const { components } = useTheme();
  const card = components.card;
  const allergies = selectPreferences(preferencesStore.useValue()).allergies;
  const conflicts = conflictingAllergens(meal, allergies);

  /**
   * **The allergy list's READ STATUS is part of the safety answer, and leaving it out made the one
   * control on this screen fail silently.**
   *
   * `recovered` means the stored profile was quarantined and reset, and
   * `DEFAULT_PREFERENCES.allergies` is `[]`; `unavailable` means the read failed and the same
   * fallback is in use. Either way `conflictingAllergens` is handed an empty list and returns
   * nothing — so the absence of a notice below means **"nothing is known"**, not "nothing
   * conflicts", and this is the screen where a conflicting meal is reachable by design.
   * `HomeScreen` and `DietarySetupScreen` both carry this check, and Home's reasoning applies here
   * with more force: Home shows meals an allergy filter chose, and this screen shows a meal the
   * user chose from a list that filters nothing.
   *
   * **Gated on the list actually being empty**, which is what makes it a statement rather than a
   * banner. A user with genuinely no allergies and a clean read must not see it — that is the state
   * the screen previously could not distinguish — and a user who re-declares an allergy in this
   * session gets a working notice and no longer needs the warning.
   */
  const readStatus = preferencesStore.useStatus().entryStatus;
  const allergiesUnknown =
    (readStatus === 'recovered' || readStatus === 'unavailable') && allergies.length === 0;

  return (
    <View testID="meal-details-body" style={{ gap: card.gap }}>
      <AppText variant="title" level={1} testID="meal-details-name">
        {meal.name}
      </AppText>

      {/* Above the conflict notice, because it qualifies how much that notice can be trusted. */}
      {allergiesUnknown ? (
        <StatusMessage
          testID="meal-details-allergies-unknown"
          tone="warning"
          icon="alertCircle"
          title={
            readStatus === 'recovered' ? COPY.allergiesResetTitle : COPY.allergiesUnreadableTitle
          }
          description={
            readStatus === 'recovered'
              ? COPY.allergiesResetDescription
              : COPY.allergiesUnreadableDescription
          }
          stillAvailable={COPY.allergiesUnknownStillAvailable}
          announceOnMount
        />
      ) : null}

      {conflicts.length > 0 ? (
        <StatusMessage
          testID="meal-details-allergen-conflict"
          tone="danger"
          icon="warning"
          // Names them: "contains allergens" would tell the user nothing they could act on, and
          // this is the only screen that can tell them at all.
          title={`Contains ${namedList(conflicts)}`}
          description={`You declared ${namedList(conflicts)} as an allergy, and this meal is either tagged with it or names it among its ingredients. Do not rely on this screen alone — check the label.`}
          stillAvailable={COPY.conflictStillAvailable}
          // Announced when it appears, because it appears after the screen does — the meal is
          // fetched — and a safety notice nobody is told about is a notice nobody reads.
          announceOnMount
        />
      ) : null}

      {meal.imageUrl === null ? (
        <AppText variant="caption" tone="secondary" testID="meal-details-image-missing">
          {COPY.noImage}
        </AppText>
      ) : (
        <Image
          testID="meal-details-image"
          source={{ uri: meal.imageUrl }}
          // Floored with `card.skeleton` like `MealCard`'s box: TSD §7.2 says a broken image
          // changes no decision the app makes, and this is what that costs to be true.
          style={{
            alignSelf: 'stretch',
            aspectRatio: 1,
            borderRadius: card.radius,
            backgroundColor: card.skeleton,
          }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`Photograph of ${meal.name}`}
        />
      )}

      <AppText variant="body" tone="secondary" testID="meal-details-description">
        {meal.description}
      </AppText>

      <View
        testID="meal-details-facts"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: card.gap }}
      >
        {/* `formatMoney` is the domain's, so this screen and Explore cannot disagree about $8.50. */}
        <AppText variant="subheading" numeric testID="meal-details-price">
          {formatMoney(meal.price)}
        </AppText>
        <AppText variant="subheading" numeric testID="meal-details-prep-time">
          {`${String(meal.preparationMinutes)} minutes`}
        </AppText>
      </View>

      <Section testID="meal-details-tags" heading={COPY.tagsHeading} items={meal.dietTags} inline />

      {meal.allergenTags.length > 0 ? (
        <Section
          testID="meal-details-allergen-tags"
          heading={COPY.allergenHeading}
          items={meal.allergenTags}
          inline
        />
      ) : (
        <AppText variant="caption" tone="secondary" testID="meal-details-no-allergen-tags">
          {COPY.noAllergens}
        </AppText>
      )}

      <Section
        testID="meal-details-ingredients"
        heading={COPY.ingredientsHeading}
        items={meal.ingredients.map((item) => `${item.name} — ${item.measure}`)}
      />

      <Section
        testID="meal-details-instructions"
        heading={COPY.instructionsHeading}
        items={meal.instructions.map((step, index) => `${String(index + 1)}. ${step}`)}
      />

      <NutritionPanel
        testID="meal-details-nutrition"
        nutrition={meal.nutrition}
        provenance={meal.nutritionProvenance}
      />

      <SourceAttribution testID="meal-details-sources" provenance={meal.provenance} />
    </View>
  );
}

interface SectionProps {
  readonly heading: string;
  readonly items: readonly string[];
  /** A wrapped row rather than a column — for a short set of tags, not for prose. */
  readonly inline?: boolean;
  readonly testID: string;
}

/**
 * A heading and its lines. One component for tags, ingredients and method, because the three
 * differ only in direction and a second shape for the same job is the duplication Plan §12.3 calls
 * a gate failure.
 *
 * **Not `Chip` for the tags, deliberately.** A chip renders a `Pressable` with
 * `accessibilityRole="button"`, and a tag announcing itself as a button and then doing nothing is
 * worse than plain text. **And not a hand-rolled badge either:** `badge.neutralText` on
 * `badge.neutralBackground` is the only verified pairing for that surface and reaching it needs a
 * bare `Text`, which BRIEF §5 forbids in a screen. A shared `Badge` is proposed in the report.
 *
 * One accessible label on the group, so the set reads as a sentence rather than orphaned words;
 * an indexed testID per line, because an ingredient name is not unique — two rows may carry the
 * same name with different measures — so position is the only honest key.
 */
function Section({ heading, items, inline = false, testID }: SectionProps): ReactNode {
  const { components } = useTheme();

  return (
    <View testID={testID} style={{ gap: components.badge.gap }}>
      <AppText variant="subheading" level={2}>
        {heading}
      </AppText>
      <View
        accessible
        accessibilityLabel={`${heading}: ${namedList(items)}`}
        style={{
          flexDirection: inline ? 'row' : 'column',
          flexWrap: 'wrap',
          gap: inline ? components.card.gap : components.badge.gap,
        }}
      >
        {items.map((item, index) => (
          <AppText
            key={index}
            variant={inline ? 'bodyStrong' : 'body'}
            testID={`${testID}-${String(index)}`}
          >
            {item}
          </AppText>
        ))}
      </View>
    </View>
  );
}
