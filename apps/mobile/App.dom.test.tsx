/**
 * The composition root, EXECUTED — `apps/mobile/App.tsx` (T-22-03, R-44).
 *
 * **R-44 lived in this file for nine phases and nothing in the unit or dom suites could see it.**
 * Restoring the defect — `<RootNavigator phase={fontsReady ? phase : 'hydrating'} />` back inside
 * the container — reddened zero Vitest tests: `RootNavigator.dom.test.tsx` makes the same claims
 * against a *replica* of this wiring, so a change to the real composition cannot fail it. This
 * file imports the real default export, which is the whole difference.
 *
 * What is pinned, and why each needs a rendered tree rather than a review note:
 *
 *  1. **The container mounts ONCE, and not before the boot phase is settled.** "A container
 *     exists" is satisfied by the defect. What separates them is *when* it mounted and *how many
 *     times*, so both are counted across the fonts-resolving transition, and the route set the
 *     navigator held at the container's first ready is recorded — TSD §6.1's "a protected screen
 *     cannot render early, there is no redirect for hydration to lose a race with", observed at
 *     the one instant it has to hold.
 *  2. **The hydration gate and the font gate are different gates.** Each is held on its own with
 *     the other already resolved, and each window asserts the invisible half — no container has
 *     mounted, so no URL has been consumed — beside the visible one. Delete one gate and exactly
 *     one window reddens: the fix moved one and had to leave the other alone.
 *  3. **The provider order**, through what depends on it rather than through the shape of the
 *     tree: a store hoisted above the reset boundary throws, and the font-wait splash is themed
 *     by the STORED mode.
 *
 * Three seams are substituted, each a boundary this app already injects elsewhere: the font
 * loader, the AsyncStorage driver (`App.tsx` takes no `runtime` prop, so its module is the only
 * injection point) and a pass-through spy around `NavigationContainer` that renders the real
 * container and only records. Nothing here is a snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
// A namespace TYPE import: `@typescript-eslint/consistent-type-imports` forbids the `import()`
// annotation `importOriginal<…>` is usually written with.
import type * as Navigation from '@react-navigation/native';
import type { ThemeMode } from '@nutritime/contracts';
import App from './App.js';
import type { RootParamList } from './src/navigation/routes.js';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from './src/infrastructure/storage/definitions.js';
import { encodeEnvelope } from './src/infrastructure/storage/envelope.js';
import { colorsByScheme } from './src/shared/theme/index.js';
import { asRendered } from './src/shared/components/testHarness.js';

const AT = '2026-09-13T12:00:00.000Z';

/**
 * Everything the `vi.mock` factories need, hoisted above them — a factory runs while this module's
 * own imports are still executing, so it cannot see a `const` from the body.
 */
const seam = vi.hoisted(() => {
  /**
   * ONE snapshot for both of `useFonts`' return values, and not as a shortcut.
   *
   * The first version kept `loaded` and `error` in two variables and subscribed
   * `useSyncExternalStore` to `loaded` alone, so a font FAILURE changed nothing React could see
   * and the failure case timed out against a double that had not moved.
   */
  const listeners = new Set<() => void>();
  let status: 'pending' | 'loaded' | 'failed' = 'pending';
  const failure = new Error('the faces did not arrive');
  const move = (next: typeof status): void => {
    status = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };

  /** The house `memoryDriver` is attached by the driver mock below, which can import it. */
  let store: Map<string, string> | null = null;
  let open: (() => void) | null = null;
  let gate: Promise<void> | null = null;

  const container = {
    mounts: 0,
    unmounts: 0,
    /** The navigator's route set at the container's FIRST ready — R-44's whole question. */
    routeNames: null as readonly string[] | null,
    focused: undefined as string | undefined,
  };

  return {
    fonts: {
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      status: (): 'pending' | 'loaded' | 'failed' => status,
      failure,
      resolve: (): void => move('loaded'),
      /** `useFonts` reports a failure rather than throwing, so the double reports one too. */
      fail: (): void => move('failed'),
    },
    storage: {
      attach: (attached: Map<string, string>): void => {
        store = attached;
      },
      keys: (): Map<string, string> => {
        if (store === null) {
          throw new Error('the driver mock never attached its store');
        }
        return store;
      },
      /** Hold the one `multiGet`, so the hydrating window is observable rather than instant. */
      hold: (): void => {
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
      },
      release: (): void => {
        open?.();
        gate = null;
      },
      wait: async (): Promise<void> => {
        if (gate !== null) {
          await gate;
        }
      },
    },
    container,
    reset: (): void => {
      store?.clear();
      gate = null;
      open = null;
      status = 'pending';
      listeners.clear();
      container.mounts = 0;
      container.unmounts = 0;
      container.routeNames = null;
      container.focused = undefined;
    },
  };
});

