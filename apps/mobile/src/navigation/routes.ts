/**
 * The one route table (TSD §6.2, T-12-10).
 *
 * Types and constants only — no React, and nothing reachable from here pulls a navigator in. A
 * screen, a test or the linking config can read the table without dragging
 * `@react-navigation/native-stack` into a node test run, which matters because the React Native
 * packages are Flow-typed source only the `dom` Vitest project can load.
 *
 * Three things are kept from drifting apart, and the mechanism for each is a compile error rather
 * than a convention:
 *
 *  1. `RootParamList` names every route and its params.
 *  2. `SCREEN_ROUTE_NAMES` / `CONTAINER_ROUTE_NAMES` split those routes into leaf screens and
 *     navigator containers.
 *  3. `ROUTE_KINDS` mirrors that split at runtime, for code that must branch on it.
 *
 * `ROUTE_KINDS` is declared `satisfies` a mapped type over `RouteName` whose value is computed from
 * the two arrays, so a route missing from the table, missing from both arrays, or filed under the
 * wrong kind is all the same error: the object no longer satisfies the shape. TSD §6.2 derives
 * `ScreenRouteName` from `ROUTE_KINDS`; deriving it from the array instead and pointing the check
 * the other way yields the identical type and — unlike the TSD's direction — needs no cast to get
 * `SCREEN_ROUTE_NAMES` out at runtime.
 */

import type { MealPeriod } from '@nutritime/contracts';
import type { NavigatorScreenParams } from '@react-navigation/native';

/**
 * Where the user was when they opened a meal (TSD §6.2).
 *
 * `MealDetails` is one screen on the root stack reachable from four places, which is exactly why
 * this param exists: were the screen duplicated into each tab's stack, the origin would be implied
 * by the stack and the param would be dead weight.
 */
export const NAVIGATION_ORIGINS = ['home', 'explore', 'saved', 'assistant'] as const;
export type NavigationOrigin = (typeof NAVIGATION_ORIGINS)[number];

/** The two sections of Saved (PRD §8.3): favourited catalog meals, and the user's own. */
export const SAVED_SECTIONS = ['favorites', 'custom'] as const;
export type SavedSection = (typeof SAVED_SECTIONS)[number];

/**
 * Boot phases (TSD §6.1). The phase decides which screens are *in* the navigator, so a protected
 * screen cannot render early — there is no redirect for hydration to lose a race with.
 *
 * Declared here rather than beside hydration because the route table is what the phase selects
 * from, and navigation must not import `infrastructure/`.
 */
export const BOOT_PHASES = ['hydrating', 'onboarding', 'app'] as const;
export type BootPhase = (typeof BOOT_PHASES)[number];

/** `returnTo`, not a bare back: one screen serves both onboarding and Settings (PRD §8.1). */
export interface DietarySetupParams {
  readonly returnTo: 'Onboarding' | 'Settings';
}

export interface ExploreParams {
  readonly query?: string;
  readonly period?: MealPeriod;
}

export interface AssistantParams {
  readonly seedQuestion?: string;
}

export interface SavedParams {
  readonly section?: SavedSection;
}

/** Absent `mealId` means create, present means edit: one screen, two journeys (PRD §8.3). */
export interface MealFormParams {
  readonly mealId?: string;
}

/** `mealId` is **required** — a meal detail screen without a meal has nothing to render. */
export interface MealDetailsParams {
  readonly mealId: string;
  readonly origin?: NavigationOrigin;
}

/**
 * The ten leaf screens of PRD §11, with their params.
 *
 * Ten, not nine: Plan §14.4's `--page` slug list omits `splash`, but PRD §11 names it, Plan §14.5
 * gives it a route and a required state, and `design-system/pages/` holds ten files. PRD outranks
 * a Plan example, so Splash is a screen.
 *
 * Declared apart from the containers so the per-tab param lists can be `Pick`ed from it without
 * `RootParamList` referring to itself through them.
 *
 * A `type`, not an `interface`: React Navigation constrains every param list to
 * `Record<string, object | undefined>`, and only a type alias picks up the implicit index
 * signature that satisfies it. An interface here makes every navigator generic fail to resolve.
 */
type ScreenParamList = {
  Splash: undefined;
  Onboarding: undefined;
  DietarySetup: DietarySetupParams | undefined;
  Home: undefined;
  Explore: ExploreParams | undefined;
  Assistant: AssistantParams | undefined;
  Saved: SavedParams | undefined;
  MealForm: MealFormParams | undefined;
  MealDetails: MealDetailsParams;
  Settings: undefined;
};

/**
 * One stack per tab, each holding its own screen.
 *
 * `Pick` rather than a re-declaration: a param type changed above changes here too. Each holds a
 * single screen today; P13 onward pushes onto them, which is why a tab is a stack at all and not
 * the screen directly.
 */
export type HomeStackParamList = Pick<ScreenParamList, 'Home'>;
export type ExploreStackParamList = Pick<ScreenParamList, 'Explore'>;
export type AssistantStackParamList = Pick<ScreenParamList, 'Assistant'>;
export type SavedStackParamList = Pick<ScreenParamList, 'Saved'>;

