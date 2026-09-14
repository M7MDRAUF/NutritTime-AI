/**
 * Who the recipe and the photograph belong to (T-16-03, PRD FR-011, TSD 7.2 step 3).
 *
 * **This is an obligation, not a nicety.** TSD 7.2 step 3 captures `idMeal`, `strSource`,
 * `strImageSource` and `strCreativeCommonsConfirmed` from the upstream record and says in as many
 * words: "The licence requires these to be preserved where present." Preserving them in
 * `meals.json` and never putting them on screen would satisfy the letter of the storage and none
 * of the licence, so FR-011 requires the detail screen to display them and this component is that
 * display.
 *
 * **A `null` field is never rendered as "unknown".** The nullable fields are facts the upstream
 * record either carries or does not, and "Image source: unknown" is not the absence of an
 * attribution - it is an attribution this project invented. So a field with nothing behind it is
 * omitted: 19 of the 60 records carry no `sourceUrl`, and for those the publisher line is simply
 * not there. A record with nothing to attribute at all renders **nothing** - not a heading over
 * emptiness, which would read as an attribution that failed to load.
 *
 * **Omission was the wrong answer for the image, and that distinction is the whole point of
 * `imageAttribution` below.** No record carries an `imageSource` while all 60 carry both a
 * photograph and the TheMealDB record it arrived with, so omitting the line meant sixty
 * photographs attributed to nobody - FR-011's image clause with no surface at all, which is a
 * different thing from a field honestly left out. The fallback states only what the record itself
 * states. Read that function before changing this one.
 *
 * **`licenceConfirmed` is different from the other three, and this is the decision behind it.**
 * It is a boolean, so it is never absent: `false` means the source did not confirm a licence, not
 * that nobody looked. Rendering it only when `true` would make its absence ambiguous between "the
 * source said no" and "this component does not show it" - and `false` is the value all 60 catalog
 * records currently carry, so the silent branch would be the only branch a user ever saw. It
 * therefore renders in both directions, in words rather than a tint (PRD 10.5), and it renders as
 * a line *about* an attribution: with nothing to attribute there is nothing to qualify, so it
 * follows the whole component into rendering nothing.
 *
 * **A URL is text here, not a link.** This app opens no browser - nothing in `apps/mobile` links
 * out, and a `Pressable` that appeared to be a link and did nothing would be worse than plain
 * text. So the address is rendered as something a user can read and type, which is what an
 * attribution has to be anyway.
 *
 * Props only - no fetch, no store, no navigation (CONTRACTS 5).
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { Provenance } from '@nutritime/contracts';
import { AppText } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';

const HEADING = 'Sources';

/**
 * Fixed local copy. Nothing here is built from an upstream string except the three values
 * themselves, which are the attribution and are rendered verbatim because that is the point.
 *
 * `TheMealDB` is named rather than "the recipe database": TSD 7.2 names it as the source of every
 * record and an attribution that does not say who to is not an attribution.
 */
const COPY = {
  recipePrefix: 'Recipe from TheMealDB, record ',
  originalPrefix: 'Published at ',
  imagePrefix: 'Image credited to ',
  /**
   * The image attributed from what the record already states, for the case where upstream names no
   * separate credit. See `imageAttribution` below for why this is not an invented attribution.
   */
  imageFromThemealdb: 'Image from TheMealDB, which records no separate credit for it.',
  licenceConfirmed: 'The source confirmed the licence for this record.',
  licenceUnconfirmed: 'The source did not confirm a licence for this record.',
} as const;

/**
 * The image half of FR-011, which says the screen displays attribution for the recipe **and
 * image** - and which a null-only rule left unsatisfiable for every record in the catalog.
 *
 * ORCHESTRATOR DECISION, and the data behind it is worth stating because the branch is grounded in
 * it rather than assumed. Probed over `packages/catalog/meals.json`:
 *
 *  - `provenance.imageSource` is null in **60 of 60** records - that is, absent in every one. (This
 *    line read "null in 0 of 60" until a verifier re-derived the figure: the clarification after the
 *    dash was right and the number contradicted it, which is the kind of comment that teaches the
 *    next reader the opposite of the truth.)
 *  - `imageUrl` is non-null in **60 of 60**, and every one of those 60 URLs is hosted at
 *    `www.themealdb.com` (checked by parsing each URL's host, which is TSD 7.2's closing note that
 *    "Image URLs still point at TheMealDB");
 *  - `themealdbId` is non-null in **60 of 60**.
 *
 * So an app that rendered nothing here would display sixty photographs and attribute none of them.
 * `strImageSource` is upstream's field for a *separate* credit - a photographer, an originating
 * site - and its absence means TheMealDB records no such credit, **not** that the photograph has
 * no source. The source is the record, and the record says so itself.
 *
 * Two facts the record carries, therefore, and nothing else: the image came with a TheMealDB
 * record, and no separate credit is recorded for it. That is not "Image source: unknown", which
 * would be an attribution this project made up; it is the weaker true statement in place of the
 * stronger unavailable one. A specific credit still wins whenever there is one.
 *
 * `null` when there is neither a credit nor a record id: with no id, nothing here is known, and
 * naming TheMealDB would then be the invention.
 */
function imageAttribution(imageSource: string | null, themealdbId: string | null): string | null {
  if (imageSource !== null) {
    return `${COPY.imagePrefix}${imageSource}`;
  }
  return themealdbId === null ? null : COPY.imageFromThemealdb;
}

export interface SourceAttributionProps {
  readonly provenance: Provenance;
  readonly testID?: string;
}

export function SourceAttribution({ provenance, testID }: SourceAttributionProps): ReactNode {
  const { components } = useTheme();
  const card = components.card;
  const { themealdbId, sourceUrl, imageSource, licenceConfirmed } = provenance;
  const image = imageAttribution(imageSource, themealdbId);
  const suffix = (part: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${part}`;

  // The three nullable fields decide whether this component exists at all; the boolean does not.
  // Written as an explicit `=== null` conjunction rather than a filtered array so that adding a
  // fourth attributable field has to be named here, which is where forgetting it would be silent.
  if (themealdbId === null && sourceUrl === null && imageSource === null) {
    return null;
  }

  return (
    <View
      testID={testID}
      style={{
        // The same `card` group as `NutritionPanel`, so the two sections of FR-011's traceability
        // read as one pair rather than as two unrelated boxes.
        alignSelf: 'stretch',
        gap: components.badge.gap,
        padding: card.padding,
        borderRadius: card.radius,
        borderWidth: card.borderWidth,
        borderColor: card.borderColor,
        backgroundColor: card.background,
      }}
    >
      <AppText variant="subheading" level={2}>
        {HEADING}
      </AppText>

      {themealdbId === null ? null : (
        <AppText testID={suffix('recipe')} variant="caption" tone="secondary">
          {`${COPY.recipePrefix}${themealdbId}.`}
        </AppText>
      )}

      {sourceUrl === null ? null : (
        // `numeric` is off and that matters for a URL: tabular figures in an address make the
        // digits sit oddly in a proportional string the user may need to copy by hand.
        <AppText testID={suffix('source')} variant="caption" tone="secondary">
          {`${COPY.originalPrefix}${sourceUrl}`}
        </AppText>
      )}

      {image === null ? null : (
        <AppText testID={suffix('image')} variant="caption" tone="secondary">
          {image}
        </AppText>
      )}

      <AppText testID={suffix('licence')} variant="caption" tone="tertiary">
        {licenceConfirmed ? COPY.licenceConfirmed : COPY.licenceUnconfirmed}
      </AppText>
    </View>
  );
}
