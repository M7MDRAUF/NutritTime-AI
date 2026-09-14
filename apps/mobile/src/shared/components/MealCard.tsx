/**
 * One meal, as a card (TSD 6.7).
 *
 * Composed from the `card` group plus `badge`, which is what `component.ts` says this component
 * is built from.
 *
 * **The name sits ON the photograph, over `card.imageScrim`.** That scrim exists for this and
 * nothing else - `semantic.ts` calls it "over a remote meal photograph, behind text" - and its
 * alpha was computed against a pure-white image rather than chosen by eye, so it holds AA for
 * every darker one. The image box is filled with `card.skeleton` underneath, which is what makes
 * the worst case actually reachable: a photo that fails to load leaves a surface darker than
 * white behind the same scrim, so the name stays legible instead of becoming near-white text on
 * near-white nothing. TSD 7.2 says a broken image changes no decision the app makes; this is what
 * that costs to be true.
 *
 * **`unavailable` is content, not control state.** It comes from the catalog's own `available`
 * field (`contracts/core.ts`), and an unavailable meal is still worth opening - its ingredients,
 * its allergen notices and its nutrition are all unchanged. So the card stays pressable and
 * carries no `accessibilityState.disabled`: saying a working control is disabled would be the
 * lie. The state is carried by a visible badge AND by the accessible name, never by colour.
 */

import type { ReactNode } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Square, because that is the shape of the source.
 *
 * No token fixes an image box and no document fixes a ratio, so the honest choice is the one that
 * crops nothing: TheMealDB's `strMealThumb` images - the URLs TSD 7.2 keeps pointing at - are
 * square, and every `imageUrl` in `packages/catalog/meals.json` is one of them. A 16:9 or 4:3 box
 * would be a decision to cut the top and bottom off every photograph in the catalog. Recorded in
 * the phase report as a proposed `card.imageAspectRatio` token; it is the one figure in this
 * batch with no token behind it.
 */
const IMAGE_ASPECT_RATIO = 1;

/**
 * The domain's own wording for this exact state - `scoring.ts` emits "Not available now" as the
 * detail for a meal rejected as `unavailable`. Reused rather than reinvented, and the trailing
 * "now" is what keeps it distinct from `NutritionBadge`'s "Not available", which is a statement
 * about the data instead.
 */
const UNAVAILABLE_LABEL = 'Not available now';

/** Abbreviated on screen, spelled out for a screen reader, which would otherwise say "min". */
const MINUTES_SHORT = 'min';
const MINUTES_SPOKEN = 'minutes';

export interface MealCardProps {
  readonly name: string;
  readonly imageUrl: string;
  /** Already formatted by the caller: this component never renders a currency itself. */
  readonly priceLabel: string;
  readonly preparationMinutes: number;
  readonly tags?: readonly string[];
  /** One short sentence saying why this meal was recommended (FR-009). */
  readonly reason?: string;
  readonly unavailable?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}

/**
 * Everything the card shows, in one sentence, in reading order.
 *
 * A card is one control, so it has one name. Without this the platforms disagree: iOS and Android
 * group a pressable's children and read them run together, while the web export would announce
 * the button and leave the tags to be discovered separately. Pure, so the test can pin it down
 * through the rendered `aria-label`.
 */
function accessibleName(
  name: string,
  priceLabel: string,
  preparationMinutes: number,
  tags: readonly string[] | undefined,
  reason: string | undefined,
  unavailable: boolean,
): string {
  const parts: string[] = [name];
  if (unavailable) {
    parts.push(UNAVAILABLE_LABEL);
  }
  parts.push(priceLabel, `${String(preparationMinutes)} ${MINUTES_SPOKEN}`);
  if (tags !== undefined && tags.length > 0) {
    parts.push(tags.join(', '));
  }
  if (reason !== undefined) {
    parts.push(reason);
  }
  return parts.join('. ');
}

