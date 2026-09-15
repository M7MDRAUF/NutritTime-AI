/**
 * T-23-01 — every interactive element the app renders has an accessibility role AND an accessible
 * name. PRD §10.5, first bullet: "Every control has an accessibility role and label." This is the
 * executable half of the audit table at `docs/accessibility-roles.md`, which carries the per-row
 * inventory, the timestamp and the files that were in flight when it was measured.
 *
 * **The definition of "interactive" is the whole test, so it is stated where it can be argued
 * with.** An element is interactive when the RENDERED DOM makes it operable: (1) it is a native
 * form control — `input`, `textarea`, `select`, `button`, `a[href]`; or (2) it carries
 * `tabindex="0"`, which is what react-native-web 0.21.2 puts on an enabled `Pressable`; or (3) it
 * carries one of ARIA 1.2's **standalone** widget roles (`INTERACTIVE_ROLES`).
 *
 * (3) is not redundant with (2), and the reason is measured rather than assumed: a `disabled`
 * `Pressable` renders `tabindex="-1"`, so a definition resting on `tabindex >= 0` alone would drop
 * every disabled control — and a disabled control still has to announce what it is. `disabled` on
 * `AccessibleButton`, `Chip` and `IconButton` each render `tabindex="-1"` here.
 *
 * **What it excludes, and why neither exclusion can be widened quietly.** A role that is
 * structure, a landmark, a live region or a composite CONTAINER is not a control — PRD §10.5
 * governs controls, and a `tablist` is not operated while its five `tab` children are, each
 * enumerated in its own right. Every such role met is in `NOT_A_CONTROL` with its reason, and that
 * map is asserted CLOSED: a role the app renders that is neither operable nor listed reddens this
 * file until someone classifies it. Separately, anything outside the accessibility tree (an
 * `aria-hidden` ancestor, or `role="presentation"`) has no name to announce — and `outsideTree`
 * COUNTS those per surface instead of filtering them away, so an unnamed control cannot be made to
 * disappear by acquiring one of those attributes. Both guards exist because of §23's own history,
 * where a coverage check collapsed the two directions of a pairing and 218 green theme tests sat
 * on top of a live WCAG failure.
 *
 * **Why this enumerates a render and not the source** (`docs/final-audit.md`, failure shape 1): a
 * registration test once read `register.ts` as source text, so an early `return` that dropped
 * every screen in the app to a placeholder left 2012 tests green. A grep for `accessibilityLabel=`
 * passes just as happily on a screen that renders nothing.
 *
 * **Why the counts** — T-19-09's lesson on this axis: an enumeration of zero elements satisfies
 * "all of them have a name" perfectly. So every surface carries the number of controls it must
 * produce, the one surface that legitimately has none is named, and that list is asserted in both
 * directions. The bound is a MINIMUM: a sibling adding a control is not a defect; losing one is.
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent, getRoles, queryAllByRole } from '@testing-library/dom';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { ApiProvider } from '../../infrastructure/api/ApiProvider.js';
import { ApiClientError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import { DataResetProvider } from '../../features/settings/DataResetProvider.js';
import { memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import { STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from '../../infrastructure/storage/definitions.js';
import { encodeEnvelope } from '../../infrastructure/storage/envelope.js';
import { customMeal } from '../../state/customMeals/__testing__/customMealFixture.js';
import { preferencesStore } from '../../state/preferences/index.js';
import { onboardingStore } from '../../state/onboarding/index.js';
import { favoritesStore } from '../../state/favorites/index.js';
import { customMealsStore } from '../../state/customMeals/index.js';
import { uiStore } from '../../state/ui/index.js';
import { registerScreens } from '../../features/register.js';
import { registeredScreen } from '../../navigation/registry.js';
import type { ScreenRouteName } from '../../navigation/routes.js';
import { RootNavigator } from '../../navigation/RootNavigator.js';
import { ErrorBoundary } from '../../navigation/ErrorBoundary.js';
import {
  AccessibleButton,
  Chip,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  MealCard,
  OfflineState,
  SearchField,
  StatusMessage,
  Toast,
} from './index.js';

vi.mock('react-native-safe-area-context', async () => {
  const { createSafeAreaContextMock } = await import('../../navigation/testHarness.js');
  return createSafeAreaContextMock();
});

registerScreens();

const noop = (): void => undefined;

// ---------------------------------------------------------------- the definition, spelled out

/**
 * ARIA 1.2's widget roles, minus the composite CONTAINERS (`grid`, `listbox`, `menu`, `menubar`,
 * `radiogroup`, `tablist`, `tree`, `treegrid`, `tabpanel`), which are not themselves operated, and
 * minus `progressbar`/`separator`, which are read-only. `combobox` stays: it is both a container
 * and the control the user types into.
 */
