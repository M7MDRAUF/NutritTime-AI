import { writeFile } from 'node:fs/promises';
import { expect, test } from '../support/fixtures.js';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Layout at the four supported widths (T-22-07).
 *
 * `Plan.md:1373` "No unintended horizontal scroll at 320/375/414/768 px" · `Plan.md:2486` the same
 * figures, evidence "Playwright screenshots" · `Plan.md:2777` §20 "Every screen usable at 320 px
 * without a horizontal scrollbar" · `Plan.md:2778` §20 "Supported viewports | 320 · 375 · 414 · 768
 * px, verified by screenshot". The widths are `playwright.config.ts`'s four projects.
 *
 * **The obvious assertion passes under the defect, which is why this file measures elements.**
 * `body.scrollWidth > body.clientWidth` is **false while the defect is present**, so an overflow at
 * 320 px is not a scrollbar a user can find — it is a control outside the viewport, unreachable and
 * invisible, with nothing saying so. Measured, not argued: the sensitivity test below widens one
 * real button to 520 px at load time and finds it **216 px** past a 320 px viewport while
 * `body.scrollWidth - body.clientWidth` is still **0**.
 *
 * **And the reason is deeper than the export's `body { overflow: hidden }`**, which is the reason
 * `playwright.config.ts` and CONTRACTS Amendment 11 both give and is only the outermost layer.
 * react-native-web gives every `View` `overflow: hidden`, so the overflow is absorbed at the screen
 * root: with the button widened, `[data-testid="assistant-screen"]` measures `overflow-x: hidden`,
 * `scrollWidth 536`, `clientWidth 320`, and a navigator container above it clips again. Overriding
 * `body`, then `body` **and** the screen root, left the document probe at 0 both times.
 *
 * **The observable: no rendered box is clipped, horizontally, by a box the user cannot scroll.**
 * For the screen's own box and every element under it, the nearest horizontal clip is found by
 * walking the ancestors — the viewport included — and compared against. Two alternatives were
 * rejected: *document scroll width*, the trap above; and *interactive elements against `innerWidth`
 * only*, which both misses an inner clip and calls a violation on a control that scrolls.
 *
 * **Plan §20 permits wide content — "wide content scrolls inside its own container" — so the walk
 * exempts it.** An overflowing `overflow-x: auto|scroll` ancestor means the element is reachable,
 * and from there up what has to fit is the container. Nothing in `apps/mobile/src` scrolls
 * horizontally today (`ExploreScreen.tsx:118`: the chip row wraps on purpose), hence its own test.
 *
 * **What it would still not catch**: text truncated on purpose and by accident are the same
 * measurement, and no `text-overflow` label exists yet to calibrate against; occlusion, which is
 * not clipping; the `isLargeText` reflow and font scaling; and any state no test reaches.
 *
 * **The screenshots supplement the assertion, they do not replace it** (P24 Part 5). Plan §2486's
 * evidence column says "Playwright screenshots", so one lands per screen per width in the test's
 * output directory and in the HTML report. Nothing compares them — no baseline, no
 * `toHaveScreenshot` — so they prove that the surface each row names rendered at that width, and
 * what it looked like; their reader is a human eye after a failure. `test-results/` is wiped by the
 * next run, so they are an artefact of a run, not a record of one.
 *
 * Lessons obeyed rather than re-learned: every screen is reached by **tapping**, never by URL (so
 * R-44 cannot be mistaken for a layout result), and the measurement is **scoped to the screen's own
 * container**, because an inactive tab stays mounted underneath.
 */

const FIRST_PAINT_MS = 20_000; // A cold bundle plus the first request, not long enough to hang.

/** Fractional device pixels leave fringes of ~0.5 px; every real overflow measured here was 100×. */
const SLACK_PX = 1;

/** Focusable surfaces as react-native-web renders them: a `Pressable` is a `div` with a `role` and
 * a `tabindex`, not a `button`. Only the non-vacuity floor reads this; the claim covers every box. */
const CONTROLS =
  'a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="link"],' +
  ' [role="switch"], [role="checkbox"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

interface ClippedBox {
  readonly what: string;
  readonly by: string;
  readonly clippedLeftPx: number;
  readonly clippedRightPx: number;
}

