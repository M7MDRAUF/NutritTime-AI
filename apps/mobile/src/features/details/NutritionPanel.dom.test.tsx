import { describe, expect, it } from 'vitest';
import { getByRole } from '@testing-library/dom';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal, NutritionProvenance, NutritionSummary, ThemeMode } from '@nutritime/contracts';
import { asRendered, element, render } from '../../shared/components/testHarness.js';
import { NUTRITION_UNAVAILABLE } from '../../shared/components/index.js';
import { buildComponentTokens, darkColors, lightColors } from '../../shared/theme/index.js';
import { NutritionPanel, nutritionTraceLines } from './NutritionPanel.js';

/**
 * T-16-03's acceptance, from both ends: `null` renders "Not available" and never `0`, and every
 * figure on screen is traceable (PRD FR-006, FR-011).
 *
 * **Real catalog records where the claim is about the common case** - the 53-of-60 record whose
 * four macros are all `null` - because a suite of hand-written fixtures is exactly how P13 missed
 * `Meal.imageUrl`'s nullability: every fixture's author chose the interesting value. Records are
 * built, or spread one field off a real one, where the claim is about a combination the catalog
 * cannot produce. That is BRIEF 6.2's other half: build the data the claim needs.
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

/** A record whose nutrition was derived, so `dataset` and `servings` are both real. */
const DERIVED = mealWhere((meal) => meal.nutritionProvenance.origin === 'usda-derived');
/** One of the 53. Its `reason` names the ingredient that failed (TSD 7.4). */
const UNAVAILABLE = mealWhere((meal) => meal.nutritionProvenance.origin === 'unavailable');

const ALL_NULL: NutritionSummary = {
  calories: null,
  proteinGrams: null,
  carbsGrams: null,
  fatGrams: null,
};

/** Every figure a genuine, measured zero. A meal can legitimately have no fat. */
const ALL_ZERO: NutritionSummary = {
  calories: 0,
  proteinGrams: 0,
  carbsGrams: 0,
  fatGrams: 0,
};

const USER_PROVENANCE: NutritionProvenance = {
  origin: 'user',
  dataset: null,
  servings: 4,
  reason: null,
};

const ROW_IDS = ['calories', 'protein', 'carbs', 'fat'] as const;

/** The whole tree, with both theme inputs pinned the way the shared harness takes them. */
function tree(
  nutrition: NutritionSummary,
  provenance: NutritionProvenance,
  mode: ThemeMode = 'light',
  fontScale = 1,
): HTMLElement {
  return render(
    <NutritionPanel testID="np" nutrition={nutrition} provenance={provenance} />,
    mode,
    fontScale,
  );
}

/** And just the panel, which is what most assertions here read. */
function panel(nutrition: NutritionSummary, provenance: NutritionProvenance): HTMLElement {
  return element(tree(nutrition, provenance), 'np');
}

/** The first sentence of the trail. */
function traceLine(rendered: HTMLElement): HTMLElement {
  const line = element(rendered, 'np-trace').children.item(0);
  if (!(line instanceof HTMLElement)) {
    throw new Error('no trace line rendered');
  }
  return line;
}

