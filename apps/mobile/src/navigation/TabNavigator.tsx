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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
export const TAB_ICONS = {
  home: { inactive: 'home', active: 'homeFilled' },
  explore: { inactive: 'explore', active: 'exploreFilled' },
  assistant: { inactive: 'assistant', active: 'assistantFilled' },
  saved: { inactive: 'saved', active: 'savedFilled' },
  settings: { inactive: 'settings', active: 'settingsFilled' },
} as const satisfies Record<UiTab, { readonly inactive: IconName; readonly active: IconName }>;

/**
 * **The selected tab changes SHAPE, not only tint, and that is a correction rather than a flourish.**
 *
 * The bar distinguished its selection by colour alone. That colour was `accent.brand`, which failed
 * AA against the bar at 3.77:1; moving it to `content.link` fixed the contrast and left the active
 * and inactive tones **1.01:1 apart** — near-identical in lightness, separated only by hue, because
 * `content.tertiary` is itself a dark 7.58:1. WCAG measures against the ground rather than between
 * states, so that was still conformant; **PRD §10.5 is the rule it broke**, since colour became the
 * only *visible* signal and `accessibilityState.selected` reaches assistive tech alone.
 *
 * `focused` comes from React Navigation, so the two glyphs are chosen where the bar already knows
 * the state, and `TAB_ICONS` is exported so a test can assert the pairs resolve to genuinely
 * different codepoints in the shipped font rather than trusting two names that merely look unlike.
 */
function tabIcon(tab: UiTab) {
  return function TabBarIcon({
    focused,
    color,
    size,
  }: {
    focused: boolean;
    color: string;
    size: number;
  }): ReactNode {
    const pair = TAB_ICONS[tab];
    return <Icon name={focused ? pair.active : pair.inactive} color={color} size={size} />;
  };
}

/**
 * The two metrics `@react-navigation/bottom-tabs` 7.18.18 spends on a stacked tab, read from its
 * source (`views/BottomTabItem.tsx`'s `tabVerticalUiKit` padding, `views/TabBarIcon.tsx`'s
 * `ICON_SIZE_TALL`) so R-72's arithmetic is checkable here rather than asserted.
 *
 * With its `TABBAR_HEIGHT_UIKIT = 49`, those leave `49 - 1 - 10 - 28 = 10` px for a label styled
 * `labelBeneath: { fontSize: 10 }`, whose line box needs 14. **The library's own figures do not add
 * up, and that is the whole of R-72.** Transcribed rather than imported because they are private to
 * it; if an upgrade moves one, `e2e/specs/text-clipping.spec.ts` reddens.
 */
