/**
 * T-12-12's linking config.
 *
 * Two things are worth a test here. The **scheme**, because a mismatch between `app.json` and the
 * prefix produces no error anywhere — links simply never arrive, on a device, months later. And
 * the **paths**, because a config that mirrors the navigator tree incorrectly also fails silently:
 * React Navigation returns `undefined` rather than complaining.
 *
 * `.dom.test.ts` and not a plain one: `getStateFromPath` comes from the real package, which
 * imports `react-native`, and only the `dom` project aliases that to `react-native-web`. No render
 * happens, so none of the harness's shims are needed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getActionFromState, getPathFromState, getStateFromPath } from '@react-navigation/native';
import { LINKING_PREFIX, LINKING_SCHEME, ROUTE_PATHS, linking } from './linking.js';
import { SCREEN_ROUTE_NAMES, readStringParam } from './routes.js';

/** `app.json` is the source of truth for the scheme; this reads it rather than restating it. */
function schemeFromManifest(): string | undefined {
  const manifestPath = path.resolve(import.meta.dirname, '../../app.json');
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('expo' in manifest)) {
    return undefined;
  }
  return readStringParam(manifest.expo, 'scheme');
}

const config = linking.config;

describe('the linking scheme', () => {
  it('is the scheme app.json declares', () => {
    // Not "is nutritime" — that would pass just as happily with app.json saying something else.
    expect(LINKING_SCHEME).toBe(schemeFromManifest());
  });

  it('is the only prefix, in URL form', () => {
    expect(LINKING_PREFIX).toBe(`${LINKING_SCHEME}://`);
    expect(linking.prefixes).toEqual([LINKING_PREFIX]);
  });

  /**
   * **Why `window.location.origin` is NOT in `prefixes`, stated as a measurement (R-44).**
   *
   * R-44 records adding it as "the obvious candidate" that "changed nothing", and left the cause
   * unidentified. It changed nothing because on the web `prefixes` is never consulted at all:
   * `useLinking`'s web implementation builds `location.pathname + location.search` and hands that
   * to `getStateFromPath` — a **path**, with the origin already stripped by the browser. A prefix
   * list exists to strip a scheme off a native `nutritime://explore` URL, and there is no such URL
   * on the web.
   *
   * So the two forms are parsed here side by side: the path the browser actually supplies resolves,
   * and the absolute URL an origin prefix would have had to handle resolves to nothing. Adding the
   * origin could therefore only ever have been inert, which is exactly what was observed — and
   * keeping it out is a decision this test now pins rather than a thing left undone.
   */
  it('is not needed on the web, because the browser supplies a path and not a URL', () => {
    window.history.replaceState({}, '', '/explore?query=chicken');
    // Precisely the expression `useLinking` (web) evaluates at the container's first mount.
    const browserPath = window.location.pathname + window.location.search;
    expect(browserPath).toBe('/explore?query=chicken');

    expect(getStateFromPath(browserPath, config)).toMatchObject({
      routes: [
        {
          name: 'Tabs',
          state: {
            routes: [
              { name: 'HomeTab' },
              {
                name: 'ExploreTab',
                state: { routes: [{ name: 'Explore', params: { query: 'chicken' } }] },
              },
            ],
          },
        },
      ],
    });

    // The absolute form is what a prefix strips. Nothing on the web ever produces it, and the
    // parser does not recognise it, so an origin in `prefixes` has nothing to act on.
    expect(getStateFromPath(`${window.location.origin}${browserPath}`, config)).toBeUndefined();
    window.history.replaceState({}, '', '/');
  });
});

