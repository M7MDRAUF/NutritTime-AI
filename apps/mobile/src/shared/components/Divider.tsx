/**
 * A rule between rows (TSD 6.7).
 *
 * Every value comes from the `divider` component group, which is the one place `border.subtle`
 * is the right colour: a rule carries no information, so WCAG 1.4.11's 3:1 minimum for control
 * boundaries does not reach it.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';

export type DividerSpacing = 'default' | 'tight' | 'none';

export interface DividerProps {
  readonly spacing?: DividerSpacing;
  /** Indents the rule to align with content that clears an avatar or an icon. */
  readonly inset?: boolean;
  readonly testID?: string;
}

export function Divider({ spacing = 'default', inset = false, testID }: DividerProps): ReactNode {
  const { components } = useTheme();
  const divider = components.divider;

  // `undefined`, not `0`. The zero token lives in `primitive.ts` and is not reachable from a
  // component, and writing `0` here would be the first space literal in the batch - which is
  // how the second one gets argued for. An unset margin is what "no spacing" means anyway.
  const margin =
    spacing === 'none' ? undefined : spacing === 'tight' ? divider.spacingTight : divider.spacing;

  return (
    <View
      testID={testID}
      // Decorative, so it is hidden from assistive technology on all three platforms rather
      // than announced as a separator the user cannot act on.
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        // The one fixed height in this batch, and it is safe: a rule contains no text, so
        // there is nothing here for an OS font scale to overflow (PRD 10.5).
        height: divider.thickness,
        backgroundColor: divider.color,
        marginVertical: margin,
        marginLeft: inset ? divider.inset : undefined,
      }}
    />
  );
}
