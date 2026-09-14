/**
 * The five tabs of PRD §11 (T-12-12): Home · Explore · Assistant (centre) · Saved · Settings.
 *
 * Four of the five are a stack, and the fifth is not, because that is what TSD §6.2's route table
 * says: it declares `HomeTab`, `ExploreTab`, `AssistantTab` and `SavedTab` as containers wrapping
 * `NavigatorScreenParams`, and `Settings` as a plain screen. Each stack holds exactly one screen
 * today; the stack exists so P13 onward can push onto a tab without the tab changing shape, and so
 * each tab keeps its own history when the user switches away and back.
 *
 * **No screen is imported here.** Every `component=` is `screenFor(name)` — see `registry.tsx`.
 *
 * The four stacks are written out rather than produced by a factory. A factory would have to be
 * generic over both the stack's param list and its screen name to stay typed, and it would fight
 * the very next change: P13 adds a second screen to Explore's stack and not to the others.
 */

import type { ReactNode } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../shared/theme/ThemeProvider.js';
import { Icon } from '../shared/components/Icon.js';
import type { IconName } from '../shared/components/Icon.js';
import { uiActions, uiStore } from '../state/ui/index.js';
import { useStorageContext } from '../state/StorageProvider.js';
import type { UiTab } from '../infrastructure/storage/definitions.js';
import { screenFor } from './registry.js';
import type {
  AssistantStackParamList,
  ExploreStackParamList,
  HomeStackParamList,
  SavedStackParamList,
  TabParamList,
} from './routes.js';

const Tabs = createBottomTabNavigator<TabParamList>();
const HomeStack = createNativeStackNavigator<HomeStackParamList>();
const ExploreStack = createNativeStackNavigator<ExploreStackParamList>();
const AssistantStack = createNativeStackNavigator<AssistantStackParamList>();
const SavedStack = createNativeStackNavigator<SavedStackParamList>();

/**
 * Headers are off throughout.
 *
 * Every page in `design-system/pages/` draws its own header — Home's greeting and meal period,
 * Explore's search field, Saved's section switch. A navigator header on top of those would be a
 * second title bar, so the screens own their headers and the navigator owns only the transition.
 */
const stackOptions = { headerShown: false } as const;

function HomeTabStack(): ReactNode {
  return (
    <HomeStack.Navigator screenOptions={stackOptions}>
      <HomeStack.Screen name="Home" component={screenFor('Home')} />
    </HomeStack.Navigator>
  );
}

function ExploreTabStack(): ReactNode {
  return (
    <ExploreStack.Navigator screenOptions={stackOptions}>
      <ExploreStack.Screen name="Explore" component={screenFor('Explore')} />
    </ExploreStack.Navigator>
  );
}

function AssistantTabStack(): ReactNode {
  return (
    <AssistantStack.Navigator screenOptions={stackOptions}>
      <AssistantStack.Screen name="Assistant" component={screenFor('Assistant')} />
    </AssistantStack.Navigator>
  );
}

function SavedTabStack(): ReactNode {
  return (
    <SavedStack.Navigator screenOptions={stackOptions}>
      <SavedStack.Screen name="Saved" component={screenFor('Saved')} />
    </SavedStack.Navigator>
  );
}

/**
 * One tab's icon, built once per name.
 *
 * **This slot was `tabBarIcon: () => null` and the reason is worth keeping.** T-12-04 had only a
 * Unicode glyph map, and there is no house, compass, chat, bookmark or gear character with
 * dependable coverage - so the five tabs had no icons at all, and leaving `tabBarIcon` off
 * entirely was worse than empty, because `BottomTabBar` substitutes `MissingIcon` and draws a
 * placeholder triangle on every tab, twice over as the bar cross-fades an active and an inactive
 * copy. The user amended TSD 2.1 (A-11) and `Icon` now sits on a real set, so the slot is filled.
 *
 * `color` comes from React Navigation, which resolves it from `tabBarActiveTintColor` and
 * `tabBarInactiveTintColor` - both theme tokens - so the icon tracks the selected state without
 * this file deciding a colour. `size` is React Navigation's, not a token: the bar owns its own
 * metrics and an icon that ignored them would sit wrong in it.
 *
 * **No `accessibilityLabel`.** The tab already has a visible `title` that a screen reader
 * announces along with `accessibilityState.selected`; labelling the icon too would say it twice.
 */
function tabIcon(name: IconName) {
  return function TabBarIcon({ color, size }: { color: string; size: number }): ReactNode {
    return <Icon name={name} color={color} size={size} />;
  };
}

/**
 * The logical tab id each container carries (T-18-01).
 *
 * Written out rather than derived from the route name, so the compiler checks every value against
 * `UiTab`: `definitions.ts` stores a LOGICAL id precisely so a rename in `routes.ts` cannot
 * invalidate every user's stored tab, and a `routeName.toLowerCase().replace('tab','')` would
 * rebuild exactly the coupling that decision exists to prevent.
 */
