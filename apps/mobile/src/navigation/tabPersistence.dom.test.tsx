/**
 * `lastTab` — the writer, the restore, and the write that must NOT happen (T-18-01).
 *
 * **This file exists because two agents independently found that `uiActions.changeTab` had no
 * caller anywhere in the app.** The `ui` store was written and tested, `lastTab` had a schema, a
 * bound and a fallback — and nothing ever dispatched to it. T-18-01's acceptance is that the value
 * *persists*, which a store cannot satisfy on its own: something has to record the tab.
 *
 * The wiring lives in `TabNavigator`, so the proof has to as well, and it has to go through the
 * real tab bar. Three claims, and the third is the one no unit test could make:
 *
 *  1. Moving to a tab records that tab's **logical** id.
 *  2. A stored tab is the tab the app opens on.
 *  3. **Re-focusing the tab already stored queues no write at all.** `uiState.test.ts` proves the
 *     reducer returns `state` identically, which is the necessary half — but "identical state means
 *     no storage write" is a property of `createStore`'s projection effect, not of the reducer, and
 *     only a rendered provider can show it. W3-UI-STORE recorded that limitation explicitly rather
 *     than claiming coverage it did not have; this is the other half.
 *
 * Without (3) the invariant is decoration: every tab press would queue a write, and the reducer
 * test would still be green.
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { ThemeProvider } from '../shared/theme/ThemeProvider.js';
import { StorageProvider } from '../state/StorageProvider.js';
import { uiStore } from '../state/ui/index.js';
import { memoryDriver } from '../infrastructure/storage/__fixtures__/memoryDriver.js';
import type { MemoryDriver } from '../infrastructure/storage/__fixtures__/memoryDriver.js';
import { STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from '../infrastructure/storage/definitions.js';
import type { UiTab } from '../infrastructure/storage/definitions.js';
import { RootNavigator } from './RootNavigator.js';
import { TAB_ICONS } from './TabNavigator.js';
import { GLYPH_NAMES } from '../shared/components/Icon.js';
import { renderToDom } from './testHarness.js';

vi.mock('react-native-safe-area-context', async () => {
  const { createSafeAreaContextMock } = await import('./testHarness.js');
  return createSafeAreaContextMock();
});

const CLOCK = () => '2026-09-13T12:00:00.000Z';

/** A driver pre-loaded with a stored `ui` record, written the way the repository writes one. */
function driverWithLastTab(lastTab: UiTab | null): MemoryDriver {
  return memoryDriver({
    [STORAGE_KEYS.ui]: JSON.stringify({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      updatedAt: CLOCK(),
      value: { lastTab, disclaimerAcknowledged: false },
    }),
  });
}

function App({ driver }: { readonly driver: MemoryDriver }): ReactNode {
  return (
    <ThemeProvider mode="light" deviceScheme="light" fontScale={1}>
      <StorageProvider runtime={{ driver, now: CLOCK }}>
        <uiStore.Provider>
          <NavigationContainer>
            {/* `app`, because the tab bar exists only in that phase. */}
            <RootNavigator phase="app" />
          </NavigationContainer>
        </uiStore.Provider>
      </StorageProvider>
    </ThemeProvider>
  );
}

/** The tab button announcing `name`, found the way a user finds it. */
function tabButton(host: HTMLElement, name: string): HTMLElement {
  for (const tab of host.querySelectorAll('[role="tab"]')) {
    const clone = tab.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
      continue;
    }
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) {
      hidden.remove();
    }
    if ((clone.textContent ?? '').trim() === name && tab instanceof HTMLElement) {
      return tab;
    }
  }
  throw new Error(`no tab announces "${name}"`);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  // A second flush: the dispatch re-renders, and the projection effect that writes runs after.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function storedLastTab(driver: MemoryDriver): unknown {
  const raw = driver.store.get(STORAGE_KEYS.ui);
  if (raw === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('value' in parsed)) {
    return undefined;
  }
  const value: unknown = parsed.value;
  if (typeof value !== 'object' || value === null || !('lastTab' in value)) {
    return undefined;
  }
  return value.lastTab;
}

/** `setItem` calls against the `ui` key only — a `meta` write at boot must not be counted. */
function uiWrites(driver: MemoryDriver): number {
  return driver.calls.filter((one) => one === `setItem:${STORAGE_KEYS.ui}`).length;
}

