/**
 * A stand-in for `@expo/vector-icons/MaterialCommunityIcons`, used by the `dom` Vitest project
 * only.
 *
 * **Why this exists, stated plainly, because a test double is a liability until it is justified.**
 * `@expo/vector-icons` publishes JSX inside a `.js` file (`build/createIconSet.js:79` is
 * `return <Text />`), and Vitest 5's rolldown transformer refuses to parse it: *"Unexpected JSX
 * expression"*. Every dom suite that reached `Icon` failed to load — twelve of sixteen files. I
 * tried widening the transform with `esbuild.include` + `loader: 'jsx'` on the dom project and it
 * had no effect, because that option does not reach rolldown's parser.
 *
 * **What is lost, and what is not.** This double does not draw a glyph, so no test here proves the
 * vendor renders one. That was never provable in this environment anyway: jsdom has no font engine,
 * so even the real component would render an unmeasurable character — the same gap R-35 already
 * records for touch targets, and one only P23 on a device closes.
 *
 * What the suites still prove, against the real thing:
 *
 *  - every name in `Icon`'s `GLYPHS` map exists in the vendor's **actual shipped glyph map**, read
 *    from `MaterialCommunityIcons.json` in `Icon.dom.test.tsx`. That is the assertion that catches
 *    a typo'd icon name, and it needs no rendering at all;
 *  - `Icon` passes the right size, colour and accessibility props, which is its own contract;
 *  - the props `Icon` computes, including `allowFontScaling={false}`, which typecheck enforces
 *    against the REAL module's signature even though react-native-web drops the prop at render.
 *
 * The props are forwarded onto a `Text` because that is exactly what the vendor renders, so a
 * component asserting against `style.color` or `style.fontSize` sees what it would see in the app.
 *
 * **One thing this double cannot pin, and nor could the real component: `allowFontScaling`.**
 * react-native-web 0.21 does not list it in `forwardedProps` and its `Text` never reads it, so
 * removing it from any component changes nothing in jsdom. The double-scaling bug is guarded by
 * asserting the ARITHMETIC instead - 16 px at 1x, 32 px at 2x - which is what
 * `AppText.dom.test.tsx` does and says it does. On a device the prop is the guard; here the
 * arithmetic is, and nothing in this suite could have caught a `Text` that skipped the flag.
 */

import type { ReactNode } from 'react';
import { Text } from 'react-native';
import type { TextStyle } from 'react-native';

export interface IconSetProps {
  readonly name: string;
  readonly size?: number;
  readonly color?: string;
  readonly testID?: string;
  readonly allowFontScaling?: boolean;
  readonly accessibilityRole?: 'image';
  readonly accessibilityLabel?: string;
  readonly accessibilityElementsHidden?: boolean;
  readonly importantForAccessibility?: 'auto' | 'no-hide-descendants';
  readonly 'aria-hidden'?: boolean;
  readonly style?: TextStyle;
}

/** What react-native-web turns into `data-icon-name`. Not part of React Native's own `TextProps`. */
interface DataSetProps {
  readonly dataSet?: Readonly<Record<string, string>>;
}

export default function MaterialCommunityIconsDouble({
  name,
  size,
  color,
  style,
  ...rest
}: IconSetProps): ReactNode {
  const dataSet: DataSetProps = { dataSet: { iconName: name } };
  return (
    <Text
      {...rest}
      {...dataSet}
      // The vendor's name, surfaced so a test can assert WHICH icon was asked for rather than
      // inferring it from a glyph it cannot read. `dataSet` rather than a bare `data-icon-name`
      // prop: react-native-web drops unknown props on a `Text` and forwards only this, which is
      // its documented route to a `data-*` attribute.
      style={[{ fontSize: size, lineHeight: size, color, minWidth: size }, style]}
    >
      {name}
    </Text>
  );
}