const TAB_IDS = {
  HomeTab: 'home',
  ExploreTab: 'explore',
  AssistantTab: 'assistant',
  SavedTab: 'saved',
  Settings: 'settings',
} as const satisfies { readonly [K in keyof TabParamList]: UiTab };

/** The inverse, for restoring a stored tab. Written out too, so neither direction needs a cast. */
const TAB_ROUTES = {
  home: 'HomeTab',
  explore: 'ExploreTab',
  assistant: 'AssistantTab',
  saved: 'SavedTab',
  settings: 'Settings',
} as const satisfies { readonly [K in UiTab]: keyof TabParamList };

/**
 * The logical id for a focused route, or `undefined` for a route that is not a tab.
 *
 * A lookup rather than `TAB_IDS[route.name as keyof TabParamList]`: `screenListeners` hands back a
 * route name typed more widely than this navigator's five, and an `as` there would be exactly the
 * cast that papers over a type the compiler is right about — `Object.entries` gives the union
 * honestly, and a name that is not a tab returns `undefined` instead of an unchecked index read.
 */
function tabIdFor(routeName: string): UiTab | undefined {
  return Object.entries(TAB_IDS).find(([route]) => route === routeName)?.[1];
}

export function TabNavigator(): ReactNode {
  const theme = useTheme();
  const { colors, components } = theme;

  /**
   * **`useDispatch`, never `useValue`** — and that is the whole reason `createStore` publishes
   * three contexts instead of one. Reading the value here would re-render the navigator on every
   * tab press, which is the cost TSD §6.3's memoisation strategy exists to avoid.
   */
  const dispatch = uiStore.useDispatch();

  /**
   * The tab to open on, read from the HYDRATION SNAPSHOT rather than from the live store.
   *
   * **This is the opposite of P14's defect, deliberately, and the distinction is worth stating**
   * because the shapes look identical. The boot phase was read from the snapshot and had to track
   * the live store — a snapshot is read once and never updated, so completing onboarding moved the
   * store and left the phase behind. An *initial* route is the other case: it is consumed once at
   * mount by definition, and subscribing to the live value would re-render the navigator every
   * time the user changed tabs — the very thing it is recording.
   *
   * A deep link still wins: React Navigation builds initial state from the URL and applies
   * `initialRouteName` only where the URL says nothing (`linking.ts`).
   *
   * **Restoring it is a judgement, recorded as such.** `lastTab` is plan-introduced (A-09) and no
   * document says to reopen on it. But a stored field that nothing ever reads is dead data, and
   * the honest alternative would be to not store it at all — while TSD §6.4 names the `ui` key and
   * the field's own name states its purpose.
   */
  const storedTab = useStorageContext().snapshot.entries.ui.value.lastTab;
  const initialRouteName = storedTab === null ? 'HomeTab' : TAB_ROUTES[storedTab];

  return (
    <Tabs.Navigator
      initialRouteName={initialRouteName}
      /**
       * One listener for the whole navigator, not five copies. `focus` fires for the tab the user
       * moved to, including on first mount — which is a no-op, because `ui/tabChanged` to the tab
       * already stored returns `state` identically and so queues no write.
       */
      screenListeners={({ route }) => ({
        focus: () => {
          const id = tabIdFor(route.name);
          if (id !== undefined) {
            dispatch(uiActions.changeTab(id));
          }
        },
      })}
      screenOptions={{
        headerShown: false,
        // Colour is the *secondary* signal for the selected tab. React Navigation puts
        // `accessibilityState={{ selected }}` on each tab button, which is what a screen reader
        // announces and what satisfies the "never colour alone" half of PRD §10.5.
        tabBarActiveTintColor: colors.accent.brand,
        tabBarInactiveTintColor: colors.content.tertiary,
        tabBarStyle: {
          backgroundColor: colors.surface.raised,
          borderTopColor: colors.border.subtle,
          borderTopWidth: components.divider.thickness,
        },
      }}
    >
      <Tabs.Screen
        name="HomeTab"
        component={HomeTabStack}
        options={{ title: 'Home', tabBarIcon: tabIcon('home') }}
      />
      <Tabs.Screen
        name="ExploreTab"
        component={ExploreTabStack}
        options={{ title: 'Explore', tabBarIcon: tabIcon('explore') }}
      />
      <Tabs.Screen
        name="AssistantTab"
        component={AssistantTabStack}
        options={{ title: 'Assistant', tabBarIcon: tabIcon('assistant') }}
      />
      <Tabs.Screen
        name="SavedTab"
        component={SavedTabStack}
        options={{ title: 'Saved', tabBarIcon: tabIcon('saved') }}
      />
      <Tabs.Screen
        name="Settings"
        component={screenFor('Settings')}
        options={{ title: 'Settings', tabBarIcon: tabIcon('settings') }}
      />
    </Tabs.Navigator>
  );
}