const INTERACTIVE_ROLES: readonly string[] =
  `button checkbox combobox gridcell link menuitem menuitemcheckbox menuitemradio option radio
   scrollbar searchbox slider spinbutton switch tab textbox treeitem`.split(/\s+/);

/**
 * Every role the enumeration meets and does NOT treat as a control, grouped by the reason. `main`,
 * `region`, `list` and `listitem` are listed ahead of the surfaces that will carry them — a
 * landmark and a form error summary are being added elsewhere in this tree as this is written.
 */
const NOT_A_CONTROL = new Map<string, string>(
  (
    [
      ['generic', 'a plain View with no role of its own'],
      ['presentation none', 'explicitly removed from the accessibility tree'],
      ['heading img paragraph list listitem', 'structure, not a control'],
      ['alert status log', 'a live region — its insertion is the announcement'],
      ['toolbar search tablist dialog', 'a container; the controls inside it are enumerated'],
      ['main region banner navigation contentinfo', 'a landmark'],
      ['progressbar separator', 'a read-only widget with nothing to operate'],
    ] as const
  ).flatMap(([roles, why]) => roles.split(' ').map((role) => [role, why] as [string, string])),
);

/** react-native-web renders `TextInput` as a bare `input`/`textarea`, carrying no `type`. */
const IMPLICIT_ROLE: Readonly<Record<string, string>> = {
  INPUT: 'textbox',
  TEXTAREA: 'textbox',
  BUTTON: 'button',
  SELECT: 'combobox',
  A: 'link',
};

function roleOf(el: Element): string | undefined {
  return el.getAttribute('role') ?? IMPLICIT_ROLE[el.tagName];
}

function isOperable(el: Element): boolean {
  const tabIndex = el.getAttribute('tabindex');
  const role = el.getAttribute('role');
  return (
    IMPLICIT_ROLE[el.tagName] !== undefined ||
    (tabIndex !== null && Number(tabIndex) >= 0) ||
    (role !== null && INTERACTIVE_ROLES.includes(role))
  );
}

/** Not in the accessibility tree, so it has no role and no name to have. Counted, never dropped. */
function outsideTree(el: Element): boolean {
  const role = el.getAttribute('role');
  const hidden = el.closest('[aria-hidden="true"]');
  return role === 'presentation' || role === 'none' || hidden !== null;
}

interface Enumerated {
  readonly controls: readonly Element[];
  readonly untreed: readonly Element[];
  readonly roles: readonly string[];
  /** Computed by `@testing-library/dom`'s own accessible-name algorithm, not by this file. */
  readonly named: ReadonlySet<Element>;
}

function enumerate(root: HTMLElement): Enumerated {
  const operable = [...root.querySelectorAll('*')].filter(isOperable);
  const named = new Set<Element>();
  const roles = Object.keys(getRoles(root));
  for (const role of roles) {
    for (const el of queryAllByRole(root, role, { name: /\S/, hidden: true })) {
      named.add(el);
    }
  }
  const controls = operable.filter((el) => !outsideTree(el));
  return { controls, untreed: operable.filter(outsideTree), roles, named };
}

// --------------------------------------------------------------------------- the rendered tree

const CATALOG: readonly Meal[] = (seededCatalog as unknown[]).map((row) => mealSchema.parse(row));
const AT = '2026-09-13T12:00:00.000Z';
const CUSTOM = customMeal();
const ORPHAN_ID = 'a-meal-the-catalog-lost';

