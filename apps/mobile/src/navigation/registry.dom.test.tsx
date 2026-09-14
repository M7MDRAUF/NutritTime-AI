/**
 * T-12-11. The registry's contract, which is what the navigation layer's independence rests on: a
 * screen is *registered*, never imported by a navigator.
 *
 * A dom test rather than the plain one the task sheet suggests, for two reasons. The contract most
 * worth checking — that a registration arriving after first paint re-renders through
 * `useSyncExternalStore` — has no meaning without a render. And `registry.tsx` renders
 * `PlaceholderScreen`, which imports `react-native`, so nothing in this module can be loaded at
 * all under the node project, whose environment has no alias for it.
 *
 * Each test claims its own route, because the registry is module state shared across the file and
 * several of these tests are about what happens *before* a route is registered.
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text } from 'react-native';
import { ThemeProvider } from '../shared/theme/ThemeProvider.js';
import { registerScreen, screenFor } from './registry.js';
import type { RootParamList } from './routes.js';
import { renderToDom } from './testHarness.js';

vi.mock('react-native-safe-area-context', async () => {
  const { createSafeAreaContextMock } = await import('./testHarness.js');
  return createSafeAreaContextMock();
});

const Stack = createNativeStackNavigator<RootParamList>();

/**
 * A real navigator, because it is the only honest source of a `route` and `navigation` pair. The
 * screen under test is passed in, so each test mounts exactly one route.
 */
function Host({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <ThemeProvider mode="light" deviceScheme="light" fontScale={1}>
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>{children}</Stack.Navigator>
      </NavigationContainer>
    </ThemeProvider>
  );
}

describe('the screen registry', () => {
  it('renders a placeholder for an unregistered route instead of throwing', async () => {
    // Nothing is ever registered for Splash in this file. A navigator that imported its screens
    // could not reach this state; a registry can, and has to survive it.
    const view = await renderToDom(
      <Host>
        <Stack.Screen name="Splash" component={screenFor('Splash')} />
      </Host>,
    );

    expect(view.text()).toContain('Splash is not available yet');
    await view.unmount();
  });

  it('renders the registered screen, and hands it its route', async () => {
    function HomeScreen({ route }: { readonly route: { readonly name: string } }): ReactNode {
      return <Text>{`home screen for ${route.name}`}</Text>;
    }
    registerScreen('Home', HomeScreen);

    const view = await renderToDom(
      <Host>
        <Stack.Screen name="Home" component={screenFor('Home')} />
      </Host>,
    );

    expect(view.text()).toContain('home screen for Home');
    expect(view.text()).not.toContain('not available yet');
    await view.unmount();
  });

  it('re-renders a mounted route when its screen is registered afterwards', async () => {
    // This is what `useSyncExternalStore` is for. Without it the placeholder would still be on
    // screen after `registerScreen`, because nothing else in the tree changed.
    const view = await renderToDom(
      <Host>
        <Stack.Screen name="Explore" component={screenFor('Explore')} />
      </Host>,
    );
    expect(view.text()).toContain('Explore is not available yet');

    function ExploreScreen(): ReactNode {
      return <Text>explore arrived late</Text>;
    }
    await act(async () => {
      registerScreen('Explore', ExploreScreen);
    });

    expect(view.text()).toContain('explore arrived late');
    expect(view.text()).not.toContain('not available yet');
    await view.unmount();
  });

  it('returns the same component for a route every time', () => {
    // Identity is what stops a navigator re-render from remounting the screen and throwing away
    // its state, its scroll position and any request in flight.
    expect(screenFor('Saved')).toBe(screenFor('Saved'));
    expect(screenFor('Saved')).not.toBe(screenFor('Settings'));
  });

  it('ignores a repeat registration of the same component', () => {
    function SettingsScreen(): ReactNode {
      return <Text>settings</Text>;
    }
    registerScreen('Settings', SettingsScreen);
    // No observable change, and — the point — no notification to every mounted screen.
    registerScreen('Settings', SettingsScreen);
    expect(screenFor('Settings')).toBe(screenFor('Settings'));
  });
});
