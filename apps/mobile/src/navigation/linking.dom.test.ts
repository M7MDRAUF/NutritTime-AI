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
import { getPathFromState, getStateFromPath } from '@react-navigation/native';
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
});

describe('the route paths', () => {
  it('gives every screen a path, and no two the same', () => {
    const paths = SCREEN_ROUTE_NAMES.map((name) => ROUTE_PATHS[name]);
    expect(paths).toHaveLength(SCREEN_ROUTE_NAMES.length);
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

  it('leaves Home underneath another tab, so a deep link is not a dead end', () => {
    const state = getStateFromPath('saved', config);
    // `initialRouteName: 'HomeTab'` is what puts two routes in the tab state rather than one.
    expect(state).toMatchObject({
      routes: [{ name: 'Tabs', state: { routes: [{ name: 'HomeTab' }, { name: 'SavedTab' }] } }],
    });
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