vi.mock('expo-font', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useFonts: (): readonly [boolean, Error | null] => {
      const status = useSyncExternalStore(
        seam.fonts.subscribe,
        seam.fonts.status,
        seam.fonts.status,
      );
      // `loaded` stays FALSE on a failure, exactly as expo-font 57's `useRuntimeFonts` leaves it:
      // it sets one state or the other and never both. `App.tsx`'s `fontsLoaded || fontError !==
      // null` is the whole reason that distinction matters.
      return [status === 'loaded', status === 'failed' ? seam.fonts.failure : null];
    },
  };
});

vi.mock('react-native-safe-area-context', async () => {
  const { createSafeAreaContextMock } = await import('./src/navigation/testHarness.js');
  return createSafeAreaContextMock();
});

/**
 * The device seam TSD §2.3 confines to one file, replaced by the house fake rather than a second
 * one written here — `memoryDriver`'s own docstring is that two copies drift and the copy that
 * drifted is the one making a test pass. Only `multiGet` is wrapped, to hold hydration open.
 */
vi.mock('./src/infrastructure/storage/asyncStorageDriver.js', async () => {
  const fixture = await import('./src/infrastructure/storage/__fixtures__/memoryDriver.js');
  const driver = fixture.memoryDriver({});
  seam.storage.attach(driver.store);
  return {
    asyncStorageDriver: {
      ...driver,
      multiGet: async (
        keys: readonly string[],
      ): Promise<readonly (readonly [string, string | null])[]> => {
        await seam.storage.wait();
        return driver.multiGet(keys);
      },
    },
    systemClock: (): string => AT,
  };
});

/**
 * A pass-through spy, not a stub: it renders the REAL `NavigationContainer` and records the three
 * things no structural assertion can distinguish — how many times it mounted, the route set the
 * navigator held when it first became ready, and the focused route.
 */
vi.mock('@react-navigation/native', async (importOriginal) => {
  const actual = await importOriginal<typeof Navigation>();
  const { useEffect, useRef } = await import('react');
  const Real = actual.NavigationContainer;

  // The bare `typeof Navigation.NavigationContainer` instantiates the container's generic at its
  // CONSTRAINT (`{}`), where `getCurrentRoute()` is typed `undefined` and the ref stops matching
  // the app's route table. The instantiation expression pins it to what `App.tsx` renders it with.
  function Observed(
    props: ComponentProps<typeof Navigation.NavigationContainer<RootParamList>>,
  ): ReactNode {
    const ref = useRef<Navigation.NavigationContainerRef<RootParamList> | null>(null);
    useEffect(() => {
      seam.container.mounts += 1;
      return () => {
        seam.container.unmounts += 1;
      };
    }, []);
    const record = (): void => {
      const api = ref.current;
      const state = api?.getRootState();
      if (api === null || state === undefined) {
        return;
      }
      seam.container.routeNames ??= [...state.routeNames];
      seam.container.focused = api.getCurrentRoute()?.name;
    };
    // Both hooks are CHAINED rather than claimed: `App.tsx` passes neither today, and a spy that
    // swallowed a prop the subject started passing would be a silent hole in the subject.
    return (
      <Real
        {...props}
        ref={ref}
        onReady={() => {
          record();
          props.onReady?.();
        }}
        onStateChange={(state) => {
          record();
          props.onStateChange?.(state);
        }}
      />
    );
  }

  return { ...actual, NavigationContainer: Observed };
});

const roots: Root[] = [];

/** A device that has finished onboarding and stored `mode`, so `app` is the phase at boot. */
function seedDevice(mode: ThemeMode): void {
  const put = (key: string, value: unknown): void => {
    seam.storage.keys().set(key, encodeEnvelope(STORAGE_SCHEMA_VERSION, value, AT));
  };
  put(STORAGE_KEYS.onboarding, { completed: true });
  put(STORAGE_KEYS.preferences, { ...DEFAULT_PREFERENCES, themeMode: mode });
  // A RIVAL stored tab, so a screen that opens because a URL named it cannot be mistaken for one
  // that opened because `ui.lastTab` did — the coincidence R-44's "a path does restore" was.
  put(STORAGE_KEYS.ui, { lastTab: 'saved', disclaimerAcknowledged: false });
}

