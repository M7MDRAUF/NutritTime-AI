import { writeFile } from 'node:fs/promises';
import { expect, test } from '../support/fixtures.js';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Every reachable screen with its text at 2x, asserted for clipping and photographed (T-23-03).
 *
 * T-23-03's acceptance is *"No clipping at the largest OS setting"*, evidence *"Screenshots"*;
 * `PRD.md` §10.5's bullet is *"Text scales with the device setting without clipping."* Thirteen
 * component suites and `ThemeProvider.dom.test.tsx` already render at 2x, but **no SCREEN was
 * rendered above `fontScale={1}`** and there were no screenshots. jsdom performs no layout, so a
 * component passing at 2x there is evidence about the component, not about a laid-out screen.
 *
 * **THE APP CANNOT RECEIVE AN OS TEXT SCALE IN THIS HARNESS, AND THAT BOUNDS EVERYTHING BELOW.**
 * Read from the shipped library rather than assumed (BRIEF §6.1j): `react-native-web` 0.21.2's
 * `dist/exports/Dimensions/index.js` hardcodes `fontScale: 1` in both the initial `dimensions`
 * object and in `update()`, and `Dimensions.set` runs `invariant(false, 'Dimensions cannot be set
 * in the browser')`; `dist/exports/PixelRatio/index.js` returns
 * `Dimensions.get('window').fontScale || PixelRatio.get()`, which is `1` before the `||` is
 * reached. So `ThemeProvider.tsx`'s `fontScale ?? windowFontScale ?? PixelRatio.getFontScale()`
 * resolves to **1 for every production caller on the web**, no browser setting moves it, and
 * `theme.isLargeText` (`scale >= 1.3`) is **unreachable in the web build** — the row-into-column
 * reflow seven components implement for PRD §10.5 never runs here.
 *
 * **So the scale is imposed on the RENDERED PAGE rather than handed to the app**: `font-size`,
 * `line-height` and `letter-spacing` are multiplied by 2 on every element that owns text — exactly
 * the triplet `ThemeProvider`'s `scaleVariant` multiplies, so the glyph metrics match a native
 * device at `fontScale: 2`. The one thing it cannot reproduce is `isLargeText`, which makes these
 * runs *stricter* than the native path rather than looser. What it is **not** is an OS setting, so
 * this is evidence about layout under 2x text, not about a device setting honoured end to end.
 *
 * **The observable is `text-clipping.spec.ts`'s, deliberately the same predicate** rather than a
 * second invention: for a text leaf, `scrollHeight` is the height the glyphs need and
 * `clientHeight` the height they are given, and since react-native-web's `Text` carries
 * `overflow: hidden` the difference is ink that was never drawn rather than a scrollbar. Box
 * geometry is blind to it — `viewport.spec.ts` walks every box, is right about what it claims, and
 * five tab labels were clipped at three widths while every box reported as fitting. That spec's
 * `clippedTextIn` is module-local, so it **cannot be imported** (and importing a spec would
 * register its tests into this suite). The extraction to `e2e/support/clipping.ts` is filed under
 * `## NEEDS-INTEGRATION` rather than performed — `e2e/support/**` is not this agent's to write —
 * because two copies of one measurement is how this project got three copies of one mapping with
 * two diverged.
 *
 * **The injected state is one a real browser can put a user in, measured rather than argued.**
 * Chromium's own minimum-font-size accessibility setting DOES reach px-specified text — launched
 * with `--blink-settings=minimumFontSize=32`, a `font-size: 10px` element computes at **32px** —
 * and react-native-web writes px everywhere. Under that flag the real tab label measures
 * `font-size 32px`, `needed 43`, `given 16`, with the tab bar still **54 px** tall, because the app
 * never learns the text grew. So enlarged text is reachable on the web through a browser setting
 * that bypasses the app entirely; what no browser offers is a *scale the app can read*. The sweep
 * still uses the injection rather than the flag: `launchOptions` is a worker option, so a flag
 * would apply to the whole file and cost the per-screen 1x control, and a minimum is a floor
 * rather than a scale — it would leave every heading above it untested.
 *
 * Screens are reached by **tapping**, never by URL, so a deep-link regression (R-44) cannot be
 * mistaken for a layout result; each measurement is **scoped to the screen's own container**,
 * because an inactive tab stays mounted underneath.
 */

