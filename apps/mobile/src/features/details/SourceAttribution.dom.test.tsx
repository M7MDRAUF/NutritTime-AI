import { describe, expect, it } from 'vitest';
import { getByRole, queryAllByRole } from '@testing-library/dom';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal, Provenance } from '@nutritime/contracts';
import { asRendered, render } from '../../shared/components/testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../../shared/theme/index.js';
import { SourceAttribution } from './SourceAttribution.js';

/**
 * The attribution the upstream licence obliges (PRD FR-011, TSD 7.2 step 3).
 *
 * Two claims carry this suite, and each is a different kind of honesty:
 *
 *  - **A `null` field is omitted.** An invented attribution is worse than none, so "Image source:
 *    unknown" must not appear. Probed against the real catalog: 60 of 60 records carry a
 *    `themealdbId`, 41 carry a `sourceUrl`, **0** carry an `imageSource` and **0** have
 *    `licenceConfirmed`. The omitted image line is therefore the normal case, not a corner.
 *  - **A record with nothing to attribute renders nothing**, not a heading over empty space. The
 *    catalog has no such record today; the shape exists (a custom meal composes `provenance`
 *    all-null per CONTRACTS 7) so the case is built here.
 *
 * `element` from the shared harness is deliberately NOT used for the empty case: it throws when a
 * testID is absent, which is the right behaviour for a missing node and the wrong assertion for a
 * component that correctly rendered nothing. That case queries the container directly.
 */

const CATALOG = (seededCatalog as unknown[]).map((record) => mealSchema.parse(record));
const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

function mealWhere(predicate: (meal: Meal) => boolean): Meal {
  const found = CATALOG.find(predicate);
  if (found === undefined) {
    throw new Error('no catalog record matches');
  }
  return found;
}

/** A record with both a TheMealDB id and a published recipe URL - 41 of the 60 look like this. */
const WITH_SOURCE = mealWhere((meal) => meal.provenance.sourceUrl !== null);
/** And one of the 19 whose upstream record names no publisher. */
const WITHOUT_SOURCE = mealWhere(
  (meal) => meal.provenance.sourceUrl === null && meal.provenance.themealdbId !== null,
);

const NOTHING_TO_ATTRIBUTE: Provenance = {
  themealdbId: null,
  sourceUrl: null,
  imageSource: null,
  licenceConfirmed: false,
};

function container(provenance: Provenance): HTMLElement {
  return render(<SourceAttribution testID="sa" provenance={provenance} />);
}

function text(provenance: Provenance): string {
  return container(provenance).textContent ?? '';
}

function node(provenance: Provenance, part: string): Element | null {
  return container(provenance).querySelector(`[data-testid="sa-${part}"]`);
}