/** Typed `Meal` rather than `Meal | undefined`, so the narrowing survives into every closure. */
function firstSeededMeal(): Meal {
  const first = CATALOG[0];
  if (first === undefined) {
    throw new Error('the seeded catalog is empty, so no screen here renders a meal');
  }
  return first;
}
const FIRST: Meal = firstSeededMeal();

/** A 404 is what makes a favourite an *orphan* rather than a failed request — `favoritesFeed.ts`. */
const NOT_FOUND = new ApiClientError({
  kind: 'server',
  status: 404,
  code: 'NOT_FOUND',
  retryable: false,
  wire: null,
  route: 'getMeal',
});

const RECOMMENDED = CATALOG.slice(0, 2).map((meal) => ({
  meal,
  score: 10,
  scoreReasons: [],
  explanation: 'Fits your preferences.',
  explanationSource: 'fallback' as const,
}));

const client: ApiClient = {
  // A FULL page of 20 against a total of 60, because `isLastPage` reads a short page as the last
  // one — a three-meal stub leaves Explore's "Show more meals" footer unrendered, and so unread.
  listMeals: () =>
    Promise.resolve({ meals: CATALOG.slice(0, 20), page: 1, pageSize: 20, total: 60 }),
  getMeal: (mealId) => {
    const found = CATALOG.find((meal) => meal.id === mealId);
    return found === undefined ? Promise.reject(NOT_FOUND) : Promise.resolve(found);
  },
  recommend: () => Promise.resolve({ mealPeriod: 'lunch', recommendations: RECOMMENDED }),
  ask: () =>
    Promise.resolve({
      answered: true,
      answer: 'One of these fits.',
      citations: [{ mealId: FIRST.id, name: FIRST.name }],
      source: 'local' as const,
    }),
};

/**
 * A device with something in it: one resolvable favourite, one orphan and one custom meal. Without
 * them `Saved` renders a New meal button and nothing else, and `FavoritesSection`'s rows, its
 * orphan control and the form's delete button are render sites no enumeration would ever reach.
 */
function seededDriver(): ReturnType<typeof memoryDriver> {
  const put = (value: unknown): string => encodeEnvelope(STORAGE_SCHEMA_VERSION, value, AT);
  return memoryDriver({
    [STORAGE_KEYS.onboarding]: put({ completed: true }),
    [STORAGE_KEYS.favorites]: put([FIRST.id, ORPHAN_ID]),
    [STORAGE_KEYS.customMeals]: put([CUSTOM]),
  });
}

function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <ThemeProvider mode="light" deviceScheme="light" fontScale={1}>
      <ApiProvider client={client}>
        <DataResetProvider runtime={{ driver: seededDriver(), now: () => AT }}>
          <preferencesStore.Provider>
            <onboardingStore.Provider>
              <favoritesStore.Provider>
                <customMealsStore.Provider>
                  <uiStore.Provider>{children}</uiStore.Provider>
                </customMealsStore.Provider>
              </favoritesStore.Provider>
            </onboardingStore.Provider>
          </preferencesStore.Provider>
        </DataResetProvider>
      </ApiProvider>
    </ThemeProvider>
  );
}

const Stack = createNativeStackNavigator();

/**
 * One registered screen, in a real stack. `registeredScreen` rather than a direct import, so this
 * enumerates what the navigator actually mounts — `Home` binds `HomeScreenWithFocus`, whose
 * `useFocusEffect` needs the route context a bare render cannot supply.
 */
function screenTree(route: ScreenRouteName, params?: object): ReactNode {
  const Component = registeredScreen(route);
  if (Component === undefined) {
    throw new Error(`no screen registered for ${route}, so nothing about it can be enumerated`);
  }
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name={route} component={Component} initialParams={params} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

interface Surface {
  readonly id: string;
  readonly tree: () => ReactNode;
  /** The fewest controls this surface must render. Zero needs a named reason; see `NO_CONTROLS`. */
  readonly atLeast: number;
  /** Reveals what a first paint does not show — a confirmation sheet, an answered turn. */
  readonly open?: (host: HTMLElement) => Promise<void>;
}

/** Mounts, runs `open`, enumerates, unmounts. `document.body`, because `Sheet` is a portal. */
async function measure(surface: Surface): Promise<Enumerated> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Providers>{surface.tree()}</Providers>);
  });
  await surface.open?.(host);
  const found = enumerate(document.body);
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return found;
}