export function MealCard({
  name,
  imageUrl,
  priceLabel,
  preparationMinutes,
  tags,
  reason,
  unavailable = false,
  onPress,
  testID,
}: MealCardProps): ReactNode {
  const { components, colors, typography } = useTheme();
  const card = components.card;
  const badge = components.badge;
  const highlight = Platform.OS === 'android' ? undefined : colors.effect.highlight;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibleName(
        name,
        priceLabel,
        preparationMinutes,
        tags,
        reason,
        unavailable,
      )}
      android_ripple={{ color: colors.effect.ripple }}
      style={{
        alignSelf: 'stretch',
        gap: card.gap,
        padding: card.padding,
        borderRadius: card.radius,
        borderWidth: card.borderWidth,
        borderColor: card.borderColor,
        backgroundColor: card.background,
        // `card.shadowColor` is deliberately not set: react-native-web 0.21 deprecates every
        // `shadow*` style prop in favour of `boxShadow` and warns on stderr for each one, and on
        // native a shadow COLOUR with no offset, opacity or radius draws nothing at all. The
        // theme is flat by design - `effect.elevationSurface` is 0 in both schemes - so a card's
        // edge is its border, which `component.ts` says in as many words. Reported as a token
        // with no consumer rather than silently satisfied.
        elevation: card.elevation,
        // So the press overlay and the photograph both stop at the card's corners.
        overflow: 'hidden',
      }}
    >
      {({ pressed }) => (
        <>
          {pressed && highlight !== undefined ? (
            <View aria-hidden style={[StyleSheet.absoluteFill, { backgroundColor: highlight }]} />
          ) : null}

          <View
            style={{
              aspectRatio: IMAGE_ASPECT_RATIO,
              justifyContent: 'flex-end',
              borderRadius: card.radius,
              overflow: 'hidden',
              // The floor under the scrim. See the note at the top of this file.
              backgroundColor: card.skeleton,
            }}
          >
            {/*
              Decorative: the card's accessible name already carries everything the photograph
              illustrates, and TheMealDB publishes no alternative text to use instead.
            */}
            <Image
              source={{ uri: imageUrl }}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
              style={StyleSheet.absoluteFill}
            />
            <View style={{ backgroundColor: card.imageScrim, padding: card.gap }}>
              {/*
                Not `AppText`. `card.imageText` is a layer-3 decision - `content.onImage`, which is
                light in BOTH schemes because a photograph is not a surface this theme picks - and
                `AppText`'s `tone` would let a caller pick any content role over a photo.
              */}
              <Text
                allowFontScaling={false}
                style={{ ...typography.subheading, color: card.imageText }}
              >
                {name}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: card.gap }}>
            <Text
              allowFontScaling={false}
              style={{ ...typography.bodyStrong, color: colors.content.primary }}
            >
              {priceLabel}
            </Text>
            <Text
              allowFontScaling={false}
              style={{ ...typography.caption, color: colors.content.secondary }}
            >
              {`${String(preparationMinutes)} ${MINUTES_SHORT}`}
            </Text>
            {unavailable ? (
              <View
                style={{
                  minHeight: badge.minHeight,
                  justifyContent: 'center',
                  paddingHorizontal: badge.paddingHorizontal,
                  borderRadius: badge.radius,
                  backgroundColor: badge.statusWarningBackground,
                }}
              >
                {/* The words, not the tint, are what say this. PRD 10.5. */}
                <Text
                  allowFontScaling={false}
                  style={{ ...typography.label, color: badge.statusWarningText }}
                >
                  {UNAVAILABLE_LABEL}
                </Text>
              </View>
            ) : null}
          </View>

          {tags === undefined || tags.length === 0 ? null : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: badge.gap }}>
              {tags.map((tag) => (
                // Badges, not `Chip`s: a chip is a control built to a 48 target, and four of them
                // inside a card would be four times the height of the text they label. The card
                // is the control here; these are labels on it.
                <View
                  key={tag}
                  style={{
                    minHeight: badge.minHeight,
                    justifyContent: 'center',
                    paddingHorizontal: badge.paddingHorizontal,
                    borderRadius: badge.radius,
                    backgroundColor: badge.neutralBackground,
                  }}
                >
                  <Text
                    allowFontScaling={false}
                    style={{ ...typography.label, color: badge.neutralText }}
                  >
                    {tag}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {reason === undefined ? null : (
            <Text
              allowFontScaling={false}
              style={{ ...typography.body, color: colors.content.secondary }}
            >
              {reason}
            </Text>
          )}
        </>
      )}
    </Pressable>
  );
}
