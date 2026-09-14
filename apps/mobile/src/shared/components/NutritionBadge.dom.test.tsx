import { describe, expect, it } from 'vitest';
import { asRendered, element, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { NutritionBadge, NUTRITION_UNAVAILABLE } from './NutritionBadge.js';

const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

/** The value `Text` is the second child; the first is the label. */
function valueNode(container: HTMLElement, testID: string): HTMLElement {
  const value = element(container, testID).children.item(1);
  if (!(value instanceof HTMLElement)) {
    throw new Error('no value rendered');
  }
  return value;
}

describe('NutritionBadge', () => {
  it('renders the exact words TSD 6.7 and PRD FR-011 name, when the amount is null', () => {
    const badge = element(
      render(<NutritionBadge testID="n" label="Protein" amount={null} unit="g" />),
      'n',
    );

    expect(NUTRITION_UNAVAILABLE).toBe('Not available');
    expect(badge.textContent).toContain(NUTRITION_UNAVAILABLE);
  });

  it('never renders a zero for an unknown value', () => {
    // PRD FR-006: an unset value is null and renders "Not available" - never 0, never a guess.
    // `null` and `0` are different claims and one of them is a claim this project cannot make.
    const badge = element(
      render(<NutritionBadge testID="n" label="Fat" amount={null} unit="g" />),
      'n',
    );

    expect(badge.textContent).not.toContain('0');
    expect(badge.textContent).not.toContain('g');
  });

  it('renders a genuine zero as a zero', () => {
    // This is the assertion the natural wrong implementation fails. `amount ? ... : 'Not
    // available'` is the obvious way to write this component, and it turns a measured zero into
    // an unknown - the opposite of FR-006's distinction. 53 of the 60 catalog records are null
    // and a real 0 g of fat is a figure the app is entitled to report.
    const badge = element(
      render(<NutritionBadge testID="n" label="Fat" amount={0} unit="g" />),
      'n',
    );

    expect(badge.textContent).toContain('0 g');
    expect(badge.textContent).not.toContain(NUTRITION_UNAVAILABLE);
  });

  it('renders a known amount with its unit, for both units', () => {
    const grams = element(
      render(<NutritionBadge testID="n" label="Protein" amount={25} unit="g" />),
      'n',
    );
    const calories = element(
      render(<NutritionBadge testID="n" label="Calories" amount={480} unit="kcal" />),
      'n',
    );

    expect(grams.textContent).toContain('25 g');
    expect(calories.textContent).toContain('480 kcal');
    expect(grams.textContent).not.toContain('kcal');
  });

  it('states the absence in a readable tone, not a disabled or a dangerous one', () => {
    // `component.ts` pins `badge.unavailableText` to `content.tertiary` and says why: "'Not
    // available' is a fact about the data, not an inactive control, so it has to meet the AA
    // minimum like any other text." A failure colour would make the commonest case in the
    // catalog read as a fault on 53 of 60 meals.
    const unknown = valueNode(
      render(<NutritionBadge testID="n" label="Carbs" amount={null} unit="g" />),
      'n',
    );

    expect(unknown.style.color).toBe(asRendered(light.badge.unavailableText));
    expect(unknown.style.color).not.toBe(asRendered(lightColors.content.disabled));
    expect(unknown.style.color).not.toBe(asRendered(lightColors.status.danger));
    expect(unknown.style.color).not.toBe(asRendered(lightColors.status.warning));
  });

  it('keeps the unknown case in the same pill as the known one', () => {
    // Same fill, same minimum height, same radius. A different shape would be the visual way of
    // saying "this one is broken", which is exactly what it is not.
    const known = element(
      render(<NutritionBadge testID="n" label="Protein" amount={25} unit="g" />),
      'n',
    );
    const unknown = element(
      render(<NutritionBadge testID="n" label="Protein" amount={null} unit="g" />),
      'n',
    );

    expect(unknown.style.backgroundColor).toBe(known.style.backgroundColor);
    expect(unknown.style.backgroundColor).toBe(asRendered(light.badge.neutralBackground));
    expect(unknown.style.minHeight).toBe(known.style.minHeight);
    expect(unknown.style.minHeight).toBe(`${String(light.badge.minHeight)}px`);
    expect(unknown.style.borderTopLeftRadius).toBe(known.style.borderTopLeftRadius);
  });

  it('is not padded to a touch target: a badge is read, not tapped', () => {
    // `component.ts` says it in the token - a nutrition row padded to 48 would be four times too
    // tall. This is the assertion that catches someone "fixing" the badge to match `Chip`.
    const badge = element(
      render(<NutritionBadge testID="n" label="Protein" amount={25} unit="g" />),
      'n',
    );

    expect(badge.style.minHeight).toBe(`${String(light.badge.minHeight)}px`);
    expect(badge.style.minHeight).not.toBe(`${String(light.chip.minHeight)}px`);
    expect(badge.getAttribute('role')).not.toBe('button');
  });

  it('lines its figures up in a column, and does not pretend "Not available" is a figure', () => {
    // Tabular figures are for a column of numbers. Applying them to the words would be a lie
    // about what the string contains, and it is the kind of lie that is invisible until someone
    // wonders why the text is spaced oddly.
    const known = valueNode(
      render(<NutritionBadge testID="n" label="Protein" amount={25} unit="g" />),
      'n',
    );
    const unknown = valueNode(
      render(<NutritionBadge testID="n" label="Protein" amount={null} unit="g" />),
      'n',
    );

    expect(known.style.fontVariant).toContain('tabular-nums');
    expect(unknown.style.fontVariant).not.toContain('tabular-nums');
  });

  it('takes its colours from the badge group in both schemes', () => {
    const inLight = element(
      render(<NutritionBadge testID="n" label="Protein" amount={null} unit="g" />),
      'n',
    );
    const inDark = element(
      render(<NutritionBadge testID="n" label="Protein" amount={null} unit="g" />, 'dark'),
      'n',
    );

    expect(inLight.style.backgroundColor).toBe(asRendered(light.badge.neutralBackground));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.badge.neutralBackground));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('stacks the label above the value at a 2x font scale instead of squeezing them', () => {
    // "Not available" is the longest value this component renders, so it is the one that would
    // wrap first. PRD 10.5: text scales without clipping.
    const normal = element(
      render(<NutritionBadge testID="n" label="Protein" amount={null} unit="g" />),
      'n',
    );
    const large = element(
      render(<NutritionBadge testID="n" label="Protein" amount={null} unit="g" />, 'light', 2),
      'n',
    );

    expect(normal.style.flexDirection).toBe('row');
    expect(large.style.flexDirection).toBe('column');
    expect(large.style.height).toBe('');
    expect(large.style.maxHeight).toBe('');
  });

  it('scales its own type with the OS setting exactly once', () => {
    // `theme.typography` already carries the factor (DECISIONS.md S-09), so every `Text` here
    // sets `allowFontScaling={false}`.
    //
    // **What this proves is the ARITHMETIC, not the prop.** react-native-web 0.21 does not
    // forward `allowFontScaling` and its `Text` never reads it, so removing the flag from this
    // component would change nothing here - the 4x bug is unreachable on the web surface and only
    // a device at P23 can catch a `Text` that skipped it (R-35). What IS pinned is that the token
    // carries the factor exactly once: 16 px at 1x must be 32 px at 2x, not 64.
    const single = valueNode(
      render(<NutritionBadge testID="n" label="Protein" amount={25} unit="g" />),
      'n',
    );
    const doubled = valueNode(
      render(<NutritionBadge testID="n" label="Protein" amount={25} unit="g" />, 'light', 2),
      'n',
    );

    const base = Number.parseFloat(single.style.fontSize);
    const scaled = Number.parseFloat(doubled.style.fontSize);

    expect(base).toBeGreaterThan(0);
    expect(scaled).toBe(base * 2);
  });
});