/**
 * Flush until `done`: hydration, each store's projection effect and `useThenable` resolve on
 * different microtask turns, and a fixed pass count either wastes time or races. No predicate
 * means "let everything pending run".
 */
async function settle(done: () => boolean = () => true, what = 'settle'): Promise<void> {
  for (let pass = 0; pass < 25; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (done()) {
      return;
    }
  }
  throw new Error(what);
}

async function mountApp(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<App />);
  });
}

/** The hydrating surface, by the test id `SplashSurface` sets. Both gates render it. */
function splashOnScreen(): boolean {
  return document.querySelector('[data-testid="splash-surface"]') !== null;
}

/** Its ground, through jsdom's parser so a token and a rendered fill compare as equals. */
function splashGround(): string {
  const splash = document.querySelector('[data-testid="splash-surface"]');
  if (!(splash instanceof HTMLElement)) {
    throw new Error('no splash surface rendered');
  }
  return globalThis.getComputedStyle(splash).backgroundColor;
}

/** What a user copies out of the address bar, in the form web `useLinking` reads it back. */
function addressBar(): string {
  return window.location.pathname + window.location.search;
}

beforeEach(() => {
  seam.reset();
  window.history.replaceState({}, '', '/');
});

afterEach(async () => {
  // Every root is unmounted. `useLinking` keeps a module-scope handler list and logs "linking
  // configured in multiple places" to `console.error` when a container from an earlier case is
  // still mounted, and the address bar is global to the document — a leftover path would let a
  // later case pass for the wrong reason.
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
});

describe('the hydration gate', () => {
  it('mounts no navigator while the one multiGet is in flight, and shows the splash', async () => {
    /**
     * Fonts are already in, so hydration alone holds the first paint. TSD §6.1 guarantees "during
     * `hydrating` those screens are not in the navigator at all"; this composition is stronger —
     * there is no navigator — and that is what is asserted, because a phase a screen could ignore
     * is not a gate. Removing `fallback={<HydratingSplash />}` reddens the splash half and leaves
     * the font gate's window green, which is the separation property 3 wants.
     */
    seam.fonts.resolve();
    seedDevice('light');
    seam.storage.hold();

    await mountApp();
    await settle();

    expect(seam.container.mounts, 'a navigator mounted during hydration').toBe(0);
    expect(splashOnScreen(), 'nothing was on screen during hydration').toBe(true);

    seam.storage.release();
    await settle(() => seam.container.mounts > 0, 'the navigator never mounted after hydration');
    expect(seam.container.mounts).toBe(1);
  });
});

describe('the font gate', () => {
  it('mounts no navigator while the faces load, and shows the splash', async () => {
    /**
     * The mirror image: hydration resolves immediately, the faces do not. On the web that is the
     * NORMAL cold-start ordering — hydration is a synchronous `localStorage` read and the faces
     * are a network fetch — which is why R-44 reproduced on every load rather than sometimes.
     * Deleting the font gate reddens this and leaves the hydration window green.
     */
    seedDevice('light');

    await mountApp();
    await settle();

    expect(seam.container.mounts, 'the container mounted before the faces arrived').toBe(0);
    expect(splashOnScreen()).toBe(true);

    seam.fonts.resolve();
    await settle(() => seam.container.mounts > 0, 'the navigator never mounted after the fonts');
    expect(seam.container.mounts).toBe(1);
  });

  it('advances on a font FAILURE, so a typeface cannot brick the app', async () => {
    /**
     * `fontsReady` is `fontsLoaded || fontError !== null` (R-32). Gating on `fontsLoaded` alone
     * holds the splash for ever on a device where the load failed — a blank screen with no way
     * out, caused by a typeface — and until now the docstring was the only evidence that branch
     * existed.
     */
    seedDevice('light');

    await mountApp();
    await settle();
    expect(seam.container.mounts).toBe(0);

    seam.fonts.fail();
    await settle(() => seam.container.mounts > 0, 'a failed font load held the splash for ever');
    expect(seam.container.mounts).toBe(1);
  });
});