describe('SourceAttribution', () => {
  it('renders the recipe record and the publisher a real catalog record names', () => {
    const { provenance } = WITH_SOURCE;
    const rendered = text(provenance);

    expect(provenance.themealdbId).not.toBeNull();
    expect(rendered).toContain(provenance.themealdbId ?? 'unreachable');
    expect(rendered).toContain('TheMealDB');
    expect(rendered).toContain(provenance.sourceUrl ?? 'unreachable');
  });

  it('never invents a credit for a field the record does not carry', () => {
    // "Image source: unknown" is not the absence of an attribution - it is one this project made
    // up. No catalog record carries an `imageSource`, so whatever this branch renders is what
    // every user sees, and it must not be a credit: nobody is "credited to" anything here.
    const { provenance } = WITH_SOURCE;

    expect(provenance.imageSource).toBeNull();
    expect(text(provenance)).not.toContain('credited to');
    expect(text(provenance)).not.toContain('unknown');
    expect(text(provenance)).not.toContain('Unknown');
    expect(text(provenance)).not.toContain('null');
  });

  it('attributes the photograph to TheMealDB when no separate credit is recorded', () => {
    // FR-011 says the screen displays attribution for the recipe AND image. Probed: `imageSource`
    // is absent in all 60 records while all 60 carry a photograph hosted at www.themealdb.com and
    // the record id it arrived with - so an omitted line meant sixty photographs attributed to
    // nobody. `strImageSource` is upstream's field for a SEPARATE credit; its absence means none
    // is recorded, not that the image has no source. Both halves of that are asserted here,
    // because a sentence naming TheMealDB without saying no separate credit exists would overstate
    // what the record says.
    const { provenance } = WITH_SOURCE;
    const line = node(provenance, 'image');

    expect(provenance.imageSource).toBeNull();
    expect(provenance.themealdbId).not.toBeNull();
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain('Image from TheMealDB');
    expect(line?.textContent).toContain('no separate credit');
  });

  it('renders no image line when there is neither a credit nor a record id', () => {
    // The third case: with no id, nothing about the photograph is known, and naming TheMealDB
    // would then be the invention the rest of this file exists to prevent. The card still renders,
    // because the publisher is still something to attribute - so this is a real branch and not the
    // all-null early return in disguise.
    const provenance: Provenance = {
      themealdbId: null,
      sourceUrl: 'https://example.invalid/recipe',
      imageSource: null,
      licenceConfirmed: false,
    };

    expect(node(provenance, 'image')).toBeNull();
    expect(node(provenance, 'source')).not.toBeNull();
    expect(text(provenance)).not.toContain('TheMealDB');
  });

  it('omits the publisher line for the records that name no publisher', () => {
    const { provenance } = WITHOUT_SOURCE;

    expect(provenance.sourceUrl).toBeNull();
    expect(node(provenance, 'source')).toBeNull();
    // And still renders, because there is still something to attribute.
    expect(node(provenance, 'recipe')).not.toBeNull();
    expect(text(provenance)).not.toContain('Published at');
  });

  it('prefers a specific image credit over the TheMealDB fallback', () => {
    // Built rather than found: `imageSource` is null in all 60 records, so the only way to know
    // the line works at all is to hand it one. `strImageSource` is a free-text credit upstream,
    // not necessarily a URL, so it is rendered verbatim - and the fallback must give way to it
    // entirely, because a photographer's credit is the specific truth and "no separate credit is
    // recorded" would then be false.
    const provenance: Provenance = {
      ...WITH_SOURCE.provenance,
      imageSource: 'Photograph by A. Cook, CC BY-SA 3.0',
    };

    expect(text(provenance)).toContain('Image credited to Photograph by A. Cook, CC BY-SA 3.0');
    expect(text(provenance)).not.toContain('no separate credit');
    expect(node(provenance, 'image')).not.toBeNull();
  });

  it('renders nothing at all when there is nothing to attribute', () => {
    // Not an empty heading. A "Sources" card with no sources under it reads as an attribution
    // that failed to load, which is a bug report the user cannot distinguish from a bug.
    const rendered = container(NOTHING_TO_ATTRIBUTE);

    expect(rendered.querySelector('[data-testid="sa"]')).toBeNull();
    expect(rendered.textContent).toBe('');
    expect(queryAllByRole(rendered, 'heading')).toHaveLength(0);
  });

  it('renders no licence line either when there is nothing to attribute', () => {
    // The boolean is a qualifier on an attribution: with nothing to qualify there is nothing to
    // say, and a lone "The source did not confirm a licence" would be a sentence about a record
    // the screen never showed. Asserted for BOTH values of the boolean, because "renders nothing"
    // must not depend on it.
    expect(container(NOTHING_TO_ATTRIBUTE).textContent).toBe('');
    expect(container({ ...NOTHING_TO_ATTRIBUTE, licenceConfirmed: true }).textContent).toBe('');
  });

  it('states the licence in words, in both directions', () => {
    // `licenceConfirmed` is a boolean, so `false` means "the source did not confirm" and not "we
    // do not know" - which is why it is not treated like the three nullable fields. Rendering it
    // only when true would make its absence ambiguous, and false is the value every catalog
    // record carries today, so the silent branch would be the only one anyone ever saw.
    const unconfirmed = WITH_SOURCE.provenance;
    const confirmed: Provenance = { ...unconfirmed, licenceConfirmed: true };

    expect(unconfirmed.licenceConfirmed).toBe(false);
    expect(text(unconfirmed)).toContain('did not confirm a licence');
    expect(text(confirmed)).toContain('confirmed the licence');
    expect(text(confirmed)).not.toContain('did not confirm');
    expect(node(unconfirmed, 'licence')).not.toBeNull();
    expect(node(confirmed, 'licence')).not.toBeNull();
  });

  it('renders the URL as readable text and not as a link this app cannot open', () => {
    // Nothing in `apps/mobile` opens a browser. A control that looked like a link and did nothing
    // when pressed would be worse than the address itself, which is what an attribution has to be
    // legible as anyway.
    const rendered = container(WITH_SOURCE.provenance);
    const line = rendered.querySelector('[data-testid="sa-source"]');

    expect(line).not.toBeNull();
    expect(rendered.querySelectorAll('a')).toHaveLength(0);
    expect(queryAllByRole(rendered, 'link')).toHaveLength(0);
    expect(queryAllByRole(rendered, 'button')).toHaveLength(0);
  });

  it('gives the card a heading a screen reader can navigate to', () => {
    expect(
      getByRole(container(WITH_SOURCE.provenance), 'heading', { name: 'Sources' }),
    ).toBeTruthy();
  });

  it('takes its surface from the card group in both schemes', () => {
    const inLight = container(WITH_SOURCE.provenance).querySelector('[data-testid="sa"]');
    const inDark = render(
      <SourceAttribution testID="sa" provenance={WITH_SOURCE.provenance} />,
      'dark',
    ).querySelector('[data-testid="sa"]');

    if (!(inLight instanceof HTMLElement) || !(inDark instanceof HTMLElement)) {
      throw new Error('no card rendered');
    }

    expect(inLight.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.card.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('scales its type with the OS setting exactly once', () => {
    // Every string goes through `AppText`. A bare `Text` with a literal size would not move.
    const single = container(WITH_SOURCE.provenance).querySelector('[data-testid="sa-recipe"]');
    const doubled = render(
      <SourceAttribution testID="sa" provenance={WITH_SOURCE.provenance} />,
      'light',
      2,
    ).querySelector('[data-testid="sa-recipe"]');

    if (!(single instanceof HTMLElement) || !(doubled instanceof HTMLElement)) {
      throw new Error('no recipe line rendered');
    }
    const base = Number.parseFloat(single.style.fontSize);

    expect(base).toBeGreaterThan(0);
    expect(Number.parseFloat(doubled.style.fontSize)).toBe(base * 2);
  });

  it('renders every real catalog record without a gap, an "unknown" or a "null"', () => {
    // All 60, because the claim is about the corpus this screen will actually be handed and
    // because 19 of them exercise the omitted-publisher branch. A record that rendered an empty
    // line would pass every single-record assertion above.
    expect(CATALOG).toHaveLength(60);

    for (const meal of CATALOG) {
      const rendered = container(meal.provenance);
      const card = rendered.querySelector('[data-testid="sa"]');
      if (!(card instanceof HTMLElement)) {
        throw new Error(`no attribution rendered for ${meal.id}`);
      }

      for (const line of card.children) {
        expect((line.textContent ?? '').trim()).not.toBe('');
      }
      expect(card.textContent).not.toContain('null');
      expect(card.textContent).not.toContain('undefined');
      expect(card.textContent?.toLowerCase()).not.toContain('unknown');

      // And every one of the 60 attributes its photograph. This is the assertion that would have
      // caught the original defect: each single-record test passed while the image clause of
      // FR-011 had no surface for any real meal, because no fixture in the suite carried an
      // `imageSource` and none could.
      expect(rendered.querySelector('[data-testid="sa-image"]')).not.toBeNull();
    }
  });
});