interface LayoutReport {
  readonly screen: string;
  readonly viewportWidth: number;
  readonly boxes: number;
  readonly controls: number;
  /** Boxes exempted because a scrollable ancestor makes them reachable (Plan §20). */
  readonly exempted: number;
  readonly clipped: readonly ClippedBox[];
  /** The naive probe's number, kept as a diagnostic. See the sensitivity test for what it means. */
  readonly bodyOverflow: number;
}

async function layoutReport(page: Page, screen: string, scope: string): Promise<LayoutReport> {
  return page.evaluate(
    ({ controlSelector, slack, scopeSelector, name }) => {
      const vw = window.innerWidth;
      const root = document.querySelector(scopeSelector);
      // An anonymous box is named by its nearest identified ancestor: a failure line has to point
      // at a place in the app, not at a react-native-web `div`.
      const describe = (el: Element): string => {
        const own = el.getAttribute('data-testid');
        if (own !== null) return `[${own}]`;
        const owner = el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid');
        const role = el.getAttribute('role');
        const tag = `<${el.tagName.toLowerCase()}${role === null ? '' : ` role=${role}`}>`;
        return owner === undefined || owner === null ? tag : `[${owner}] > ${tag}`;
      };
      let exempted = 0;
      const check = (el: Element): ClippedBox | null => {
        let rect = el.getBoundingClientRect();
        // No area is not rendered: `display: none` and an unmounted tab both land here.
        if (rect.width < 0.5 || rect.height < 0.5) return null;
        let clipLeft = 0;
        let clipRight = vw;
        let by = 'the viewport';
        for (let a = el.parentElement; a !== null; a = a.parentElement) {
          const overflowX = window.getComputedStyle(a).overflowX;
          if (overflowX === 'visible') continue;
          const scrolls = overflowX === 'auto' || overflowX === 'scroll';
          if (scrolls && a.scrollWidth > a.clientWidth + slack) {
            // Plan §20: from here up, the thing that has to fit is the container itself.
            exempted += 1;
            rect = a.getBoundingClientRect();
            clipLeft = 0;
            clipRight = vw;
            by = 'the viewport';
            continue;
          }
          const box = a.getBoundingClientRect();
          if (box.right < clipRight) {
            clipRight = box.right;
            by = describe(a);
          }
          clipLeft = Math.max(clipLeft, box.left);
        }
        const right = Math.round((rect.right - clipRight) * 10) / 10;
        const left = Math.round((clipLeft - rect.left) * 10) / 10;
        if (right <= slack && left <= slack) return null;
        return { what: describe(el), by, clippedLeftPx: Math.max(left, 0), clippedRightPx: Math.max(right, 0) }; // prettier-ignore
      };

      // The screen's OWN box is in the set: a root with a minimum width wider than the viewport is
      // the one overflow a subtree-only query cannot see.
      const boxes = root === null ? [] : [root, ...root.querySelectorAll('*')];
      const clipped: ClippedBox[] = [];
      for (const el of boxes) {
        const violation = check(el);
        if (violation !== null) clipped.push(violation);
      }
      return {
        screen: name,
        viewportWidth: vw,
        boxes: boxes.length,
        controls: root === null ? 0 : root.querySelectorAll(controlSelector).length,
        exempted,
        clipped,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      };
    },
    { controlSelector: CONTROLS, slack: SLACK_PX, scopeSelector: scope, name: screen },
  );
}

interface ScreenCheck {
  readonly name: string;
  readonly scope: string;
  readonly minControls: number;
  readonly shot: boolean;
}

/**
 * `minControls` is a **non-vacuity floor, not a layout claim** — the control on the control. A
 * scope that matched nothing, or a screen that rendered without its buttons, yields zero boxes and
 * so zero violations: a green run asserting nothing. Stated well below what each screen renders.
 */
function screenAt(testID: string, minControls: number, shot = true): ScreenCheck {
  return { name: testID, scope: `[data-testid="${testID}"]`, minControls, shot };
}

/** The tab bar belongs to no screen, and five tabs with five labels is the classic 320 px loss. */
const TAB_BAR: ScreenCheck = { name: 'tab-bar', scope: '[role="tablist"]', minControls: 5, shot: true }; // prettier-ignore