describe('a cold URL through the real App', () => {
  it('reaches the screen the URL names, once the phase has settled', async () => {
    /**
     * **R-44, end to end, through the real composition. This is the acceptance.**
     *
     * `NavigationContainer` resolves the URL exactly once: `useLinking`'s `getInitialState` is a
     * `useCallback` with an empty dependency array, `useThenable` resolves it at the first mount,
     * and the result reaches `BaseNavigationContainer` as `initialState`. `StackRouter` then
     * filters that state through its own `routeNames`, so a container mounted while the stack
     * holds only `Splash` discards the parsed `Tabs` route and never goes back for it.
     *
     * Four independent facts, because no single mechanism satisfies all four: the route set at the
     * container's first ready, the mount count, the screen reached, and the address bar. Restoring
     * the defect reddens the first, third and fourth; a container that remounted on the fonts
     * transition reddens only the second.
     *
     * **Deliberately NO "nothing has mounted yet" assertion before the fonts resolve.** That is
     * the font-gate case's claim, and asserting it here as well cost real evidence: under the
     * restored defect this test aborted on the mount count and the three assertions R-44 is
     * actually about never ran.
     */
    seedDevice('light');
    window.history.replaceState({}, '', '/settings');

    await mountApp();
    await settle();
    seam.fonts.resolve();
    await settle(() => seam.container.focused !== undefined, 'the navigator never became ready');

    // The phase was ALREADY settled at the container's first mount: `Tabs` exists and `Splash`
    // does not. Under the defect this reads `['Splash']`.
    expect(seam.container.routeNames).toContain('Tabs');
    expect(seam.container.routeNames).not.toContain('Splash');
    expect(seam.container.mounts, 'the container mounted more than once').toBe(1);

    expect(seam.container.focused, '/settings did not open Settings').toBe('Settings');
    // The other half of R-44's symptom, and the half a user copies: the URL was **rewritten** to
    // `/home`, not merely ignored. A successful restore changes no state and so rewrites nothing.
    expect(addressBar(), '/settings survived on screen but not in the address bar').toBe(
      '/settings',
    );
    // And the REAL screen rather than the placeholder, which is what `registerScreens()` at
    // `App.tsx`'s module scope — before anything renders — is the claim that makes true.
    expect(document.body.textContent ?? '').not.toContain('is not available yet');
  });

  it('carries a query param into the screen the URL names', async () => {
    // A second path, in a different tab, with a param — so "always opens Settings" cannot satisfy
    // the row above.
    seedDevice('light');
    window.history.replaceState({}, '', '/explore?query=chicken');

    await mountApp();
    seam.fonts.resolve();
    await settle(() => seam.container.focused !== undefined, 'the navigator never became ready');

    expect(seam.container.focused).toBe('Explore');
    expect(addressBar()).toBe('/explore?query=chicken');
  });
});

describe('the provider spine', () => {
  it('keeps every store provider inside the reset boundary', async () => {
    /**
     * Asserted through what depends on the order rather than through the shape of the tree. A
     * store provider hoisted above `DataResetProvider` calls `useStorageContext()` with nothing
     * above it and throws **"a store was used outside a StorageProvider"** — louder than any
     * structural snapshot, and the reordering `DataResetProvider`'s docstring calls fatal: a store
     * above the unmount survives it holding the data the user asked to destroy.
     */
    seedDevice('light');
    seam.fonts.resolve();

    await mountApp();
    await settle(() => seam.container.focused !== undefined, 'the spine reached no navigator');

    expect(seam.container.mounts).toBe(1);
  });

  it('themes the font-wait splash from the STORED mode, not from system', async () => {
    /**
     * `App.tsx` answers "why not gate higher up, in `App`?" with T-18-04: `HydratingSplash` calls
     * `useTheme()`, and the *stored* theme only exists below `ThemedNavigation`. Gating one level
     * up would paint the font-wait splash in `system` while the user had chosen dark. jsdom
     * reports no `prefers-color-scheme`, so `system` resolves to light — which makes a stored
     * `dark` unambiguous. Paired with the light case below, so no constant satisfies both.
     */
    seedDevice('dark');

    await mountApp();
    await settle(splashOnScreen, 'the font-wait splash never rendered');

    expect(splashGround()).toBe(asRendered(colorsByScheme.dark.surface.canvas));
    expect(splashGround()).not.toBe(asRendered(colorsByScheme.light.surface.canvas));
  });

  it('themes it light when light is what was stored', async () => {
    seedDevice('light');

    await mountApp();
    await settle(splashOnScreen, 'the font-wait splash never rendered');

    expect(splashGround()).toBe(asRendered(colorsByScheme.light.surface.canvas));
  });
});