/** A cold bundle plus the first request, not long enough to hang. `viewport.spec.ts`'s figure. */
const FIRST_PAINT_MS = 20_000;

/** `text-clipping.spec.ts`'s tolerance: a sub-pixel line box rounds against us, and half a pixel
 * is not ink a reader loses. Every clip this file has seen was 20 px or more. */
const SLACK_PX = 1;

/**
 * **2x, this project's own established figure, because no document names a largest.** PRD §10.5
 * says "the device setting" and gives no number; PRD, SDD, TSD and Plan.md name none, so inventing
 * one is out (BRIEF §9). 2x is what `testHarness.tsx`'s thirteen component suites and
 * `ThemeProvider.dom.test.tsx` use, and it is Android's accessibility maximum. iOS AX5 goes further
 * (~3.1x); that is recorded as a limitation, not silently claimed.
 */
const LARGEST_SCALE = 2;

/** A text-bearing leaf whose own box clips its own ink. `text-clipping.spec.ts`'s shape. */
interface ClippedText {
  readonly text: string;
  readonly needed: number;
  readonly given: number;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly height: string;
  readonly parentHeight: string;
}

interface Measurement {
  /** Text leaves inspected. A scope that matched nothing reports no clipping perfectly. */
  readonly texts: number;
  /** The largest font size in the scope, px. How this file proves the scale actually landed. */
  readonly largestFontPx: number;
  readonly clipped: readonly ClippedText[];
}

interface ScaleReport {
  readonly screen: string;
  readonly viewportWidth: number;
  readonly scale: number;
  readonly texts: number;
  /** Elements this call rewrote, inside this screen's own container. */
  readonly rewritten: number;
  readonly largestFontPxAt1x: number;
  readonly largestFontPxScaled: number;
  readonly clippedAt1x: readonly ClippedText[];
  readonly clippedScaled: readonly ClippedText[];
}

/**
 * Multiply the type triplet of every element that owns text.
 *
 * **Every value is read before any is written.** An inline `font-size` is inherited by a text leaf
 * inside the element carrying it, so a read-write-read-write walk would scale a nested leaf twice —
 * and 4x from a 2x request is the exact defect `AppText`'s `allowFontScaling={false}` exists to
 * prevent, so this file would reproduce a bug it is looking for. `line-height: normal` parses as
 * `NaN` and is left alone deliberately: a normal line box already grows with the font, and pinning
 * it in px would invent a metric the app never sets. A rewritten element carries a marker
 * attribute, so a second call over an overlapping scope compounds nothing.
 *
 * **Scoped to one screen's container rather than the document, so every row's 1x control is a real
 * 1x measurement.** The first version scaled document-wide, and the tab bar — measured after Home
 * — reported its "1x" numbers from an already-doubled page. Scoping also matches what is being
 * claimed: a screen's layout is asserted with that screen's own text enlarged.
 */
async function scaleText(page: Page, factor: number, scope: string): Promise<number> {
  return page.evaluate(({ scale, selector }) => {
    const ownsText = (node: Element): boolean =>
      [...node.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '',
      );
    const root = document.querySelector(selector);
    const pending: HTMLElement[] = [];
    for (const node of root === null ? [] : [root, ...root.querySelectorAll('*')]) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.dataset['textScaled'] === '1') continue;
      if (!ownsText(node)) continue;
      pending.push(node);
    }
    const plan = pending.map((node) => {
      const style = getComputedStyle(node);
      return {
        node,
        fontSize: Number.parseFloat(style.fontSize),
        lineHeight: Number.parseFloat(style.lineHeight),
        letterSpacing: Number.parseFloat(style.letterSpacing),
      };
    });
    let rewritten = 0;
    const px = (value: number): string => `${String(Math.round(value * 100) / 100)}px`;
    for (const item of plan) {
      if (!Number.isFinite(item.fontSize)) continue;
      item.node.style.setProperty('font-size', px(item.fontSize * scale), 'important');
      if (Number.isFinite(item.lineHeight)) {
        item.node.style.setProperty('line-height', px(item.lineHeight * scale), 'important');
      }
      if (Number.isFinite(item.letterSpacing)) {
        item.node.style.setProperty('letter-spacing', px(item.letterSpacing * scale), 'important');
      }
      item.node.dataset['textScaled'] = '1';
      rewritten += 1;
    }
    return rewritten;
  }, { scale: factor, selector: scope }); // prettier-ignore
}