const pressing =
  (testID: string) =>
  (host: HTMLElement): Promise<void> =>
    press(host, testID);

async function press(host: HTMLElement, testID: string): Promise<void> {
  const target = host.querySelector(`[data-testid="${testID}"]`);
  if (!(target instanceof HTMLElement)) {
    throw new Error(`no element rendered for testID ${testID}`);
  }
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Types a question and presses Ask, so the transcript's citation button exists to be examined. */
async function askAQuestion(host: HTMLElement): Promise<void> {
  const box = host.querySelector('textarea');
  if (!(box instanceof HTMLTextAreaElement)) {
    throw new Error('the assistant rendered no question field');
  }
  await act(async () => {
    fireEvent.change(box, { target: { value: 'Which of these is cheapest?' } });
  });
  await press(host, 'assistant-ask');
}

function Thrower(): ReactNode {
  throw new Error('a render failed');
}

// ---------------------------------------------------------------------------------- the surfaces

/** A registered route as a surface. `id` defaults to the route, and names the state when it is one. */
const screen = (
  route: ScreenRouteName,
  atLeast: number,
  id: string = route,
  params?: object,
  open?: Surface['open'],
): Surface => ({ id, atLeast, tree: () => screenTree(route, params), open });

const confirmDelete = pressing('meal-form-delete');
const confirmErase = pressing('settings-reset-all');

const SURFACES: readonly Surface[] = [
  screen('Splash', 0),
  screen('Onboarding', 1),
  screen('DietarySetup', 27),
  screen('Home', 2),
  screen('Explore', 22),
  screen('MealDetails', 2, 'MealDetails', { mealId: FIRST.id }),
  screen('Saved', 4),
  screen('Saved', 7, 'Saved (forget an orphan)', undefined, pressing(`saved-forget-${ORPHAN_ID}`)),
  screen('MealForm', 36, 'MealForm (create)'),
  screen('MealForm', 39, 'MealForm (edit)', { mealId: CUSTOM.id }),
  screen('MealForm', 42, 'MealForm (confirm delete)', { mealId: CUSTOM.id }, confirmDelete),
  screen('Settings', 9),
  screen('Settings', 12, 'Settings (confirm erase)', undefined, confirmErase),
  screen('Assistant', 2),
  screen('Assistant', 3, 'Assistant (answered turn)', undefined, askAQuestion),
  {
    id: 'TabNavigator',
    atLeast: 7,
    tree: () => (
      <NavigationContainer>
        <RootNavigator phase="app" />
      </NavigationContainer>
    ),
  },
  {
    id: 'ErrorBoundary (fallback)',
    atLeast: 1,
    tree: () => (
      <ErrorBoundary onError={noop}>
        <Thrower />
      </ErrorBoundary>
    ),
  },
  {
    // Every control-bearing variant the screens above do not reach in a default state. `Toast` is
    // here because it has NO production call site at all — see the report's findings. The four
    // inert controls are what clause (3) of the definition exists for: each renders tabindex="-1".
    id: 'shared components, the variants no screen above reaches',
    atLeast: 15,
    tree: () => (
      <>
        <ErrorState onRetry={noop} secondaryActionLabel="Go back" onSecondaryAction={noop} />
        <EmptyState actionLabel="Add one" onAction={noop} />
        <OfflineState onRetry={noop} />
        <StatusMessage
          tone="info"
          icon="info"
          title="T"
          description="D"
          actionLabel="Go"
          onAction={noop}
        />
        <Toast message="Saved" visible onDismiss={noop} actionLabel="Undo" onAction={noop} />
        <AccessibleButton label="Save" onPress={noop} disabled />
        <AccessibleButton label="Send" onPress={noop} loading />
        <Chip label="Vegan" onPress={noop} toggle disabled />
        <IconButton icon="close" accessibilityLabel="Close" onPress={noop} disabled />
        <SearchField value="rice" onChangeText={noop} />
        <FormField label="Name" value="" onChangeText={noop} required error="Required" />
        <MealCard
          name="X"
          imageUrl={null}
          priceLabel="$1"
          preparationMinutes={5}
          unavailable
          onPress={noop}
        />
      </>
    ),
  },
];

/**
 * The surfaces that legitimately render no control, named. Splash is the only one: a coloured
 * ground, the app's name and an `alert` live region (`SplashSurface.tsx`). Asserted in both
 * directions, so "zero" can never become a silent pass for a screen that lost its controls.
 */
const NO_CONTROLS: readonly string[] = ['Splash'];

/**
 * Operable elements outside the accessibility tree, per surface — three per open `Sheet`. One is
 * the app's: the backdrop `Pressable`, hidden on all three platforms because the labelled close
 * button is the accessible way out and a second unlabelled "close" would be one more thing to
 * swipe past. The other two are react-native-web's own `ModalFocusTrap` sentinels,
 * `role="presentation" tabindex="0"` brackets that bounce focus back into the dialog; no app code
 * renders either. A number rather than a filter, so a fourth has to be explained.
 */
const OUTSIDE_TREE: Readonly<Record<string, number>> = {
  'Saved (forget an orphan)': 3,
  'MealForm (confirm delete)': 3,
  'Settings (confirm erase)': 3,
};

// -------------------------------------------------------------------------------- the assertions

describe('T-23-01 · roles and accessible names', () => {
  const measured = new Map<string, Enumerated>();

  it.each(SURFACES.map((surface) => [surface.id, surface] as const))(
    '%s: every interactive element has a role and an accessible name',
    async (id, surface) => {
      const found = await measure(surface);
      measured.set(id, found);
      const show = (el: Element): string =>
        `${roleOf(el) ?? 'NO ROLE'} · ${el.getAttribute('data-testid') ?? el.outerHTML.slice(0, 80)}`;

      expect(
        found.controls.filter((el) => roleOf(el) === undefined).map(show),
        `${id}: operable elements with no accessibility role`,
      ).toEqual([]);
      expect(
        found.controls.filter((el) => !found.named.has(el)).map(show),
        `${id}: elements with a role and no accessible name`,
      ).toEqual([]);
      expect(
        found.untreed.length,
        `${id}: operable elements outside the accessibility tree — each one needs a reason`,
      ).toBe(OUTSIDE_TREE[id] ?? 0);
    },
    20_000,
  );

  it('rendered at least as many controls as every surface is known to render', () => {
    const short = SURFACES.filter(
      (surface) => (measured.get(surface.id)?.controls.length ?? -1) < surface.atLeast,
    ).map((s) => `${s.id}: ${String(measured.get(s.id)?.controls.length)} < ${String(s.atLeast)}`);

    expect(short, 'surfaces that rendered fewer controls than they are known to').toEqual([]);
    expect(measured.size, 'surfaces measured').toBe(SURFACES.length);
  });

  /** The vacuity guard: a surface that renders nothing passes "all named", and cannot pass this. */
  it('renders a non-empty inventory, and only Splash has nothing to operate', () => {
    const total = [...measured.values()].reduce((sum, found) => sum + found.controls.length, 0);
    const empty = SURFACES.filter((s) => measured.get(s.id)?.controls.length === 0).map(
      (s) => s.id,
    );

    expect(empty, 'surfaces with no interactive element at all').toEqual(NO_CONTROLS);
    expect(SURFACES.filter((s) => s.atLeast === 0).map((s) => s.id)).toEqual(NO_CONTROLS);
    expect(total).toBeGreaterThanOrEqual(SURFACES.reduce((sum, s) => sum + s.atLeast, 0));
  });

  /**
   * The definition, closed at both ends — which is what stops the exclusion list growing to fit
   * whatever would otherwise have failed.
   */
  it('classifies every role it met, as a control or with a stated reason', () => {
    const seen = new Set([...measured.values()].flatMap((found) => [...found.roles]));
    const unclassified = [...seen].filter(
      (role) => !INTERACTIVE_ROLES.includes(role) && !NOT_A_CONTROL.has(role),
    );

    expect(unclassified, 'roles rendered by the app and classified nowhere').toEqual([]);
    expect(seen.size).toBeGreaterThan(0);
  });
});
