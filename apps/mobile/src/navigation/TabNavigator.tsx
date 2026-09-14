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

export function TabNavigator(): ReactNode {
  const theme = useTheme();
  const { colors, components } = theme;

  return (
    <Tabs.Navigator
      initialRouteName="HomeTab"
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