describe('the selected tab is legible without colour', () => {
  it('pairs every tab with a DIFFERENT glyph for its selected state', () => {
    /**
     * **PRD §10.5, and this exists because fixing one accessibility defect created another.**
     *
     * The bar marked its selection by tint alone. That tint was `accent.brand`, which failed AA
     * against the bar at 3.77:1. Moving it to `content.link` fixed the contrast — and left the
     * active and inactive tones **1.01:1 apart**, because `content.tertiary` is itself a dark
     * 7.58:1. The two states became near-identical in lightness, separated only by hue, which a
     * deuteranope reads as much the same colour. WCAG measures against the ground rather than
     * between states, so it stayed conformant while ceasing to be usable.
     *
     * So the selected tab changes shape. Asserted against the **shipped font**, not against the two
     * names looking unlike each other: `homeFilled` and `home` are only a real distinction if
     * MaterialCommunityIcons gives them different codepoints, and a typo that mapped both to the
     * same glyph would otherwise read as a fix while changing nothing on screen.
     */
    const glyphs = GLYPH_NAMES;
    for (const [tab, pair] of Object.entries(TAB_ICONS)) {
      const active = glyphs[pair.active];
      const inactive = glyphs[pair.inactive];
      expect(active, `${tab}: no glyph for ${pair.active}`).toBeDefined();
      expect(inactive, `${tab}: no glyph for ${pair.inactive}`).toBeDefined();
      expect(active, `${tab} renders the same glyph selected and unselected`).not.toBe(inactive);
    }
  });

  it('covers every tab, so a new one cannot ship colour-only', () => {
    // Keyed on `UiTab`, so adding a tab without a glyph pair is a compile error; this is the
    // runtime half, and it fails if the table is emptied rather than extended.
    expect(Object.keys(TAB_ICONS).sort()).toEqual(
      ['assistant', 'explore', 'home', 'saved', 'settings'].sort(),
    );
  });
});

describe('lastTab', () => {
  it('records the LOGICAL id of the tab the user moved to, not the route name', async () => {
    const driver = driverWithLastTab(null);
    const view = await renderToDom(<App driver={driver} />);

    await press(tabButton(view.host, 'Explore'));

    // `'explore'`, never `'ExploreTab'`. `definitions.ts` stores a logical id so that a rename in
    // `routes.ts` cannot invalidate every user's stored tab, and this is the assertion that holds
    // the two apart — a `routeName.toLowerCase()` implementation fails here.
    expect(storedLastTab(driver)).toBe('explore');
    await view.unmount();
  });

  it('opens on the stored tab, and that tab is the one whose screen is mounted', async () => {
    const driver = driverWithLastTab('saved');
    const view = await renderToDom(<App driver={driver} />);

    // Nothing is registered for `Saved` in this suite, so the placeholder names the route — which
    // makes "which tab actually opened" readable rather than inferred from a highlight.
    expect(view.text()).toContain('Saved is not available yet');
    expect(view.text()).not.toContain('Home is not available yet');
    await view.unmount();
  });

  it('falls back to Home when no tab is stored', async () => {
    const driver = driverWithLastTab(null);
    const view = await renderToDom(<App driver={driver} />);

    expect(view.text()).toContain('Home is not available yet');
    await view.unmount();
  });

  it('suppresses the write when the opened tab already matches what is stored', async () => {
    /**
     * The claim `uiState.test.ts` cannot make: the reducer returning `state` identically is only
     * half of the invariant, and the other half — that an identical reference reaches no driver —
     * is a property of `createStore`'s projection effect, which only a rendered provider shows.
     *
     * **Two earlier versions of this test were wrong, and the second failure is a fact about
     * `createStore` worth knowing.**
     *
     *  1. It first re-pressed the already-focused tab and counted writes afterwards. React
     *     Navigation emits no `focus` for the tab you are already on, so nothing was dispatched and
     *     the assertion held whatever the reducer did — deleting the no-op branch left it green.
     *  2. It then asserted **zero** writes across the mount. Also false: `createStore`'s effect
     *     projects on its first run unconditionally, so **every store writes its own key back once
     *     at every launch**, rewriting what it has just read. The no-op branch therefore suppresses
     *     the SECOND write, not the first.
     *
     * So the property is stated as a comparison, which is what it actually is. `focus` fires for
     * the initial tab at mount, which is the one moment `changeTab` carries a value equal to what
     * is stored: that mount must write strictly fewer times than a mount whose tab differs.
     * Probed — with the no-op branch deleted both counts become 2 and this fails.
     */
    const matching = driverWithLastTab('explore');
    const matchingView = await renderToDom(<App driver={matching} />);
    expect(matchingView.text()).toContain('Explore is not available yet');
    const matchingWrites = uiWrites(matching);
    await matchingView.unmount();

    /**
     * The control, and it is not decoration: without it a navigator that never dispatched at all,
     * or a listener wired to nothing, would satisfy the suppression claim perfectly. No tab stored
     * means the app opens on Home and records `'home'`, which differs from `null` — a real change
     * that must reach the driver.
     */
    const differing = driverWithLastTab(null);
    const differingView = await renderToDom(<App driver={differing} />);
    const differingWrites = uiWrites(differing);

    expect(matchingWrites).toBeLessThan(differingWrites);
    expect(storedLastTab(matching)).toBe('explore');
    expect(storedLastTab(differing)).toBe('home');
    await differingView.unmount();
  });

  it('writes once per real change, and the last one wins', async () => {
    const driver = driverWithLastTab(null);
    const view = await renderToDom(<App driver={driver} />);

    await press(tabButton(view.host, 'Explore'));
    const afterFirst = uiWrites(driver);
    await press(tabButton(view.host, 'Settings'));

    // The control for the test above: a real change MUST reach the driver, or "no write on a
    // no-op" would be satisfied by a navigator that never wrote at all.
    expect(uiWrites(driver)).toBeGreaterThan(afterFirst);
    expect(storedLastTab(driver)).toBe('settings');
    await view.unmount();
  });
});
