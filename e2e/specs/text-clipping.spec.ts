import { expect, test } from '../support/fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Text that is painted CLIPPED inside a box that measures as fitting (T-22-07, T-23-03).
 *
 * **This file exists because T-22-07's box measurements cannot see this class of defect, and one
 * shipped.** `viewport.spec.ts` walks every element's box against the nearest ancestor that clips
 * horizontally, and it is right about what it claims — but the five bottom-tab labels were having
 * their lower halves cut at 320, 375 and 414 px while **every box reported as fitting**, because the
 * box and the clip were the same 10 px element. It was found by a human reading the screenshots
 * `Plan.md` §20 asks for as that row's evidence, which is the argument for the Plan having asked for
 * them — and the argument for this file, so the next one is not found that way.
 *
 * **The observable, and why it is a different one.** For a text element, `scrollHeight` is the
 * height the glyphs need and `clientHeight` is the height they are given; react-native-web's `Text`
 * carries `overflow: hidden`, so when the first exceeds the second the difference is not a scrollbar
 * but ink that was never drawn. A `getBoundingClientRect` comparison cannot distinguish that from a
 * box that fits, because the box does fit — it is the CONTENT that does not.
 *
 * **The defect is OPEN and this file is its marker (R-72).** `test.fail` is deliberate: it turns
 * red the day the labels stop being clipped, which is the only kind of known-gap marker this
 * project accepts — a described gap is forgotten, a checked one is not.
 *
 * `@react-navigation/bottom-tabs` 7.18.18 styles the stacked label `{ fontSize: 10 }` with no
 * `lineHeight` (`src/views/BottomTabItem.tsx:431-436`) while its beside-icon variant sets
 * `lineHeight: 24` — so the defect is invisible at 768 px, the one supported width where the labels
 * sit beside their icons.
 *
 * **Two fixes were tried from `TabNavigator.tsx` and both were reverted, measured.**
 * `tabBarLabelStyle: { lineHeight: 16 }` made it **worse**: the line box grew while the box stayed
 * pinned, so `scrollHeight` went from ~12 to **16** against `clientHeight 10`. Adding
 * `height: 16` alongside it changed nothing, and the reason is the useful part — those styles
 * DO arrive, inline, on the element react-navigation labels; the clipped element is a **different,
 * inner** `div` that react-native-web renders for the text itself (four generated classes against
 * the outer's nine) and that `tabBarLabelStyle` does not reach. Verified by dumping the inline
 * style and every matching `height` rule: the outer carries `height: 16px` while the inner still
 * measures `clientHeight 10`.
 *
 * So the fix is not a style on this prop. It needs either `tabBarLabel` rendered as this project's
 * own `AppText` — which is a `TabNavigator` change with its own accessible-name consequences — or a
 * library upgrade. Neither is a one-line edit and neither should be guessed at inside another
 * phase's round.
 *
 * Vertical, not horizontal, because that is where the clipping happened; a horizontal ellipsis is a
 * deliberate affordance in this app (`numberOfLines` is used nowhere, but `Text` truncation is
 * react-native-web's default) and is not what this measures.
 */

/** Anything whose own box is its own clip: the case box geometry is blind to. */
interface ClippedText {
  readonly text: string;
  readonly needed: number;
  readonly given: number;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly height: string;
  readonly parentHeight: string;
  readonly parentOverflowY: string;
}

async function clippedTextIn(page: Page, scope: string): Promise<readonly ClippedText[]> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (root === null) {
      throw new Error(`no element for ${selector}`);
    }
    const out: ClippedText[] = [];
    for (const node of [root, ...root.querySelectorAll('*')]) {
      if (!(node instanceof HTMLElement)) continue;
      // Only leaves that actually carry words. A container's `scrollHeight` legitimately exceeds
      // its `clientHeight` whenever it scrolls, and those are not what this is about.
      const own = [...node.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '',
      );
      if (!own) continue;
      const style = getComputedStyle(node);
      if (
        style.overflowY === 'visible' ||
        style.overflowY === 'auto' ||
        style.overflowY === 'scroll'
      )
        continue;
      // 1 px of tolerance: sub-pixel line boxes round against us on fractional device ratios, and a
      // half-pixel is not ink a reader loses.
      if (node.scrollHeight > node.clientHeight + 1) {
        // `height` and the parent's are reported too, because `needed > given` says the ink is
        // lost and not WHY: a line box that grew and a box that was pinned are different fixes,
        // and the first attempt here raised `lineHeight` against a fixed `height` and made the
        // gap wider rather than closing it.
        const parent = node.parentElement;
        out.push({
          text: (node.textContent ?? '').trim().slice(0, 40),
          needed: node.scrollHeight,
          given: node.clientHeight,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          height: style.height,
          parentHeight: parent === null ? 'none' : getComputedStyle(parent).height,
          parentOverflowY: parent === null ? 'none' : getComputedStyle(parent).overflowY,
        });
      }
    }
    return out;
  }, scope);
}

