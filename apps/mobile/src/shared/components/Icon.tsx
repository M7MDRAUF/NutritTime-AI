/**
 * Icons, from Material Community Icons (TSD §6.7).
 *
 * **This replaced a Unicode glyph map, and the history is worth keeping.** TSD §2.1 pinned no icon
 * library, so T-12-04 built one character per name and drew it in a `Text` — the only thing that
 * renders on iOS, Android and the web export with nothing installed, since DECISIONS.md §5 rejects
 * emoji outright. It was a correct answer to that constraint and a bad answer to the problem: **a
 * glyph renders only if the resolved face has it, and a face that lacks one draws a tofu box rather
 * than falling back.** `search` was U+2315, quite possibly absent from Inter and needed by
 * `SearchField`; and there is no house, chat or gear character with dependable coverage at all, so
 * the five tabs had no icons. The agent that built it said so plainly instead of papering over it,
 * which is the only reason it became a decision rather than a defect found on a device.
 *
 * The user amended §2.1 (A-11, R-33). `@expo/vector-icons` ships the font WITH the app, so a glyph
 * either exists or fails at build time rather than silently at render time on one device.
 *
 * **The public API did not change** — same `IconName`, same `ICON_NAMES`, same props — so nothing
 * written against the glyph map needed editing. That was the point of deriving `IconName` from the
 * map (S-12) rather than hand-listing it.
 *
 * Material Community Icons rather than Feather, for one reason that matters: **Feather has no
 * filled heart.** Favourites need filled and outline to be different marks, because PRD §10.5
 * forbids colour as the only carrier of a state, and MCI carries an explicit `-outline` variant for
 * every icon here.
 */

import type { ReactNode } from 'react';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * This app's names, mapped to the set's.
 *
 * The indirection is deliberate and is the reason swapping the implementation cost no consumer a
 * line: a screen asks for `search`, not for `magnify`, so the set is replaceable and a component
 * never encodes which vendor is behind it. Every value is verified against the shipped
 * `MaterialCommunityIcons.json` glyph map by `Icon.dom.test.tsx`, so a typo is a failing test
 * rather than a blank square.
 */
const GLYPHS = {
  /** Confirmation, and a selected chip. */
  check: 'check',
  /** Dismiss — the action. `danger` is the one that means failure. */
  close: 'close',
  plus: 'plus',
  minus: 'minus',
  chevronLeft: 'chevron-left',
  chevronRight: 'chevron-right',
  chevronUp: 'chevron-up',
  chevronDown: 'chevron-down',
  /** Navigating back. An arrow, because a chevron alone is a disclosure indicator. */
  arrowLeft: 'arrow-left',
  arrowRight: 'arrow-right',
  /** The glyph that forced this change: it was U+2315, and now it is a real magnifier. */
  search: 'magnify',
  heart: 'heart',
  heartOutline: 'heart-outline',
  star: 'star',
  info: 'information-outline',
  warning: 'alert-outline',
  /** A failure, not a dismissal — which is why it is a filled circle and `close` is not. */
  danger: 'close-circle-outline',

  // ---- Added with the set, because the components that needed them asked and could not have them.
  /** `MealCard`'s prep time, which was rendering a bare "45 min" with no mark. */
  clock: 'clock-outline',
  /** `OfflineState`, which was using `warning` — "caution" rather than "not connected". */
  offline: 'cloud-off-outline',
  /** `EmptyState`, which was using `info` and said so was the weakest of its six choices. */
  inbox: 'inbox-outline',
  /** `FormField`'s inline error: "invalid", where `danger` reads as "failed". */
  alertCircle: 'alert-circle-outline',
  /** `MealCard`'s tag badges, which were text-only. */
  tag: 'tag-outline',

  // ---- The tab bar, which had `tabBarIcon: () => null` because no character was dependable.
  home: 'home-outline',
  explore: 'compass-outline',
  assistant: 'message-outline',
  saved: 'bookmark-outline',
  settings: 'cog-outline',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof GLYPHS;

function isIconName(value: string): value is IconName {
  return Object.hasOwn(GLYPHS, value);
}

/**
 * The runtime witness for `IconName` (DECISIONS.md S-12).
 *
 * Filtered through a type guard rather than cast from `Object.keys`, and derived from the map
 * rather than typed out beside it: a name added to `GLYPHS` appears here, and a hand-written list
 * is how a name ends up in the union with nothing behind it.
 */
export const ICON_NAMES: readonly IconName[] = Object.keys(GLYPHS).filter(isIconName);

/** Exported for the test that checks every value against the vendor's glyph map. */
export const GLYPH_NAMES: Readonly<Record<IconName, string>> = GLYPHS;

export interface IconProps {
  readonly name: IconName;
  /** Defaults to the body line box. Pass a resolved token, never a number literal. */
  readonly size?: number;
  /** Defaults to `content.primary`. Pass a token colour, never a literal. */
  readonly color?: string;
  /** Omit it when the icon repeats a label beside it - see below. */
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

export function Icon({ name, size, color, accessibilityLabel, testID }: IconProps): ReactNode {
  const { typography, colors } = useTheme();
  // The body LINE box, not the body font size: an icon set to the line height sits exactly as
  // tall as the sentence beside it, and because `typography` is already scaled it grows with the
  // OS font setting without this component knowing the setting exists (PRD §10.5).
  const glyphSize = size ?? typography.body.lineHeight;
  const decorative = accessibilityLabel === undefined;

  return (
    <MaterialCommunityIcons
      name={GLYPHS[name]}
      size={glyphSize}
      color={color ?? colors.content.primary}
      testID={testID}
      // Still `allowFontScaling={false}`: the set renders a `Text` underneath, `glyphSize` already
      // carries the OS factor from `typography`, and letting React Native apply it again would
      // scale a 2x setting to 4x.
      allowFontScaling={false}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={accessibilityLabel}
      // An icon inside a labelled control is decoration, and announcing it makes a screen reader
      // say the same thing twice. Hidden on all three platforms: `aria-hidden` is what the web
      // export reads, and the other two are what iOS and Android read.
      aria-hidden={decorative ? true : undefined}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}
    />
  );
}