/**
 * The five tabs of PRD §11, in order: Home · Explore · Assistant (centre) · Saved · Settings.
 *
 * Settings is the screen itself, not a `SettingsTab` container — TSD §6.2's table declares four
 * `*Tab` containers and no fifth, and nothing in Settings pushes a second screen.
 */
export type TabParamList = {
  HomeTab: NavigatorScreenParams<HomeStackParamList> | undefined;
  ExploreTab: NavigatorScreenParams<ExploreStackParamList> | undefined;
  AssistantTab: NavigatorScreenParams<AssistantStackParamList> | undefined;
  SavedTab: NavigatorScreenParams<SavedStackParamList> | undefined;
  Settings: undefined;
};

/**
 * Every route in the app, flat — TSD §6.2's table, assembled from the two halves above so each
 * leaf param has exactly one declaration.
 *
 * Flat, not nested, because this is what `navigate()` is typed against: any screen may reach any
 * route by name, and the tree shape is the navigators' business, not the caller's.
 */
export type RootParamList = ScreenParamList & {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  HomeTab: NavigatorScreenParams<HomeStackParamList> | undefined;
  ExploreTab: NavigatorScreenParams<ExploreStackParamList> | undefined;
  AssistantTab: NavigatorScreenParams<AssistantStackParamList> | undefined;
  SavedTab: NavigatorScreenParams<SavedStackParamList> | undefined;
};

export type RouteName = keyof RootParamList;

type AppRootParamList = RootParamList;

/**
 * Makes `useNavigation()` and `<Link>` typed against this table everywhere, with no per-call
 * generic. SQG-13 — "every navigation target exists in `RootParamList`" — becomes a compile error
 * because of this block rather than something a reviewer checks by eye.
 *
 * Both suppressions below are forced by the shape React Navigation publishes for this: the target
 * is an `interface` inside a `namespace`, so merging into it requires the same two, and an
 * interface that only inherits necessarily declares no members of its own.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends AppRootParamList {}
  }
}

/**
 * The ten leaf screens. `satisfies readonly RouteName[]` rejects a name that is not a route;
 * `ROUTE_KINDS` below rejects a route left out of both this list and the container list.
 */
export const SCREEN_ROUTE_NAMES = [
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
] as const satisfies readonly RouteName[];

/** The five navigator containers: the tab navigator, and the four per-tab stacks. */
export const CONTAINER_ROUTE_NAMES = [
  'Tabs',
  'HomeTab',
  'ExploreTab',
  'AssistantTab',
  'SavedTab',
] as const satisfies readonly RouteName[];

/** A route that renders a screen component, and so can be registered (T-12-11). */
export type ScreenRouteName = (typeof SCREEN_ROUTE_NAMES)[number];
/** A route that renders a nested navigator. Never registered; never has a screen component. */
export type ContainerRouteName = (typeof CONTAINER_ROUTE_NAMES)[number];

export type RouteKind = 'screen' | 'container';

/**
 * `never` for a route in neither list, so `ROUTE_KINDS` can supply no value for it and the
 * omission is a compile error naming that route.
 */
type KindOf<K extends RouteName> = K extends ScreenRouteName
  ? 'screen'
  : K extends ContainerRouteName
    ? 'container'
    : never;

/**
 * The runtime mirror of the screen/container split (TSD §6.2).
 *
 * The mapped type ranges over `RouteName`, so every route must appear: this object is the compile
 * check the Plan names as T-12-10's acceptance.
 */
export const ROUTE_KINDS = {
  Splash: 'screen',
  Onboarding: 'screen',
  DietarySetup: 'screen',
  Tabs: 'container',
  HomeTab: 'container',
  Home: 'screen',
  ExploreTab: 'container',
  Explore: 'screen',
  AssistantTab: 'container',
  Assistant: 'screen',
  SavedTab: 'container',
  Saved: 'screen',
  MealForm: 'screen',
  MealDetails: 'screen',
  Settings: 'screen',
} as const satisfies { readonly [K in RouteName]: KindOf<K> };

/**
 * Deep-link params, validated at runtime (TSD §6.2).
 *
 * A URL-parsed param is a string the type system never saw, so `route.params` is only as true as
 * the URL that produced it. Both readers take `unknown` for that reason.
 *
 * The spread is deliberate: it drops the prototype, so a crafted `__proto__` or `constructor` key
 * in a link cannot hand back an inherited function where a param was expected.
 */
function asRecord(params: unknown): Record<string, unknown> | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  return { ...params };
}

/**
 * A string param, or `undefined`.
 *
 * Arrays are rejected rather than joined or first-taken: a repeated query key parses to an array,
 * and there is no honest single answer to which one the user meant.
 */
export function readStringParam(params: unknown, key: string): string | undefined {
  const value = asRecord(params)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A param constrained to a known set — the `as const` arrays above are the witnesses. */
export function readUnionParam<T extends string>(
  params: unknown,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readStringParam(params, key);
  return allowed.find((candidate) => candidate === value);
}