/** `text-clipping.spec.ts`'s measurement over an arbitrary scope. Same predicate, same tolerance. */
async function measure(page: Page, scope: string, tolerance: number): Promise<Measurement> {
  return page.evaluate(
    ({ selector, slack }) => {
      const root = document.querySelector(selector);
      const clipped: ClippedText[] = [];
      let texts = 0;
      let largestFontPx = 0;
      for (const node of root === null ? [] : [root, ...root.querySelectorAll('*')]) {
        if (!(node instanceof HTMLElement)) continue;
        // Only leaves that actually carry words: a container's `scrollHeight` legitimately exceeds
        // its `clientHeight` whenever it scrolls, and those are not what this is about.
        const own = [...node.childNodes].some(
          (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '',
        );
        if (!own) continue;
        const style = getComputedStyle(node);
        texts += 1;
        largestFontPx = Math.max(largestFontPx, Number.parseFloat(style.fontSize));
        if (
          style.overflowY === 'visible' ||
          style.overflowY === 'auto' ||
          style.overflowY === 'scroll'
        )
          continue;
        if (node.scrollHeight > node.clientHeight + slack) {
          // `height` and the parent's are reported because `needed > given` says the ink is lost,
          // not WHY: a line box that grew and a box that was pinned are different fixes.
          const parent = node.parentElement;
          clipped.push({
            text: (node.textContent ?? '').trim().slice(0, 40),
            needed: node.scrollHeight,
            given: node.clientHeight,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            height: style.height,
            parentHeight: parent === null ? 'none' : getComputedStyle(parent).height,
          });
        }
      }
      return { texts, largestFontPx: Math.round(largestFontPx * 100) / 100, clipped };
    },
    { selector: scope, slack: tolerance },
  );
}

interface ScreenCheck {
  readonly name: string;
  readonly scope: string;
  /** A non-vacuity floor, stated well below what the screen renders. The control on the control. */
  readonly minTexts: number;
  readonly shot: boolean;
}

function screenAt(testID: string, minTexts: number, shot = true): ScreenCheck {
  return { name: testID, scope: `[data-testid="${testID}"]`, minTexts, shot };
}

/** The tab bar belongs to no screen and has its own test below, because it is the one surface
 * where 2x text loses ink. */
const TAB_BAR: ScreenCheck = { name: 'tab-bar', scope: '[role="tablist"]', minTexts: 5, shot: true }; // prettier-ignore

/**
 * Measure at 1x, impose the scale, measure again, photograph.
 *
 * **The 1x measurement is the control, not a warm-up.** Nothing in this repository measured
 * clipping on a SCREEN before this file — only on the tab bar — so an empty result at 1x beside an
 * empty one at 2x is a pair no constant satisfies, given that the probe below makes the same
 * measurement non-empty on the same screen.
 */
async function checkScreen(
  page: Page,
  info: TestInfo,
  check: ScreenCheck,
  bag: ScaleReport[],
): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const before = await measure(page, check.scope, SLACK_PX);
  const rewritten = await scaleText(page, LARGEST_SCALE, check.scope);
  const after = await measure(page, check.scope, SLACK_PX);
  bag.push({
    screen: check.name,
    viewportWidth: width,
    scale: LARGEST_SCALE,
    texts: after.texts,
    rewritten,
    largestFontPxAt1x: before.largestFontPx,
    largestFontPxScaled: after.largestFontPx,
    clippedAt1x: before.clipped,
    clippedScaled: after.clipped,
  });
  const at = `${check.name} at ${String(LARGEST_SCALE)}x, ${String(width)} px`;
  if (check.shot) {
    const name = `${check.name}-${String(LARGEST_SCALE)}x-${String(width)}.png`;
    const shot = info.outputPath(name);
    await page.screenshot({ path: shot });
    await info.attach(name, { path: shot, contentType: 'image/png' });
  }
  expect.soft(after.texts, `${at}: ${check.scope} matched no text`).toBeGreaterThanOrEqual(check.minTexts); // prettier-ignore
  // The scale has to be shown to have LANDED, or "no clipping at 2x" is a claim about a 1x page
  // (BRIEF §6.1k: prove the mutation executes before reporting a clean result).
  expect.soft(after.largestFontPx, `${at}: the scale did not reach this scope`).toBeCloseTo(before.largestFontPx * LARGEST_SCALE, 1); // prettier-ignore
  expect.soft(before.clipped, `${at}: text is clipped at 1x, before any scaling`).toEqual([]);
  expect.soft(after.clipped, `${at}: text is painted clipped`).toEqual([]);
}