test('no tab label is painted clipped inside its own box', async ({ page, app }) => {
  const width = page.viewportSize()?.width ?? 0;

  /**
   * **Conditional on purpose, and the condition is the finding.**
   *
   * A blanket `test.fail` was tried first and turned RED at 768 px — because at that width the
   * labels are genuinely fine. `@react-navigation/bottom-tabs` 7.18.18 swaps to its beside-icon
   * variant there, and that one sets `lineHeight: 24` (`src/views/BottomTabItem.tsx:435`) while the
   * stacked variant sets `{ fontSize: 10 }` and no line height at all. So this asserts both halves:
   * **clipped below 768, whole at 768**, and either half changing is a red test.
   *
   * That is why the marker is not simply `test.skip` on three projects: a skip would drop the claim
   * that 768 works, which is the evidence identifying the library as the cause.
   */
  test.fail(width < 768, 'R-72 — the stacked tab label has no line height below 768 px');

  await app();
  await expect(page.locator('[role="tablist"]')).toBeVisible();

  // The claim is about all five, so assert the population first: an empty tab bar would satisfy
  // "nothing is clipped" perfectly, which is the vacuity T-19-09's acceptance names.
  await expect(page.locator('[role="tab"]')).toHaveCount(5);

  // Measured at P22: five entries, each `needed 12 / given 10` with `overflow-y: hidden`, at 320,
  // 375 and 414 px — and nothing at all at 768.
  const clipped = await clippedTextIn(page, '[role="tablist"]');
  expect(clipped, JSON.stringify(clipped, null, 2)).toEqual([]);
});

test('the assertion is sensitive to a label that outgrows its line box', async ({ page, app }) => {
  await app();
  await expect(page.locator('[role="tablist"]')).toBeVisible();

  /**
   * **The control, and it is not redundant with the `test.fail` above.**
   *
   * That one records a defect the app has; this one asks whether the MEASUREMENT works, by
   * producing a much larger, unambiguous clip. Without it, "the labels are clipped" and "my
   * assertion fires on anything" are indistinguishable — and a `test.fail` that passes for the
   * wrong reason would go unnoticed precisely because it is expected to fail.
   *
   * A style override rather than a source mutation, because the thing being reproduced IS a
   * line-box/box mismatch, and `!important` is what reaches the inner element that
   * `tabBarLabelStyle` was measured not to reach.
   */
  await page.addStyleTag({
    content:
      '[role="tab"] div, [role="tab"] span { line-height: 40px !important; overflow-y: hidden !important; }',
  });

  const clipped = await clippedTextIn(page, '[role="tablist"]');
  expect(clipped.length).toBeGreaterThan(0);
  // The numbers a reader needs to act, not just a boolean — and a bigger gap than the real defect's
  // two pixels, so a pass here cannot be the real defect being re-reported.
  expect(clipped[0]?.needed).toBeGreaterThan((clipped[0]?.given ?? 0) + 10);
});
