/**
 * T-12-10. The route table's acceptance is a compile check — `ROUTE_KINDS` cannot be written
 * without covering every `RouteName` — so these tests cover what a compiler cannot see: that the
 * table holds the ten screens PRD §11 names and the five tabs it names, and that the deep-link
 * readers reject what a URL can actually produce.
 *
 * Plain `.test.ts`, no DOM: `routes.ts` imports nothing at runtime, which is the property that
 * lets it be read from a node test at all.
 */

import { describe, expect, it } from 'vitest';
import {
  BOOT_PHASES,
  CONTAINER_ROUTE_NAMES,
  NAVIGATION_ORIGINS,
  ROUTE_KINDS,
  SAVED_SECTIONS,
  SCREEN_ROUTE_NAMES,
  readStringParam,
  readUnionParam,
} from './routes.js';

describe('the route table', () => {
  it('holds exactly the ten screens PRD §11 names', () => {
    // Ten, not the nine of Plan §14.4's slug list: PRD outranks a Plan example, and
    // `design-system/pages/` has ten files. Splash is the tenth.
    expect([...SCREEN_ROUTE_NAMES]).toEqual([
      'Splash',
      'Onboarding',
      'DietarySetup',
      'Home',
      'Explore',
      'Assistant',
      'Saved',
      'MealForm',
      'MealDetails',
      'Settings',
    ]);
  });

  it('holds five containers: the tab navigator and the four per-tab stacks', () => {
    expect([...CONTAINER_ROUTE_NAMES]).toEqual([
      'Tabs',
      'HomeTab',
      'ExploreTab',
      'AssistantTab',
      'SavedTab',
    ]);
  });

  it('files every route under exactly one kind', () => {
    const screens: readonly string[] = SCREEN_ROUTE_NAMES;
    const containers: readonly string[] = CONTAINER_ROUTE_NAMES;

    expect(screens.filter((name) => containers.includes(name))).toEqual([]);
    // The runtime half of the compile check: no route is missing from the mirror, and none is
    // present in the mirror without being in one of the two lists.
    expect(Object.keys(ROUTE_KINDS).sort()).toEqual([...screens, ...containers].sort());
  });

  it('gives every screen kind "screen" and every container kind "container"', () => {
    for (const name of SCREEN_ROUTE_NAMES) {
      expect(ROUTE_KINDS[name]).toBe('screen');
    }
    for (const name of CONTAINER_ROUTE_NAMES) {
      expect(ROUTE_KINDS[name]).toBe('container');
    }
  });

  it('names the three boot phases of TSD §6.1 in boot order', () => {
    expect([...BOOT_PHASES]).toEqual(['hydrating', 'onboarding', 'app']);
  });

  it('names the four places a meal can be opened from, and the two saved sections', () => {
    expect([...NAVIGATION_ORIGINS]).toEqual(['home', 'explore', 'saved', 'assistant']);
    expect([...SAVED_SECTIONS]).toEqual(['favorites', 'custom']);
  });
});

describe('readStringParam', () => {
  it('returns a string param', () => {
    expect(readStringParam({ query: 'rice' }, 'query')).toBe('rice');
  });

  it('rejects an array, which is what a repeated query key produces', () => {
    // `?query=a&query=b`. There is no honest answer to which one was meant, so neither is given.
    expect(readStringParam({ query: ['a', 'b'] }, 'query')).toBeUndefined();
  });

  it('rejects a non-string, a missing key and a non-object', () => {
    expect(readStringParam({ query: 7 }, 'query')).toBeUndefined();
    expect(readStringParam({}, 'query')).toBeUndefined();
    expect(readStringParam(undefined, 'query')).toBeUndefined();
    expect(readStringParam('rice', 'query')).toBeUndefined();
    expect(readStringParam(null, 'query')).toBeUndefined();
  });

  it('does not read an inherited key', () => {
    // A link cannot reach `toString` or anything else off the prototype and have it pass for a
    // param: the reader copies own properties only.
    expect(readStringParam({ query: 'rice' }, 'constructor')).toBeUndefined();
    expect(readStringParam(Object.create({ query: 'inherited' }), 'query')).toBeUndefined();
  });
});

describe('readUnionParam', () => {
  it('returns a value that is in the allowed set', () => {
    expect(readUnionParam({ section: 'custom' }, 'section', SAVED_SECTIONS)).toBe('custom');
    expect(readUnionParam({ origin: 'explore' }, 'origin', NAVIGATION_ORIGINS)).toBe('explore');
  });

  it('rejects a value outside the set, and anything that is not a string', () => {
    expect(readUnionParam({ section: 'archived' }, 'section', SAVED_SECTIONS)).toBeUndefined();
    expect(readUnionParam({ section: ['favorites'] }, 'section', SAVED_SECTIONS)).toBeUndefined();
    expect(readUnionParam({}, 'section', SAVED_SECTIONS)).toBeUndefined();
  });
});