async function record(info: TestInfo, bag: readonly ScaleReport[]): Promise<void> {
  const path = info.outputPath('font-scaling.json');
  await writeFile(path, JSON.stringify(bag, null, 2), 'utf8');
  await info.attach('font-scaling.json', { path, contentType: 'application/json' });
}

test('the five tab screens hold their text at 2x', async ({ page, app }, info) => {
  const bag: ScaleReport[] = [];
  await app();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('home-screen', 5), bag);

  for (const tab of ['Explore', 'Assistant', 'Saved', 'Settings'] as const) {
    await page.getByRole('tab', { name: tab }).click();
    const name = `${tab.toLowerCase()}-screen`;
    await expect(page.getByTestId(name)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await checkScreen(page, info, screenAt(name, 3), bag);
  }
  await record(info, bag);
});

/**
 * The three screens that are not tabs, each opened through the affordance a user has.
 *
 * **`DietarySetup` is reached through Settings rather than onboarding** — X-31's meal-time ordering
 * rule blocked an earlier spec from driving that form through a period change, and nothing here
 * submits it, so the rule is not in the way of measuring it. `MealForm` and `DietarySetup` both
 * cover the tab bar, so each is dismissed with browser Back before the next is opened.
 *
 * **The meal card is tapped on Home, not on Explore, and that is a live defect being routed around
 * rather than a preference.** At 320x568 `[data-testid="explore-list"]` renders with `aria-label="20
 * meals"` and a **zero-height box**, so Playwright reports it `hidden`: the first draft of this test
 * waited on it and timed out, and `viewport.spec.ts`'s equivalent test **fails on the same locator
 * at the same width** in the tree this was measured against — so the obstacle is the app's layout at
 * the shortest viewport, not this spec. It is reported, not fixed (it belongs to T-22-07's row and
 * to whoever owns that layout). `MealDetails` is the same screen from either origin — the `origin`
 * param changes only where dismissing returns to — so nothing about the measurement is weakened.
 */