async function checkScreen(
  page: Page,
  info: TestInfo,
  check: ScreenCheck,
  bag: LayoutReport[],
): Promise<void> {
  const report = await layoutReport(page, check.name, check.scope);
  bag.push(report);
  const at = `${check.name} at ${String(report.viewportWidth)} px`;
  if (check.shot) {
    const name = `${check.name}-${String(report.viewportWidth)}.png`;
    const shot = info.outputPath(name);
    await page.screenshot({ path: shot });
    await info.attach(name, { path: shot, contentType: 'image/png' });
  }

  expect.soft(report.boxes, `${at}: ${check.scope} matched nothing`).toBeGreaterThan(0);
  expect.soft(report.controls, `${at}: too few focusable elements`).toBeGreaterThanOrEqual(check.minControls); // prettier-ignore
  expect.soft(report.clipped, `${at}: cut off by something the user cannot scroll`).toEqual([]);
}

async function record(info: TestInfo, bag: readonly LayoutReport[]): Promise<void> {
  const path = info.outputPath('layout.json');
  await writeFile(path, JSON.stringify(bag, null, 2), 'utf8');
  await info.attach('layout.json', { path, contentType: 'application/json' });
}

test('the five tabs and the tab bar fit the viewport', async ({ page, app }, info) => {
  const bag: LayoutReport[] = [];
  await app();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('home-screen', 3), bag);
  await checkScreen(page, info, TAB_BAR, bag);

  const tabs = [['Explore', 12], ['Assistant', 2], ['Saved', 1], ['Settings', 9]] as const; // prettier-ignore
  for (const [tab, minControls] of tabs) {
    await page.getByRole('tab', { name: tab }).click();
    const name = `${tab.toLowerCase()}-screen`;
    await expect(page.getByTestId(name)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await checkScreen(page, info, screenAt(name, minControls), bag);
  }
  await record(info, bag);
});

/**
 * The three screens that are not tabs: the modal, the form on the root stack, and the preferences
 * form Settings pushes, each opened through the affordance a user has. `MealForm` and
 * `DietarySetup` both cover the tab bar (`custom-meal-crud.spec.ts:219`), so each is dismissed with
 * browser Back first. **`DietarySetup` is reached through Settings, not onboarding**: X-31's
 * meal-time ordering rule blocked an earlier spec from driving it to completion, and nothing here
 * submits it, so the rule is not in the way of measuring it.
 */
