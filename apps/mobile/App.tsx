/**
 * The application root.
 *
 * Deliberately thin: it wires the providers and nothing else. The navigators, the boot phases
 * and the screen registry arrive with T-12-10 through T-12-12 and replace the placeholder
 * below; keeping the composition here means those tasks touch one file rather than three.
 */

import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { ThemeProvider, useTheme } from './src/shared/theme/ThemeProvider.js';

function Placeholder(): ReactNode {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.canvas,
      }}
    >
      <Text style={{ color: theme.colors.content.primary }}>NutriTime AI</Text>
    </View>
  );
}

export default function App(): ReactNode {
  return (
    <SafeAreaProvider>
      {/* `mode` is hard-coded until the preferences store hydrates at T-14-06. */}
      <ThemeProvider mode="system">
        <StatusBar style="auto" />
        <Placeholder />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
