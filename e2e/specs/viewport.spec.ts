import { writeFile } from 'node:fs/promises';
import { expect, test } from '../support/fixtures.js';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Layout at the four supported widths (T-22-07).
 *
 * **Quoted, not cited by line: `Plan.md:1373/2486/2777/2778` had all EXPIRED (+11 at the P28 audit, more since) — RETRACTED;
 * §6.1q.** §17's T-22-07 row: "No unintended horizontal scroll at 320/375/414/768 px"; §18's P22 table repeats the figures,
 * evidence "Playwright screenshots"; §20: "Every screen usable at 320 px without a horizontal scrollbar" and "Supported
 * viewports | 320 · 375 · 414 · 768 px, verified by screenshot". The widths are `playwright.config.ts`'s four projects.
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
  /*
    **Entered through Home rather than Explore, and the reason is R-82 rather than taste.**

    This test's subject is the three screens BELOW — the modal and the two pushed forms — and
    Explore was only the door to the first of them. At 320 px that door is shut: `explore-list`
    renders at height 0 because the screen's fixed siblings take 636 px of 513 (search 50, filters
    328, disclaimer 258), so a tap-through there measured nothing at the narrowest supported width
    and reported it as a failure of `meal-details-screen`.

    Home lists the three recommendations under the same `meal-<id>` ids, so the door moves and the
    three screens are measured at all four widths again. **The gap is not swallowed:** it has its
    own test at the end of this file, which asserts the Explore list is visible and is marked as a
    checked gap where it is not.
  */
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  const card = page.getByTestId('home-screen').locator('[data-testid^="meal-"]').first();
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

/**
 * **R-82: the Explore list is zero pixels tall at 320 px, and this is the marker.**
 *
 * `explore-screen` is 513 px at 320 x 568 — 568 less the 55 px tab bar — and its three
 * `flex-grow: 0` siblings already exceed it: the search field **50**, `explore-filters` **328**,
 * `explore-disclaimer` **258**, so **636 in 513**. The list has `flex: 1` and a `0%` basis (added
 * at P28, and measured to be genuinely applied), so it grows into what is left, and what is left
 * is nothing. It renders with `aria-label="20 meals"`: present, populated, announced, and
 * invisible. The whole catalogue is unreachable at the narrowest width `Plan.md` §20 supports.
 *
 * **Marked, not skipped, and not deleted.** `test.fail` turns this red the day the layout is
 * fixed, which is the only kind of known-gap marker this project accepts. A `test.skip` would
 * stay quiet forever and a deletion would lose the measurement.
 *
 * **The predicate came from a four-project run, not from reasoning about wrap points, and the
 * first guess was wrong.** `width < 768` was the obvious reading — R-72's clipping is phone-wide
 * and this looked like the same shape — and the run answered `Expected to fail, but passed` at
 * **both 375 and 414**: the filter chips wrap onto fewer rows there, so the fixed siblings fit
 * and the list keeps real height. **The gap is 320 alone.** A `test.fail` at a width that
 * actually passes fails the suite in the other direction, which is how R-44's marker came to be
 * recorded as a `test.fixme` that could never have turned red.
 *
 * **Why it is not fixed here:** the remedy is a decision about how much of a 568 px screen a
 * safety notice and three chip groups may claim, and the notice cannot simply become a
 * `ListHeaderComponent` because it is required in every state — including before the first
 * response, where there is no list to hang a header on. That is a design ruling, not a flex fix.
 */
test('the Explore list has height at every supported width (R-82)', async ({ page, app }) => {
  const width = page.viewportSize()?.width ?? 0;
  test.fail(width < 375, 'R-82: fixed siblings take 636 px of a 513 px screen at 320 px');

  await app();
  await page.getByRole('tab', { name: 'Explore' }).click();
  await expect(page.getByTestId('explore-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });

  // The list must EXIST before its height means anything: a screen that rendered no list at all
  // would satisfy a height assertion vacuously, and the loading state is a real state.
  const list = page.getByTestId('explore-list');
  await expect(list).toHaveCount(1, { timeout: FIRST_PAINT_MS });

  const height = await list.evaluate((node) => Math.round(node.getBoundingClientRect().height));
  // Asserted as a real number of pixels rather than through `toBeVisible`, so the failure message
  // carries the measurement: "expected 0 to be greater than 40" names the defect, while
  // "unexpected value hidden" names a symptom that has four possible causes.
  expect(
    height,
    `explore-list is ${String(height)} px tall at ${String(width)} px wide`,
  ).toBeGreaterThan(40);
});