test('the modal and the two pushed forms fit the viewport', async ({ page, app }, info) => {
  const bag: LayoutReport[] = [];
  await app();
  await page.getByRole('tab', { name: 'Explore' }).click();
  await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: FIRST_PAINT_MS });
  // Scoped to Explore: Home stays mounted behind it with the same `meal-<id>` ids.
  const card = page.getByTestId('explore-screen').locator('[data-testid^="meal-"]').first();
  await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
  await card.click();
  await expect(page.getByTestId('meal-details-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('meal-details-screen', 2), bag);
  await page.goBack();
  await expect(page.getByTestId('meal-details-screen')).toHaveCount(0, { timeout: FIRST_PAINT_MS });

  await page.getByRole('tab', { name: 'Saved' }).click();
  await expect(page.getByTestId('saved-new-meal')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await page.getByTestId('saved-new-meal').click();
  await expect(page.getByTestId('meal-form-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('meal-form-screen', 20), bag);
  await page.goBack();
  await expect(page.getByTestId('meal-form-screen')).toHaveCount(0, { timeout: FIRST_PAINT_MS });

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByTestId('settings-edit-preferences').click();
  await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('dietary-setup-screen', 20), bag);
  await record(info, bag);
});

/**
 * The two surfaces an empty device shows, which no seeded spec can reach.
 *
 * The splash surface is held by **delaying the font files rather than failing them**:
 * `App.tsx:240` treats a font error as ready, so an aborted `.ttf` would advance straight past the
 * surface this row measures and then measure onboarding in fallback metrics, which is not the
 * layout a user gets. Released with `continue`, so the real faces load. The `Splash` ROUTE is a
 * different thing and is **not** reachable: `RootNavigator.tsx:47` declares it only in the
 * `hydrating` phase, which `App.tsx:169-175` no longer passes — it renders the surface directly.
 *
 * **It is also the one row with no screenshot, because Playwright cannot take one.**
 * `page.screenshot` awaits `document.fonts.ready`, and the surface exists only while that promise
 * is pending — the wait cannot finish until the subject is gone. Asserted, never photographed.
 */
test('the cold-start surfaces fit the viewport', async ({ page, emptyDevice }, info) => {
  const bag: LayoutReport[] = [];
  let releaseFonts = (): void => {};
  const held = new Promise<void>((resolve) => {
    releaseFonts = resolve;
  });
  await page.route('**/*.ttf', async (route) => {
    // Bounded: a held subresource can block a `load` event, and a deadlock reads as a bare timeout.
    await Promise.race([held, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    await route.continue();
  });

  await emptyDevice();
  await expect(page.getByTestId('splash-surface')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('splash-surface', 0, false), bag);

  releaseFonts();
  await expect(page.getByTestId('onboarding-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await page.unroute('**/*.ttf');
  await checkScreen(page, info, screenAt('onboarding-screen', 1), bag);
  await record(info, bag);
});

/**
 * **The assertion, checked against a real overflow — and against the probe that would have missed
 * it.** One real control is widened at load time over the built artefact, so no repository file is
 * written (BRIEF §6.1i). 520 px exceeds 414 and fits 768, so the injection must be caught at the
 * three phone widths and **not** at the tablet one — which no single verdict satisfies.
 *
 * `bodyOverflow` is asserted at 0 beside it, **not as a guard on this app's code**: the header
 * records that several react-native-web layers each absorb the overflow and that two load-time
 * probes failed to move it. What it pins is the toolchain assumption this design rests on — if an
 * upgrade stops clipping `View`s, this line fails and the file can be simplified.
 */
test('the assertion is sensitive to a real overflow', async ({ page, app }, info) => {
  await app();
  await page.getByRole('tab', { name: 'Assistant' }).click();
  await expect(page.getByTestId('assistant-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  const scope = '[data-testid="assistant-screen"]';
  expect((await layoutReport(page, 'before', scope)).clipped).toEqual([]);

  await page.addStyleTag({ content: '[data-testid="assistant-ask"]{min-width:520px !important}' });
  const after = await layoutReport(page, 'after', scope);
  await record(info, [after]);

  if (after.viewportWidth < 520) {
    expect(after.clipped.map((box) => box.what)).toContain('[assistant-ask]');
    expect(after.clipped[0]?.clippedRightPx).toBeGreaterThan(100);
    expect(after.bodyOverflow).toBe(0);
  } else {
    expect(after.clipped).toEqual([]);
  }
});

/**
 * Plan §20's other half — "wide content scrolls inside its own container" — as a pair no constant
 * satisfies: one over-wide chip row, **permitted** while its container scrolls and **refused** when
 * the same container clips. `exempted` is asserted above zero in the permitted case because a
 * 0-of-N result has two readings and only one is good (BRIEF §6.1k).
 */
test('wide content is permitted inside a container that scrolls', async ({ page, app }, info) => {
  await app();
  await page.getByRole('tab', { name: 'Explore' }).click();
  await expect(page.getByTestId('explore-filters')).toBeVisible({ timeout: FIRST_PAINT_MS });
  const scope = '[data-testid="explore-screen"]';
  const wide =
    '[data-testid="explore-filters"] > *{min-width:200px !important;flex-shrink:0 !important}' +
    '[data-testid="explore-filters"]{flex-wrap:nowrap !important;';

  await page.addStyleTag({ content: `${wide}overflow-x:auto !important}` });
  const scrolls = await layoutReport(page, 'scrollable', scope);
  expect(scrolls.exempted).toBeGreaterThan(0);
  expect(scrolls.clipped).toEqual([]);

  await page.addStyleTag({ content: '[data-testid="explore-filters"]{overflow-x:hidden!important}' }); // prettier-ignore
  const clips = await layoutReport(page, 'clipped', scope);
  await record(info, [scrolls, clips]);
  expect(clips.exempted).toBe(0);
  expect(clips.clipped.length).toBeGreaterThan(0);
  expect(clips.clipped.map((box) => box.by)).toContain('[explore-filters]');
});
