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
 * **R-72 is CLOSED, and `test.fail` is gone rather than inverted.** While the defect was open this
 * file carried `test.fail(width < 768)`, which is the only kind of known-gap marker this project
 * accepts — a described gap is forgotten, a checked one is not. The assertion below is now
 * unconditional, so it still claims both halves the marker claimed: whole below 768 **and** whole
 * at 768. Nothing about the second half was weakened to close the first.
 *
 * **What was actually wrong, because the recorded explanation was wrong and that is why two fixes
 * failed.** `@react-navigation/bottom-tabs` 7.18.18 spends its uikit metrics like this: the bar is
 * `TABBAR_HEIGHT_UIKIT = 49` (`src/views/BottomTabBar.tsx`), the tab spends `padding: 5` per edge
 * (`tabVerticalUiKit`), and the icon wrapper is `ICON_SIZE_TALL = 28` (`src/views/TabBarIcon.tsx`).
 * That leaves **10 px** for a label styled `labelBeneath: { fontSize: 10 }` — whose line box needs
 * **14**. The label is a flex item with `flex: 0 1 auto` in that column, so it is not merely
 * unstyled, it is **actively compressed 14 → 10**, and `numberOfLines={1}` on
 * `@react-navigation/elements`' `Label` gives react-native-web 0.21.2's `textOneLine`
 * (`overflow: hidden`), which cuts the descenders instead of spilling them.
 *
 * **So the two reverted attempts failed for a reason that was mis-recorded.** `tabBarLabelStyle:
 * { lineHeight: 16 }` grew the line box inside a box the flex column still pinned at 10, and
 * `height: 16` is a flex item's *base* size, which shrinking then overrides — it could not have
 * changed anything. The note that `tabBarLabelStyle` "does not reach the clipped element" is
 * **false**: `Label` passes its `style` straight to a single react-native-web `Text`, the clipped
 * element carries nine generated classes and the text node together, and attempt one's own
 * `scrollHeight` moving 14 → 16 is proof the prop arrived. The four-class elements it was mistaken
 * for are the **icon's**.
 *
 * The fix is therefore ROOM rather than a label style: `TabNavigator.tsx` sizes the tab bar from the
 * library's own three metrics plus the project's smallest published line height, and the label —
 * no longer competing for a 10 px remainder — is never compressed and needs no style of its own. A
 * `minHeight` floor on the label was tried alongside it and measured redundant, so it was dropped;
 * 768 px is untouched either way, and still measures the beside-icon variant's `24 / 24`.
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
  await app();
  await expect(page.locator('[role="tablist"]')).toBeVisible();

  // The claim is about all five, so assert the population first: an empty tab bar would satisfy
  // "nothing is clipped" perfectly, which is the vacuity T-19-09's acceptance names.
  await expect(page.locator('[role="tab"]')).toHaveCount(5);

  /**
   * Unconditional, at all four widths. Before the fix this reported five entries of
   * `needed 14 / given 10` with `overflow-y: hidden` at 320, 375 and 414 px, and nothing at 768;
   * after it, nothing anywhere, with the labels measuring `needed 16 / given 16` below 768 and the
   * beside-icon variant's `24 / 24` at 768 — which is to say the 768 half is unchanged by the fix,
   * as a floor should leave it.
   */
  const clipped = await clippedTextIn(page, '[role="tablist"]');
  expect(clipped, JSON.stringify(clipped, null, 2)).toEqual([]);
});

test('no tab label is painted outside the tab that owns it', async ({ page, app }) => {
  await app();
  await expect(page.locator('[role="tablist"]')).toBeVisible();
  await expect(page.locator('[role="tab"]')).toHaveCount(5);

  /**
   * **This catches the fix the test above cannot distinguish from the real one, and the mutation is
   * not hypothetical — it is what two agents already reached for.**
   *
   * Both reverted attempts put a style on `tabBarLabelStyle`. The one that would have "worked" is a
   * `minHeight` floor: `min-height` beats `flex-shrink`, so the label stops being compressed and
   * **the test above goes green** — while the flex column it sits in still has 6 px less than the
   * content now needs, so the label's ink is pushed past the bottom of its own tab. `overflow:
   * visible` on the tab means nothing clips it and no box reports a mismatch, so the first test is
   * blind to it; measured at 320 × 568, all five labels paint at `bottom 569` against a tab ending
   * at `568` — one pixel below the viewport, which is to say off the screen.
   *
   * So this measures containment rather than fit: every label's painted box must lie inside the
   * `[role="tab"]` that owns it. It is the reason `TabNavigator.tsx` can safely set no label style
   * at all, and it reddens for the edit most likely to be attempted next.
   */
  const escaped = await page.evaluate(() => {
    const out: { text: string; labelBottom: number; tabBottom: number }[] = [];
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      const tabBox = tab.getBoundingClientRect();
      for (const node of tab.querySelectorAll('*')) {
        if (!(node instanceof HTMLElement)) continue;
        const own = [...node.childNodes].some(
          (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '',
        );
        if (!own) continue;
        const box = node.getBoundingClientRect();
        // Half a pixel of tolerance, for the same fractional-device-ratio reason as above.
        if (box.bottom > tabBox.bottom + 0.5 || box.top < tabBox.top - 0.5) {
          out.push({
            text: (node.textContent ?? '').trim().slice(0, 40),
            labelBottom: Math.round(box.bottom * 100) / 100,
            tabBottom: Math.round(tabBox.bottom * 100) / 100,
          });
        }
      }
    }
    return out;
  });

  expect(escaped, JSON.stringify(escaped, null, 2)).toEqual([]);
});

test('the assertion is sensitive to a label that outgrows its line box', async ({ page, app }) => {
  await app();
  await expect(page.locator('[role="tablist"]')).toBeVisible();

  /**
   * **The control, and it is not redundant with the two assertions above.**
   *
   * Those two assert that the app has no clipped or escaped label; this one asks whether the
   * MEASUREMENT works, by producing a much larger, unambiguous clip. Without it, "nothing is
   * clipped" and "my assertion never fires" are indistinguishable — and now that R-72 is closed and
   * the marker is gone, this control is the ONLY thing standing between a green run and an
   * assertion that measures nothing. It mattered while the defect was open; it matters more now.
   *
   * A style override rather than a source mutation, because the thing being reproduced IS a
   * line-box/box mismatch. `!important` is used because the label's own `height` arrives inline and
   * would otherwise win — not, as this note used to claim, because `tabBarLabelStyle` fails to
   * reach the element: it does reach it, and R-72's docstring above records how that was measured.
   */
  await page.addStyleTag({
    content:
      '[role="tab"] div, [role="tab"] span { line-height: 40px !important; overflow-y: hidden !important; }',
  });

  const clipped = await clippedTextIn(page, '[role="tablist"]');
  expect(clipped.length).toBeGreaterThan(0);
  // The numbers a reader needs to act, not just a boolean — and a bigger gap than the four pixels
  // R-72 lost, so a pass here cannot be that defect returning and being re-reported as sensitivity.
  expect(clipped[0]?.needed).toBeGreaterThan((clipped[0]?.given ?? 0) + 10);
});
