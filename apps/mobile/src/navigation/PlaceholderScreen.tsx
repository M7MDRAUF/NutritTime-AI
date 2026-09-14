/**
 * What a route renders when nothing is registered for it (T-12-11).
 *
 * The registry's whole point is that the navigator does not import screens, which means the
 * navigator cannot know whether a screen exists. Rendering this instead of throwing is what makes
 * that safe: a route whose feature slice has not landed yet — every route but none, at P12 — shows
 * a calm, navigable screen rather than crashing the tree it sits in.
 *
 * The copy follows PRD §12's shape (what happened, what still works, what to do next) even though
 * this is not one of §12's five data states: a user who reaches it has the same question.
 *
 * Colours and spacing come from `useTheme()`. `primitive.ts` is private to the theme directory
 * (TSD §6.6), so the card group's padding and gap stand in for raw space steps — they are the same
 * scale, reached through the public layer.
 *
 * **The two lines of copy are `AppText`, not `Text`, and that was a defect worth naming.** They
 * were bare `Text` elements taking a colour from the theme and NOTHING from `theme.typography` —
 * no size, line box, weight or family — and neither set `allowFontScaling={false}`, which
 * `ThemeProvider` states in bold as an invariant for every `Text` in the app. The consequence was
 * not the 4× double-scaling bug, because an element that never receives the pre-multiplied token
 * has nothing to double: it was that the app's placeholder copy rendered at React Native's default
 * 14 sp in the platform face, outside the type system entirely. That mattered more than it looks
 * at P12, because nothing is registered yet — **this screen IS the visible app right now**, on
 * every route.
 */

import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText } from '../shared/components/AppText.js';
import { useTheme } from '../shared/theme/ThemeProvider.js';
import type { ScreenRouteName } from './routes.js';

export interface PlaceholderScreenProps {
  /** The route that has nothing registered. Named on screen because it is the useful fact. */
  readonly name: ScreenRouteName;
  readonly testID?: string;
}

/** Layout that does not depend on the theme, hoisted so it is not rebuilt on every render. */
const layout = StyleSheet.create({
  root: { alignItems: 'center', flex: 1, justifyContent: 'center' },
});

export function PlaceholderScreen({ name, testID }: PlaceholderScreenProps): ReactNode {
  const theme = useTheme();
  const { card } = theme.components;

  return (
    <View
      style={[
        layout.root,
        { backgroundColor: theme.colors.surface.canvas, gap: card.gap, padding: card.padding },
      ]}
      testID={testID ?? `placeholder-${name}`}
    >
      <AppText variant="title" tone="primary" align="center" level={1}>
        {name} is not available yet
      </AppText>
      <AppText variant="body" tone="secondary" align="center">
        No screen is registered for this route. The rest of the app still works — use the tabs to go
        somewhere else.
      </AppText>
    </View>
  );
}