describe('the route paths', () => {
  it('gives every screen a path, and no two the same', () => {
    const paths = SCREEN_ROUTE_NAMES.map((name) => ROUTE_PATHS[name]);

    /**
     * **`toHaveLength(SCREEN_ROUTE_NAMES.length)` used to stand here and could not fail.**
     * `paths` is a `map` OF `SCREEN_ROUTE_NAMES`, so its length is that array's length by
     * construction — deleting every entry in `ROUTE_PATHS` would have left this green.
     *
     * The claim the test's own name makes is that every screen HAS a path, and
     * `noUncheckedIndexedAccess` is what makes that a real question: `ROUTE_PATHS[name]` is
     * `string | undefined`, so a missing key is a silent `undefined` rather than a type error.
     * Asserting each entry is a non-empty string is the claim; the count never was.
     */
    for (const [index, path] of paths.entries()) {
      expect(path, SCREEN_ROUTE_NAMES[index]).toBeTypeOf('string');
      expect(path, SCREEN_ROUTE_NAMES[index]).not.toBe('');
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('uses the kebab-case slug of the page it opens', () => {
    // The same word names the file in design-system/pages/, the route, and the URL.
    expect(ROUTE_PATHS.DietarySetup).toBe('dietary-setup');
    expect(ROUTE_PATHS.MealForm).toBe('meal-form');
    for (const name of SCREEN_ROUTE_NAMES) {
      expect(ROUTE_PATHS[name]).toMatch(/^[a-z][a-z-]*(\/:[a-zA-Z]+)?$/);
    }
  });
});

describe('parsing a link', () => {
  it('routes a tab link through the tab navigator and its stack', () => {
    expect(getStateFromPath('home', config)).toMatchObject({
      routes: [
        {
          name: 'Tabs',
          state: { routes: [{ name: 'HomeTab', state: { routes: [{ name: 'Home' }] } }] },
        },
      ],
    });
  });

  it('reaches Settings directly, because the fifth tab is a screen and not a stack', () => {
    // No `SettingsTab` between `Tabs` and `Settings` — one level fewer than every other tab.
    expect(getStateFromPath('settings', config)).toMatchObject({
      routes: [{ name: 'Tabs', state: { routes: [{ name: 'HomeTab' }, { name: 'Settings' }] } }],
    });
  });

  /**
   * **`Tabs.initialRouteName` puts Home in the PARSE, and the old name of this test claimed more
   * than that** (T-22-04). It said "so a deep link is not a dead end", which is not what the line
   * does: a tab router rebuilds all five routes from `routeNames` and takes its history from the
   * partial state's `history` field, which a parse never supplies — measured identical with and
   * without this line under all six `backBehavior` values. The back target under a deep-linked tab
   * came from the router's default `backBehavior`, which `TabNavigator` now sets deliberately.
   *
   * What the line does do is the second assertion: `getActionFromState` emits `initial: false` for
   * the tab-level NAVIGATE **only** when the config names an initial route, and a nested navigator
   * rebuilds its state from the params only when `initial !== false`. So on `useLinking`'s action
   * path — going forward to a path it holds no record for — this is what stops an arriving link
   * from wiping the visited-tab history `backBehavior: 'history'` builds.
   */
  it('names an initial tab, so an arriving link does not reset the tab navigator', () => {
    const state = getStateFromPath('saved', config);
    expect(state).toMatchObject({
      routes: [{ name: 'Tabs', state: { routes: [{ name: 'HomeTab' }, { name: 'SavedTab' }] } }],
    });
    if (state === undefined) {
      return;
    }

    // `initial: true` is what a config with no `initialRouteName` produces here, and it is the
    // value that would throw the tab history away, so the assertion is on `false` specifically.
    expect(getActionFromState(state, config)).toMatchObject({
      type: 'NAVIGATE',
      payload: { name: 'Tabs', params: { initial: false, screen: 'SavedTab' } },
    });
  });

  /**
   * **The root config deliberately has NO `initialRouteName`, and this is the assertion that keeps
   * the decision visible** (T-22-04; the reasoning is in `linking.ts`).
   *
   * Adding one would make a cold `/meal-details/:id` parse as `[Tabs, MealDetails]`, and a stack —
   * unlike the tab navigator above — keeps the routes a parse gives it. It would not change
   * browser Back, which has one entry for a cold load either way; it would make `canGoBack()` true
   * and so retire `MealDetailsScreen`'s `origin` fallback and `MealFormScreen`'s Saved-tab
   * fallback, both of which choose a destination on purpose.
   */
  it('puts nothing underneath a cold-loaded modal, and invents no route for a bad path', () => {
    const state = getStateFromPath('meal-details/dessert-42', config);
    expect(state?.routes).toHaveLength(1);
    expect(getStateFromPath('meal-form', config)?.routes).toHaveLength(1);
    // The control: an `initialRouteName` at the root would not rescue an unknown path either, so
    // this stays `undefined` in both worlds and pins that no route is conjured for one.
    expect(getStateFromPath('not-a-screen', config)).toBeUndefined();
  });

  it('takes the meal id from the path', () => {
    expect(getStateFromPath('meal-details/dessert-42', config)).toMatchObject({
      routes: [{ name: 'MealDetails', params: { mealId: 'dessert-42' } }],
    });
  });

  it('takes optional params from the query string', () => {
    expect(getStateFromPath('meal-form?mealId=custom-7', config)).toMatchObject({
      routes: [{ name: 'MealForm', params: { mealId: 'custom-7' } }],
    });
    expect(getStateFromPath('meal-form', config)).toMatchObject({
      routes: [{ name: 'MealForm' }],
    });
    expect(getStateFromPath('explore?query=rice', config)).toMatchObject({
      routes: [
        {
          name: 'Tabs',
          state: {
            routes: [
              { name: 'HomeTab' },
              {
                name: 'ExploreTab',
                state: { routes: [{ name: 'Explore', params: { query: 'rice' } }] },
              },
            ],
          },
        },
      ],
    });
  });

  it('does not invent a route for a path it has no screen for', () => {
    expect(getStateFromPath('not-a-screen', config)).toBeUndefined();
  });
});

describe('printing a link', () => {
  it('round-trips a required path param, which is what makes the URL shareable', () => {
    const state = getStateFromPath('meal-details/dessert-42', config);
    expect(state).toBeDefined();
    if (state === undefined) {
      return;
    }
    expect(getPathFromState(state, config)).toBe('/meal-details/dessert-42');
  });
});
