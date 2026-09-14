import { describe, expect, it } from 'vitest';
import type { ColorScheme } from './semantic.js';
import { colorsByScheme } from './semantic.js';
import { buildComponentTokens } from './component.js';
import { touch } from './primitive.js';

/**
 * **Geometry, not colour — split out of `component-contrast.test.ts` at P23.**
 *
 * These assertions were in the component-contrast file because they needed a home, not because
 * they belong beside a ratio: they measure PRD 10.5's touch-target rule, which has no foreground,
 * no background and no scheme. The colour file reached 811 lines against a 408-line row when the
 * derived component-token guard landed, and this is the block whose question is furthest from it.
 *
 * Nothing was rewritten: the docblock, the five PRD constants and the five tests are the same
 * lines, moved.
 */

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

/**
 * **PRD 10.5's other measurable rule — pinned to the requirement, not to itself.**
 *
 * Every touch-target assertion in this repo is of the form
 * `expect(chip.style.minHeight).toBe(String(light.minHeight) + 'px')` — the rendered geometry
 * compared to the token it was rendered from. Both sides move together, so changing
 * `touch.buildTo` from 48 to 20 shrinks every button, chip and field in the app and the whole gate
 * stays green. The three figures below are PRD 10.5's own literals, restated here because that is
 * the only way a token change can fail against the rule rather than against its own new value.
 *
 * `touch.iosMinPt`, `touch.androidMinDp` and `touch.webMinPx` had zero consumers and zero
 * assertions; these are their first. `touch.gap` still has no consumer — `button.gap` and
 * `chip.gap` read `space.*` — so it is bounded here and reported as unintegrated rather than given
 * a consumer it does not have.
 */
const PRD_IOS_MIN_PT = 44;
const PRD_ANDROID_MIN_DP = 48;
const PRD_WEB_MIN_PX = 24;
/** Apple HIG and Material both put 8 between two adjacent targets. */
const HIG_MIN_GAP = 8;
const PRD_TARGET_FLOOR = Math.max(PRD_IOS_MIN_PT, PRD_ANDROID_MIN_DP, PRD_WEB_MIN_PX);

describe('touch targets meet PRD 10.5', () => {
  it('states the three platform minima as PRD 10.5 states them', () => {
    expect([touch.iosMinPt, touch.androidMinDp, touch.webMinPx]).toEqual([
      PRD_IOS_MIN_PT,
      PRD_ANDROID_MIN_DP,
      PRD_WEB_MIN_PX,
    ]);
    expect(touch.gap).toBeGreaterThanOrEqual(HIG_MIN_GAP);
  });

  it('builds to a single value that satisfies all three platforms at once', () => {
    // PRD 10.5: "48 dp satisfies all three, so it is the single value to build to."
    expect(touch.buildTo).toBeGreaterThanOrEqual(PRD_TARGET_FLOOR);
  });

  it.each(SCHEMES)('every tappable component group clears the floor in %s', (scheme) => {
    const tokens = buildComponentTokens(colorsByScheme[scheme]);
    for (const [name, minHeight] of [
      ['button', tokens.button.minHeight],
      ['field', tokens.field.minHeight],
      ['chip', tokens.chip.minHeight],
    ] as const) {
      expect(
        minHeight,
        `${name}.minHeight is ${String(minHeight)}, under PRD 10.5's ${String(PRD_TARGET_FLOOR)}`,
      ).toBeGreaterThanOrEqual(PRD_TARGET_FLOOR);
    }
  });

  it('sizes a target identically in both schemes', () => {
    // Geometry is not a scheme decision. `buildComponentTokens` takes only the colour map, so a
    // height that differed between the two could only come from a scheme-aware expression.
    const light = buildComponentTokens(colorsByScheme.light);
    const dark = buildComponentTokens(colorsByScheme.dark);
    expect([light.button.minHeight, light.field.minHeight, light.chip.minHeight]).toEqual([
      dark.button.minHeight,
      dark.field.minHeight,
      dark.chip.minHeight,
    ]);
  });

  it('records the badge exemption rather than omitting it', () => {
    // `NutritionBadge` is read, not tapped — TSD 6.7 makes it a separate component from `Chip` for
    // exactly that reason — so the floor does not apply to it. Asserted as an exemption in the
    // house style of `border.subtle`: a badge that grew to a tappable height would tell someone,
    // and so would a floor that fell under the web minimum.
    const badge = buildComponentTokens(colorsByScheme.light).badge;
    expect(badge.minHeight).toBeLessThan(PRD_TARGET_FLOOR);
    expect(badge.minHeight).toBeGreaterThanOrEqual(PRD_WEB_MIN_PX);
  });
});