test('the modal and the two pushed forms hold their text at 2x', async ({ page, app }, info) => {
  const bag: ScaleReport[] = [];
  await app();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  // Scoped to Home: every other tab's list carries the same `meal-<id>` ids once visited.
  const card = page.getByTestId('home-screen').locator('[data-testid^="meal-"]').first();
  await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
  await card.click();
  await expect(page.getByTestId('meal-details-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('meal-details-screen', 5), bag);
  await page.goBack();
  await expect(page.getByTestId('meal-details-screen')).toHaveCount(0, { timeout: FIRST_PAINT_MS });

  await page.getByRole('tab', { name: 'Saved' }).click();
  await expect(page.getByTestId('saved-new-meal')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await page.getByTestId('saved-new-meal').click();
  await expect(page.getByTestId('meal-form-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('meal-form-screen', 5), bag);
  await page.goBack();
  await expect(page.getByTestId('meal-form-screen')).toHaveCount(0, { timeout: FIRST_PAINT_MS });

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByTestId('settings-edit-preferences').click();
  await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await checkScreen(page, info, screenAt('dietary-setup-screen', 5), bag);
  await record(info, bag);
});

/**
 * The two surfaces an empty device shows, which no seeded spec can reach. The splash surface is
 * held by **delaying the font files rather than failing them**: `App.tsx` treats a font error as
 * ready, so an aborted `.ttf` would advance straight past this surface and measure onboarding in
 * fallback metrics, which is not the text a user gets.
 *
 * **Splash is the one row with no screenshot, and Playwright cannot take one.** `page.screenshot`
 * awaits `document.fonts.ready`, and the surface exists only while that promise is pending — the
 * wait cannot finish until the subject is gone. Asserted, never photographed; `viewport.spec.ts`
 * records the same limitation for the same surface.
 */
test('the cold-start surfaces hold their text at 2x', async ({ page, emptyDevice }, info) => {
  const bag: ScaleReport[] = [];
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
  await checkScreen(page, info, screenAt('splash-surface', 1, false), bag);

  releaseFonts();
  await expect(page.getByTestId('onboarding-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await page.unroute('**/*.ttf');
  await checkScreen(page, info, screenAt('onboarding-screen', 3), bag);
  await record(info, bag);
});

/**
 * The five tab labels, which are the one surface that loses ink at 2x — **a checked gap, not a
 * described one.**
 *
 * **R-72 is closed and this is not it.** That defect compressed the stacked label 14 -> 10 at
 * 320/375/414 px; `TabNavigator.tsx` now provisions the bar from the library's own metrics plus
 * `typography.label.lineHeight`, and this file re-measures **0 clipped at 1x at all four widths**
 * from a second spec, which is independent corroboration of that fix rather than a restatement.
 *
 * **What clips is 2x, and the cause is the header's:** the room provisioned for the label is
 * `typography.label.lineHeight`, which is `16 * theme.fontScale` — and `fontScale` is pinned at 1
 * in the web build, so the box stays 16 px while the glyphs need 27. On a native device the same
 * expression yields 32 and the bar grows with the text, which is what `TabNavigator.tsx`'s
 * docstring claims and what this measurement leaves standing: the fix is sound where the app can
 * see the scale. `test.fail` below 768 px is therefore a marker on the WEB gap, and it turns red
 * the day react-native-web reports a font scale or the bar stops being sized from one.
 *
 * At 768 px the labels sit beside their icons, where the library sets an explicit `lineHeight: 24`
 * that scales with the text — so both halves are claimed here: **clipped below 768, whole at 768**,
 * and either half changing reddens this test. Measured at 2x: `needed 27 / given 16` for all five
 * below 768, nothing at 768.
 */
test('the tab labels lose ink at 2x, and hold at 768 px', async ({ page, app }, info) => {
  const width = page.viewportSize()?.width ?? 0;
  test.fail(width < 768, 'the tab bar cannot grow for text the web build never learns about');
  await app();
  await expect(page.locator('[role="tab"]')).toHaveCount(5);
  // The claim is about all five: an empty tab bar would satisfy "nothing is clipped" perfectly.
  const bag: ScaleReport[] = [];
  await checkScreen(page, info, TAB_BAR, bag);
  // Reached even on the expected-failure path: `expect.soft` accumulates rather than throwing, so
  // the numbers behind the marker are written down rather than only appearing in a diff.
  await record(info, bag);
});

/**
 * The measurement, checked against text that is genuinely too tall for the box holding it. Without
 * this, "no screen clips at 2x" and "this assertion fires on nothing" are the same green run, and
 * the sweep above would look most convincing at the moment it stopped measuring anything.
 *
 * The squeeze is applied to the rendered page over the built artefact, so no repository file is
 * written (BRIEF §6.1i), and its target is found by walking the DOM rather than by guessing a
 * selector, so it cannot silently match nothing. 6 px against a 2x line box is a gap of tens of
 * pixels — far larger than R-72's four, so a pass here cannot be that defect re-reported.
 */
test('the assertion fires on text that is too tall for its box', async ({ page, app }) => {
  await app();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  const scope = '[data-testid="settings-screen"]';
  await scaleText(page, LARGEST_SCALE, scope);
  const before = await measure(page, scope, SLACK_PX);
  expect(before.clipped).toEqual([]);
  expect(before.texts).toBeGreaterThan(3);

  const squeezed = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    for (const node of root === null ? [] : root.querySelectorAll('*')) {
      if (!(node instanceof HTMLElement)) continue;
      const own = [...node.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '',
      );
      if (!own) continue;
      node.style.setProperty('height', '6px', 'important');
      node.style.setProperty('overflow-y', 'hidden', 'important');
      return (node.textContent ?? '').trim().slice(0, 40);
    }
    return '';
  }, scope);
  expect(squeezed).not.toBe('');

  const after = await measure(page, scope, SLACK_PX);
  expect(after.clipped.map((entry) => entry.text)).toContain(squeezed);
  const found = after.clipped.find((entry) => entry.text === squeezed);
  // The numbers a reader needs to act, not just a boolean.
  expect(found?.needed ?? 0).toBeGreaterThan((found?.given ?? 0) + 10);
});
