/**
 * The screen registry (TSD §6.2, T-12-11).
 *
 * **Features register their screens; `navigation/` never imports one.** That inversion is the
 * point of this module, and it is load-bearing rather than decorative: were the navigators to
 * import `HomeScreen`, `ExploreScreen` and the rest, every feature slice from P13 onward would
 * have to edit a navigator, and `navigation/` would transitively depend on the API client, the
 * stores and the domain. Here a slice calls `registerScreen('Home', HomeScreen)` at its own module
 * scope and the navigators never change again. Plan P12's impact note names the alternative — a
 * dependency knot later phases cannot undo cheaply.
 *
 * The registry is mutable state living outside React, so React has to be *told* when it changes —
 * hence `useSyncExternalStore`. A plain module-level object read during render would leave a screen
 * registered after first paint invisible until something else happened to re-render, which is
 * exactly the symptom a lazily-evaluated feature module produces.
 *
 * @see PlaceholderScreen for what an unregistered route renders.
 */

import { useSyncExternalStore } from 'react';
import type { ComponentType, FunctionComponent, ReactNode } from 'react';
import type { NavigationProp, Route, RouteProp } from '@react-navigation/native';
import { PlaceholderScreen } from './PlaceholderScreen.js';
import type { RootParamList, ScreenRouteName } from './routes.js';

/**
 * What every registered screen receives.
 *
 * `navigation` is typed against the whole `RootParamList` rather than the enclosing navigator's
 * slice, because a screen legitimately navigates across the tree: Explore opens `MealDetails`,
 * which lives on the root stack and not in Explore's own.
 */
export interface ScreenProps<K extends ScreenRouteName> {
  readonly route: RouteProp<RootParamList, K>;
  readonly navigation: NavigationProp<RootParamList>;
}

export type ScreenComponent<K extends ScreenRouteName> = ComponentType<ScreenProps<K>>;

/**
 * The same props with the route widened to "some route".
 *
 * This is the storage type, and the direction of the widening is what makes the module mostly
 * sound: props are contravariant, so a component accepting *any* route is assignable to
 * `ScreenComponent<K>` for every `K`. `screenFor` therefore returns a precisely typed component
 * with no assertion at all. Only `registerScreen` goes the other way, and that one step is called
 * out below.
 */
interface AnyScreenProps {
  readonly route: Route<string, object | undefined>;
  readonly navigation: NavigationProp<RootParamList>;
}

/**
 * The wrapper is a `FunctionComponent`, not a `ComponentType`, and that is the whole assignment.
 *
 * `ComponentType` unions in `ComponentClass`, whose `defaultProps?: Partial<P>` puts `P` in a
 * *covariant* position and cancels the contravariance the widening relies on. A function component
 * carries `P` only in its call signature, so `FunctionComponent<AnyScreenProps>` is assignable to
 * `ScreenComponent<K>` for every route — which is why `screenFor` needs no assertion.
 */
type AnyScreenComponent = FunctionComponent<AnyScreenProps>;

const registered = new Map<ScreenRouteName, ComponentType<AnyScreenProps>>();
const wrappers = new Map<ScreenRouteName, AnyScreenComponent>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Register the component for a route. Idempotent, and last-write-wins.
 *
 * Re-registering the identical component is a no-op rather than a notification: a module evaluated
 * twice under a bundler or across a test file must not re-render every mounted screen.
 *
 * **The one unchecked step in the navigation layer.** `component` is typed for exactly route
 * `name`, and the map is keyed by that same `name`, so the widening is true — but the fact that
 * makes it true is a *runtime* key, and TypeScript cannot follow a value into a map key and back
 * out again. Every alternative shape (a mapped-type table, a `Map` keyed by the union, a stored
 * render thunk) moves the same assertion somewhere less obvious: a generic index write like
 * `table[name] = component` collapses `ScreenTable[K]` to the intersection of all ten routes'
 * component types and fails. It is confined to this line so that the public API — `screenFor`,
 * `ScreenProps`, `ScreenComponent` — carries no assertion of any kind.
 */
export function registerScreen<K extends ScreenRouteName>(
  name: K,
  component: ScreenComponent<K>,
): void {
  const erased = component as ComponentType<AnyScreenProps>;
  if (registered.get(name) === erased) {
    return;
  }
  registered.set(name, erased);
  for (const listener of listeners) {
    listener();
  }
}

/**
 * The component to hand a `Stack.Screen`'s `component=` prop for a route.
 *
 * **Stable by name.** The returned wrapper is cached, so a navigator that re-renders passes the
 * same component identity and React keeps the mounted screen rather than remounting it — which
 * would throw away its state, its scroll position and any request in flight.
 */
/**
 * What is registered for a route right now, or `undefined`. Introspection, not a render path.
 *
 * **Added because the test guarding `registerScreens()` could not fail.** That test read
 * `register.ts` as source text and regex-matched `registerScreen('Name'`, which answers "is the
 * list complete?" and not "does the list run?" — so giving `registerScreens()` an unconditional
 * early `return`, which drops **every** screen in the app to `PlaceholderScreen`, left all 2012
 * tests green. A mutation audit found it.
 *
 * `screenFor` cannot answer the question: it returns its stable wrapper whether or not anything is
 * registered behind it, by design, because that is what lets a feature register late. So the
 * registry has to be askable directly. Returning the component rather than a boolean is deliberate
 * — it makes "registered the *right* component" checkable too, which is how `Home` binding the bare
 * screen instead of `HomeScreenWithFocus` would be caught.
 */
export function registeredScreen(name: ScreenRouteName): ComponentType<AnyScreenProps> | undefined {
  return registered.get(name);
}

export function screenFor<K extends ScreenRouteName>(name: K): ScreenComponent<K> {
  const cached = wrappers.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const created = createRegisteredScreen(name);
  wrappers.set(name, created);
  return created;
}

function createRegisteredScreen(name: ScreenRouteName): AnyScreenComponent {
  // Bound once per route, so the getter identity React compares between renders is stable.
  const read = (): ComponentType<AnyScreenProps> | undefined => registered.get(name);

  function RegisteredScreen(props: AnyScreenProps): ReactNode {
    // The third argument is the server snapshot. `app.json` sets `web.output: "static"`, so the
    // web export really is rendered on a server at build time and omitting it throws there.
    // Reading the same registry is correct: registration happens at module scope, which has
    // already run by the time anything renders.
    const Screen = useSyncExternalStore(subscribe, read, read);
    return Screen === undefined ? <PlaceholderScreen name={name} /> : <Screen {...props} />;
  }

  // Named for the React devtools tree and for test output, where a wall of identical
  // `RegisteredScreen` entries would say nothing about which route is which.
  RegisteredScreen.displayName = `RegisteredScreen(${name})`;
  return RegisteredScreen;
}