describe('NutritionPanel', () => {
  it('renders all four rows even when every one of them is unknown', () => {
    // The 53-of-60 case. Hidden rows would make the commonest record look like a section that
    // failed to load, and the seven derived ones feel like a different screen.
    // The record's OWN nutrition, asserted identical to the fixture the other tests use.
    const rendered = panel(UNAVAILABLE.nutrition, UNAVAILABLE.nutritionProvenance);

    expect(UNAVAILABLE.nutrition).toStrictEqual(ALL_NULL);
    for (const id of ROW_IDS) {
      expect(element(rendered, `np-${id}`).textContent).toContain(NUTRITION_UNAVAILABLE);
    }
    expect(element(rendered, 'np-calories').textContent).toContain('Calories');
    expect(element(rendered, 'np-protein').textContent).toContain('Protein');
    expect(element(rendered, 'np-carbs').textContent).toContain('Carbs');
    expect(element(rendered, 'np-fat').textContent).toContain('Fat');
  });

  it('never renders a zero where the value is unknown, and never "Not available" where it is 0', () => {
    // **The assertion T-16-03 exists for.** `0` is a real figure - a meal can have zero grams of
    // fat - and `null` is TSD 7.4's refusal. Two panels rendering the same text would be a lie
    // about the data. The inequality is asserted too, so conflating them fails even if both new
    // strings satisfied the `toContain`s.
    const unknown = panel(ALL_NULL, UNAVAILABLE.nutritionProvenance);
    // A user-entered record, the shape a genuine zero arrives in: someone typed 0 g of fat.
    const zero = panel(ALL_ZERO, USER_PROVENANCE);

    expect(element(unknown, 'np-fat').textContent).toContain(NUTRITION_UNAVAILABLE);
    expect(element(unknown, 'np-fat').textContent).not.toContain('0');
    expect(element(zero, 'np-fat').textContent).toContain('0 g');
    expect(element(zero, 'np-fat').textContent).not.toContain(NUTRITION_UNAVAILABLE);
    expect(element(zero, 'np-calories').textContent).toContain('0 kcal');

    expect(element(zero, 'np-fat').textContent).not.toBe(element(unknown, 'np-fat').textContent);
  });

  it('names the dataset, the serving count, and that the count was authored', () => {
    // TSD 7.4: the count is "recorded as authored, never presented as measured".
    const provenance = DERIVED.nutritionProvenance;
    const rendered = panel(DERIVED.nutrition, provenance);
    const trace = element(rendered, 'np-trace').textContent ?? '';

    expect(provenance.dataset).not.toBeNull();
    expect(provenance.servings).not.toBeNull();
    expect(trace).toContain(provenance.dataset ?? 'unreachable');
    expect(trace).toContain(`${String(provenance.servings)} servings`);
    expect(trace).toContain('authored');
    expect(trace).toContain('rather than measured');
  });

  it('says a serving count is unrecorded instead of dividing by null or leaving a gap', () => {
    // One field off a real derived record: "divided by null" is one edit away.
    const rendered = panel(DERIVED.nutrition, { ...DERIVED.nutritionProvenance, servings: null });
    const trace = element(rendered, 'np-trace').textContent ?? '';

    expect(trace).not.toContain('null');
    expect(trace).toContain('does not state it');
    // The authored fact survives the missing number: it is about serving counts, not this one.
    expect(trace).toContain('authored');
    expect(element(rendered, 'np-trace').children).toHaveLength(2);
  });

  it('says the dataset is unnamed rather than naming nothing', () => {
    const trace =
      element(
        panel(DERIVED.nutrition, { ...DERIVED.nutritionProvenance, dataset: null }),
        'np-trace',
      ).textContent ?? '';

    expect(trace).not.toContain('null');
    expect(trace).toContain('does not name');
    expect(trace).toContain('USDA');
  });

  it('renders the recorded reason verbatim when nutrition could not be derived', () => {
    // For 53 of 60 records this is the most useful sentence on the panel: the only one that says
    // WHY the four rows are empty. FR-006 records the reason; not showing it records it for nobody.
    const provenance = UNAVAILABLE.nutritionProvenance;
    const trace = element(panel(ALL_NULL, provenance), 'np-trace').textContent ?? '';

    expect(provenance.reason).not.toBeNull();
    expect(trace).toContain(provenance.reason ?? 'unreachable');
    expect(trace).toContain('could not be derived');
  });

  it('says no reason was recorded rather than rendering an empty line', () => {
    const rendered = panel(ALL_NULL, { ...UNAVAILABLE.nutritionProvenance, reason: null });
    const trace = element(rendered, 'np-trace');

    expect(trace.textContent).not.toContain('null');
    expect(trace.textContent).toContain('No reason');
    expect(trace.children).toHaveLength(2);
    for (const line of trace.children) {
      expect((line.textContent ?? '').trim()).not.toBe('');
    }
  });

  it('says the user entered their own figures, and never implies they were measured', () => {
    const trace = element(panel({ ...ALL_ZERO, calories: 300 }, USER_PROVENANCE), 'np-trace');
    const text = trace.textContent ?? '';

    expect(text).toContain('You entered these figures yourself');
    expect(text).toContain('not derived from a published dataset');
    expect(text).toContain('4 servings you recorded');
    expect(text).not.toContain('measured');
    expect(text).not.toContain('authored');
    expect(text).not.toContain('USDA');
  });

  it('ignores a dataset on a user record rather than implying it came from one', () => {
    // Adversarial, and the type permits it: a user record carrying a dataset name is one bad
    // compose away, and rendering it would say a figure they typed came out of USDA.
    const text =
      element(
        panel(ALL_ZERO, { ...USER_PROVENANCE, dataset: 'USDA FNDDS supporting data 2022-10-28' }),
        'np-trace',
      ).textContent ?? '';

    expect(text).not.toContain('FNDDS');
    expect(text).toContain('You entered these figures yourself');
  });

  it('says something for a user record with figures but no serving count', () => {
    // Figures present, so the guard below does not apply. `mealSchema` rejects this shape too.
    const trace = element(panel(ALL_ZERO, { ...USER_PROVENANCE, servings: null }), 'np-trace');

    expect(trace.textContent).toContain('no serving count');
    expect(trace.textContent).not.toContain('null');
    expect(trace.children).toHaveLength(2);
  });

  it('never states a serving count for a meal with no figures, whatever servings holds', () => {
    // W5-FORM-VALID's finding, on the one origin `mealSchema` permits it on. A count above four
    // "Not available" rows says a division produced values that do not exist - worse than silence.
    const trace = element(panel(ALL_NULL, USER_PROVENANCE), 'np-trace');
    const text = trace.textContent ?? '';

    expect(USER_PROVENANCE.servings).toBe(4);
    expect(text).toContain('have not entered nutrition figures');
    expect(text).not.toContain('serving');
    expect(text).not.toContain('4');
    expect(trace.children).toHaveLength(1);
  });

  it('names neither a dataset nor a count for a derived record carrying no figures', () => {
    // The other half. `mealSchema` rejects this shape, so it is type-reachable only - guarded
    // anyway, because dataset and count are both claims about figures and there are none.
    const trace = element(panel(ALL_NULL, DERIVED.nutritionProvenance), 'np-trace');
    const text = trace.textContent ?? '';

    expect(DERIVED.nutritionProvenance.servings).not.toBeNull();
    expect(text).toContain('nothing to trace');
    expect(text).not.toContain('FNDDS');
    expect(text).not.toContain('Divided by');
    expect(trace.children).toHaveLength(1);
  });

  it('guards a combination mealSchema really does permit, on the origin that permits it', () => {
    // Not the schema for its own sake: the evidence that the branch above guards a REACHABLE
    // state. `superRefine`'s `user` case fails only on `known === whole && servings === null`, so
    // all-null figures WITH a count validate - while `usda-derived`'s `known !== whole` closes it.
    const base = { ...DERIVED, nutrition: ALL_NULL };
    const asUser = mealSchema.safeParse({
      ...base,
      source: 'user',
      nutritionProvenance: { origin: 'user', dataset: null, servings: 4, reason: null },
    });
    const asDerived = mealSchema.safeParse(base);

    expect(asUser.success).toBe(true);
    expect(asDerived.success).toBe(false);
  });

  it('produces a non-empty, null-free trace for every origin and every null combination', () => {
    // Exhaustive rather than representative: 2 nutrition states x 3 origins x 2 datasets x 3
    // counts x 2 reasons = 72 traces, the whole space the two types describe. A gap or the word
    // "null" is a figure nobody can trace; a count with no figures is a division nobody made.
    const origins = ['usda-derived', 'unavailable', 'user'] as const;
    const datasets = [null, 'USDA FNDDS supporting data 2022-10-28'];
    const servings = [null, 1, 4];
    const reasons = [null, 'Flour "": the measure is empty'];
    let combinations = 0;

    for (const nutrition of [ALL_NULL, ALL_ZERO]) {
      for (const origin of origins) {
        for (const dataset of datasets) {
          for (const count of servings) {
            for (const reason of reasons) {
              const provenance = { origin, dataset, servings: count, reason };
              const lines = nutritionTraceLines(nutrition, provenance);
              combinations += 1;

              expect(lines.length).toBeGreaterThan(0);
              for (const line of lines) {
                expect(line.trim()).not.toBe('');
                expect(line).not.toContain('null');
                expect(line).not.toContain('undefined');
                expect(line).not.toContain('NaN');
              }
              if (nutrition === ALL_NULL && count !== null) {
                expect(lines.join(' ')).not.toContain(`${String(count)} serving`);
              }
            }
          }
        }
      }
    }

    expect(combinations).toBe(72);
  });

  it('says "1 serving", not "1 servings"', () => {
    expect(
      nutritionTraceLines(DERIVED.nutrition, {
        ...DERIVED.nutritionProvenance,
        servings: 1,
      }).join(' '),
    ).toContain('1 serving,');
  });

  it('gives the panel a heading a screen reader can navigate to', () => {
    // PRD 10.5: structure is information. With no heading this is loose text mid-screen.
    const container = tree(ALL_NULL, UNAVAILABLE.nutritionProvenance);

    expect(getByRole(container, 'heading', { name: 'Nutrition' })).toBeTruthy();
  });

  it('takes its surface from the card group in both schemes, so nothing here is a raw colour', () => {
    const inLight = panel(ALL_NULL, UNAVAILABLE.nutritionProvenance);
    const inDark = element(tree(ALL_NULL, UNAVAILABLE.nutritionProvenance, 'dark'), 'np');

    expect(inLight.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.card.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
    expect(inLight.style.padding).toBe(`${String(light.card.padding)}px`);
  });

  it('states the trail in a supporting tone, not a failing or an inactive one', () => {
    // The 53-record case must look deliberate rather than broken: a refusal to guess is correct
    // behaviour, and a warning tint (or `content.disabled`, the tone of a dead control) would make
    // the commonest record in the catalog read as a fault.
    const line = traceLine(panel(ALL_NULL, UNAVAILABLE.nutritionProvenance));

    expect(line.style.color).toBe(asRendered(lightColors.content.secondary));
    expect(line.style.color).not.toBe(asRendered(lightColors.content.disabled));
    expect(line.style.color).not.toBe(asRendered(lightColors.status.danger));
    expect(line.style.color).not.toBe(asRendered(lightColors.status.warning));
  });

  it('scales its trail with the OS text setting exactly once', () => {
    // Provable only because every string goes through `AppText`: the scale already carries the
    // OS factor (S-09), so a bare `Text` with a literal size would not move between these.
    const provenance = UNAVAILABLE.nutritionProvenance;
    const base = Number.parseFloat(traceLine(panel(ALL_NULL, provenance)).style.fontSize);
    const scaled = traceLine(element(tree(ALL_NULL, provenance, 'light', 2), 'np'));

    expect(base).toBeGreaterThan(0);
    expect(Number.parseFloat(scaled.style.fontSize)).toBe(base * 2);
  });
});