const TAB_ITEM_PADDING = 5;
const TAB_ICON_HEIGHT = 28;

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
  const { colors, components, typography } = theme;

  /**
   * **R-72's fix is ROOM, not a label style — which is why both attempts on `tabBarLabelStyle`
   * failed, and why this file now sets none.**
   *
   * The label is a flex item with `flex: 0 1 auto` in the tab's column and the icon above it is
   * `flex: 0 0 auto`, so the label was not merely unstyled: it was **compressed from the 14 px it
   * needs to the 10 px the column could spare** (see `TAB_ICON_HEIGHT`), and `numberOfLines={1}` on
   * `@react-navigation/elements`' `Label` gives it react-native-web 0.21.2's `overflow: hidden`,
   * which cuts the four pixels instead of spilling them. A line height or a height on the label
   * therefore could not win: flex shrinking sizes that box, and both attempts were arguing with the
   * wrong layout pass. `e2e/specs/text-clipping.spec.ts` carries the measurement and the correction
   * to the reason those two reverts were recorded for.
   *
   * So the bar is made tall enough to hold what the library already wants to put in it, and the
   * label is then never compressed, so it needs no style at all. **A `minHeight` floor was tried
   * alongside this and measured REDUNDANT** — with the room provisioned there is no deficit for
   * `min-height` to resist — and it is left out rather than kept as belt-and-braces, for the reason
   * `text-clipping.spec.ts`'s containment test records.
   *
   * `typography.label.lineHeight` supplies the label's share because it is the project's smallest
   * published step (`primitive.ts` 12/16, TSD §6.6): 16 clears the 14 with slack, and it carries the
   * OS font scale, so on native — where the library leaves `allowFontScaling` unset and the label
   * really does grow — the bar grows with it and PRD §10.5's "text scales without clipping" holds at
   * 2x instead of breaking there.
   *
   * `insets.bottom` is in the sum because a numeric `height` makes `getTabBarHeight` return that
   * value VERBATIM — skipping the `+ inset` the library adds to its own 49 — while the bar still
   * lays out `paddingBottom: insets.bottom` inside it. Omitting the term would eat a notched phone's
   * 34 px home indicator out of the content: the defect made worse rather than fixed.
   */
  const insets = useSafeAreaInsets();
  const tabBarHeight =
    TAB_ITEM_PADDING * 2 +
    TAB_ICON_HEIGHT +
    typography.label.lineHeight +
    components.divider.thickness +
    insets.bottom;

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
       * **`backBehavior` is a DECISION, not a default, and no document makes it** (T-22-04).
       *
       * Plan §20's "Browser back — correct across tabs and the modal" is the whole of the
       * authority; PRD §10.5 and §12 say nothing about Back. So what "correct" means is settled
       * here, in the one place it is observable, and the reasoning is written down rather than
       * left to be re-derived from the prop name.
       *
       * **What a user expects.** On the web a tab change rewrites the address bar — `/home` becomes
       * `/explore` — so it is a navigation, and the browser's Back button means "undo the last
       * navigation". Back must therefore return to the tab visited *before* this one, once per
       * visit, in reverse order.
       *
       * **`'history'` is the only value that gives that**, because `useLinking` pushes a browser
       * entry only when the router's `state.history` GROWS (`getHistoryLength`, then `historyDelta
       * > 0` → `history.push`). Measured against `@react-navigation/routers` 7.6.4's
       * `SwitchRouter`, for a user who lands on Home and then visits four tabs:
       *
       *  - `'firstRoute'` (**the library default, and the defect this replaces**) — history stays
       *    `[HomeTab, current]`, so its length is 1 → 2 → 2 → 2 → 2. Only the FIRST tab change
       *    pushes; the next three replace, leaving no entry to go back to and nothing for Forward
       *    to return to. One Back jumps from Settings to Home past two tabs the user opened, and
       *    the second Back leaves the site. It also **erases a restored tab**: `lastTab` makes the
       *    initial history `[HomeTab, SavedTab]` against the browser's one entry, so tapping Home
       *    SHRINKS it, and `useLinking` answers a negative delta by traversing back and then
       *    replacing — `createMemoryHistory` clamps the traversal to its own depth, so what
       *    actually happens is that `/saved` is overwritten by `/home` and the tab the user was
       *    restored to is not an entry they can return to.
       *  - `'initialRoute'` — the same two-entry shape, with the bottom being `initialRouteName`
       *    rather than the leftmost tab. Here that is the *persisted* tab, so Back's destination
       *    would depend on what the user did on a previous visit.
       *  - `'order'` — Back walks LEFT ALONG THE TAB BAR rather than back through the visit. Home →
       *    Settings → Explore gives 2 entries and a Back to Home, skipping the Settings the user
       *    actually opened; from Settings alone it would offer Saved, a tab never visited.
       *  - `'fullHistory'` — same as `'history'` except duplicates are kept: three switches between
       *    Home and Explore leave **4** entries and Back replays the ping-pong, where `'history'`
       *    leaves **2**, because it de-duplicates. That bounds the tab history at one entry per
       *    tab, so five Backs always reach the edge of the site and a user who flips tabs idly is
       *    not made to crawl out.
       *  - `'none'` — no in-navigator back at all; the first Back leaves the site.
       *
       * **The cost, stated because it is real.** With `'history'` a tab reached by a cold deep link
       * has a history of exactly `[thatTab]`, because `SwitchRouter.getRehydratedState` rebuilds
       * the history from the partial state's own `history` field and a URL parse supplies none. So
       * on Android, hardware Back from `nutritime://settings` leaves the app instead of landing on
       * Home, which the default would have done. On the web nothing is lost: a cold load is one
       * browser entry whatever the router thinks, so Back was always going to leave the site.
       *
       * **And it does not fight the persisted tab.** The restored `lastTab` becomes the BOTTOM of
       * this visit's history rather than a second entry under it, so the first Back from it leaves
       * the site, as the first page of a visit should. A URL still wins over the stored tab — React
       * Navigation builds initial state from the path and applies `initialRouteName` only where the
       * path is silent — and under `'history'` that URL is also the entry Back returns to.
       */
      backBehavior="history"
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
        //
        // **Secondary does not mean exempt.** Each `Tabs.Screen` below supplies a `title` and no
        // `tabBarLabel`, so this tint paints the tab's LABEL TEXT, not only its glyph, and SC 1.4.3
        // has no selected-state exemption. It was `accent.brand`, a FILL colour authored to sit
        // *under* `content.onBrand`: light's `#059669` on `tabBarStyle.backgroundColor`
        // (`surface.raised`, `#FFFFFF`) is **3.77:1**, the exact ratio DECISIONS.md §3.1 rejects
        // white-on-green for, with the two roles swapped. `content.link` is **7.68:1** light and
        // **10.72:1** dark (`#6EE7B7` on `#12231E`) on that same fill, and is already measured on
        // all four surfaces in both schemes. `component-contrast.test.ts` reads this slot and the
        // fill below back out of this file and re-measures the pair.
        tabBarActiveTintColor: colors.content.link,
        tabBarInactiveTintColor: colors.content.tertiary,
        // **No `tabBarLabelStyle`, deliberately** — R-72 is closed by the height below, and a
        // label style was measured to add nothing. See `tabBarHeight` above before adding one.
        tabBarStyle: {
          height: tabBarHeight,
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
