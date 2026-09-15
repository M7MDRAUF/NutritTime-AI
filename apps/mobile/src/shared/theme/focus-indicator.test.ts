import { describe, expect, it } from 'vitest';
import type { ColorScheme } from './semantic.js';
import { colorsByScheme } from './semantic.js';
import { buildComponentTokens } from './component.js';

/**
 * **The focus indicator, pinned to something other than itself — P23 T-23-07 / T-28-07.**
 *
 * `docs/final-audit.md` part 9: *"The app's only rendered focus indicator is unpinned. Setting
 * `borderWidthFocused` to `stroke.hairline` deletes it and changes 0 of 1048; the two assertions
 * that look like they cover it read their expectation out of the token."*
 *
 * Those two are `FormField.dom.test.tsx` and `SearchField.dom.test.tsx`, both of the shape
 *
 *     expect(field.style.borderTopWidth).toBe(`${String(light.borderWidthFocused)}px`);
 *
 * — the rendered width compared against the token it was rendered from. Both sides move together,
 * so setting `borderWidthFocused` to `stroke.hairline`, which makes the focused border identical to
 * the resting one and leaves the app with no focus indicator at all, keeps both of them green. It
 * is the same circularity `touch-target.test.ts` records for `minHeight`, and it is why the focus
 * row of the §14.2 checklist reads as run.
 *
 * **So no number below is imported, and none is read out of `component.ts` or `primitive.ts`.**
 * Each is either a literal transcribed from a document named at its declaration, or a *relation*
 * between two tokens — and the relations are the load-bearing half, because no single constant
 * satisfies both ends of one. `borderWidthFocused: stroke.hairline` fails the relation from below
 * and `borderWidth: stroke.regular` fails it from above; a constant that satisfies either fails the
 * other. That is this project's own lesson from the all-null nutrition control, which passed the
 * very mutation it existed to catch because one constant satisfied both halves (§6.2.2).
 *
 * **What PRD 10.5 does not contain, because this was checked rather than assumed.** Its four
 * bullets are roles-and-labels plus touch targets; text scaling; *"Color is never the only carrier
 * of status"*; and *"Both themes meet WCAG AA contrast where measurable"*. **The word "focus" does
 * not appear anywhere in `PRD.md`.** So `DECISIONS.md`'s reason for rejecting `outline: none` —
 * that it *"violates PRD §10.5"* — cites a requirement that document does not carry, which is
 * §6.1n's defect at a fourth site. The requirement that a focus indicator exist comes from
 * `Plan.md` §14.2's reconciliation row, which adopts the generator's *"Pre-delivery checklist
 * (contrast, focus, reduced motion, no emoji icons, responsive breakpoints)"* as **"a named gate
 * item in every frontend phase"**; T-23-07's acceptance is that checklist run in full. The
 * *measurable* part is reached through PRD 10.5's fourth bullet instead: it adopts WCAG AA, and
 * 1.4.11 Non-text Contrast is an AA criterion that covers component **states** and not only
 * components.
 *
 * **Two things this file deliberately does not assert, both measured and both honest gaps.**
 * WCAG 2.2 SC 2.4.13 Focus Appearance is AAA, is not adopted anywhere in this project, and would
 * fail twice if it were: the band of pixels that *changes* on focus is 1 px thick, not 2, because
 * the indicator thickens a 1 px border to 2 rather than adding a 2 px perimeter; and the focused
 * border against the unfocused one measures **1.2629:1 in light** and **2.8863:1 in dark** against
 * 2.4.13's 3:1 for the state change. Closing either is a change to what the app looks like, so it
 * is reported and not made. What is asserted from 2.4.13 is only its 2 px figure as a floor on the
 * focused perimeter's own thickness, which holds today.
 *
 * The colour half of the indicator is **already** pinned non-circularly, so it is not duplicated
 * here: `component-contrast.test.ts` derives its pairings by walking `buildComponentTokens` for
 * string leaves, classifies `borderColorFocused` as a boundary by its member name, and measures it
 * against every surface a screen can put a field on. Repointing it at `surface.raised` reddens that
 * file. Geometry has no such derivation, which is the whole of the gap this file closes — the same
 * seam `touch-target.test.ts` was split along.
 */

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

/**
 * **WCAG 2.2 SC 2.4.13 Focus Appearance, transcribed: the focus indicator area must be at least as
 * large as "the area of a 2 CSS pixel thick perimeter of the unfocused component".**
 *
 * 2.4.13 is AAA and is not an adopted requirement here — see the docblock. The figure is used only
 * as a floor on the focused border's own thickness, which is the reading the current design meets.
 * It is transcribed rather than derived from `stroke.regular` because `stroke.regular` is what is
 * under test: a scale change from 2 to 1 must fail against the criterion, not against its own new
 * value.
 */
const WCAG_2_4_13_PERIMETER_PX = 2;

/**
 * **The smallest difference that can render.** At a device pixel ratio of 1 — the web export on a
 * non-retina display, which `Plan.md` §20 puts in scope — a difference below 1 CSS px can round to
 * no changed pixels at all. So "thicker when focused" is not enough on its own; it has to be
 * thicker by something a display can show. Not a document's figure: the rendering model's.
 */
const RENDERABLE_DELTA_PX = 1;

/**
 * **`design-system/DECISIONS.md` §5, transcribed: "A 3 px ring at `border.focus` is adopted as
 * `focusRing.width = 3`."**
 *
 * The geometry half of that entry is a real decision and is the authority for this number. The
 * *reason* half of the neighbouring entry — that `focusRing` "is always visible and 3:1" — is
 * false, because nothing draws it; see the `focusRing` block below. Adopting a document's figure
 * while rejecting its rationale is deliberate: the figure was decided, the rationale was invented.
 */
const DECISIONS_RING_WIDTH_PX = 3;

/**
 * **The two `field` members that carry the focus state, listed rather than derived.**
 *
 * A key-set assertion in the shape §6.1g prescribes, so a third focused member — an
 * `outlineWidthFocused`, say — cannot arrive with no decision recorded about whether it is part of
 * the indicator. Deriving this list from `ComponentTokens` would make it true of whatever the type
 * happens to be.
 */
const FOCUSED_FIELD_MEMBERS: readonly string[] = ['borderColorFocused', 'borderWidthFocused'];

/** The four members TSD 6.6's ninth group declares. Same reason as above. */
const FOCUS_RING_MEMBERS: readonly string[] = ['color', 'width', 'offset', 'radius'];

describe('the focus indicator the app actually renders', () => {
  it.each(SCHEMES)('is thicker focused than unfocused in %s', (scheme) => {
    const { field } = buildComponentTokens(colorsByScheme[scheme]);

    // **The relation, and the assertion the 0-of-1048 mutation was free of.** An indicator that
    // does not differ from the resting state is not an indicator: `FormField` and `SearchField`
    // both render `focused ? borderWidthFocused : borderWidth`, so if those two are equal the app
    // has no focus indicator and both of their tests still pass.
    expect(
      field.borderWidthFocused,
      `field.borderWidthFocused is ${String(field.borderWidthFocused)} and field.borderWidth is ` +
        `${String(field.borderWidth)}; equal widths mean a focused field looks exactly like an ` +
        'unfocused one',
    ).toBeGreaterThan(field.borderWidth);

    expect(field.borderWidthFocused - field.borderWidth).toBeGreaterThanOrEqual(
      RENDERABLE_DELTA_PX,
    );
  });

  it.each(SCHEMES)(
    'keeps a resting border, so focus is a change and not a boundary in %s',
    (scheme) => {
      const { field } = buildComponentTokens(colorsByScheme[scheme]);

      // Closes the other end of the relation above, which on its own is satisfied by a field with no
      // border until it is focused: that would pass "thicker focused" while leaving the control with
      // no boundary at rest.
      //
      // `component-contrast.test.ts` does redden for both spellings of that, and for neither reason
      // — measured, because the first guess here was wrong. A real colour behind a zero width trips
      // its *agreement* check ("field.borderColor is '#64748B' and field.borderWidth is 0, which must
      // agree", 4 rows across the two schemes); `'transparent'` at width 0 agrees, and trips its
      // colour-*literal* residue count instead ("expected 5 to be 3"). Both are incidental to the
      // property. This assertion states the property.
      expect(field.borderWidth).toBeGreaterThan(0);
      expect(field.borderWidthFocused).toBeGreaterThanOrEqual(WCAG_2_4_13_PERIMETER_PX);
    },
  );

  it.each(SCHEMES)('changes colour as well as width in %s', (scheme) => {
    const { field } = buildComponentTokens(colorsByScheme[scheme]);

    // Two channels, so neither alone is the carrier. The ratio between the two colours is NOT
    // asserted: it is 1.2629:1 in light, and 2.4.13's 3:1 for a state change is AAA and unadopted.
    // What is asserted is that the colour moves at all, which is what makes the width the second
    // carrier rather than the only one.
    expect(field.borderColorFocused).not.toBe(field.borderColor);
    expect(field.borderColorFocused).not.toBe('transparent');
  });

  it('names exactly the focused members this file has decided about', () => {
    const { field } = buildComponentTokens(colorsByScheme.light);
    const focused = Object.keys(field).filter((key) => key.endsWith('Focused'));

    expect([...focused].sort()).toStrictEqual([...FOCUSED_FIELD_MEMBERS].sort());
  });

  it('sizes the indicator identically in both schemes', () => {
    // Geometry is not a scheme decision — `buildComponentTokens` takes only the colour map, so a
    // width that differed between the two could only come from a scheme-aware expression. Same
    // claim `touch-target.test.ts` makes about `minHeight`, for the same reason.
    const light = buildComponentTokens(colorsByScheme.light).field;
    const dark = buildComponentTokens(colorsByScheme.dark).field;

    expect([light.borderWidth, light.borderWidthFocused]).toEqual([
      dark.borderWidth,
      dark.borderWidthFocused,
    ]);
  });
});

/**
 * **`focusRing` — TSD 6.6's ninth group, with no consumer anywhere in the tree.**
 *
 * Measured, not inferred: `focusRing` appears in `component.ts` (its interface and its expression),
 * in `DECISIONS.md` §5's two rows, and in `docs/final-audit.md`. **In no `.ts` or `.tsx` file
 * outside `component.ts`.** Nothing renders it, which is why `DECISIONS.md`'s reason for rejecting
 * `outline: none` — that `focusRing` *"is always visible and 3:1"* — describes a ring the app never
 * draws. Its 3:1 claim happens to be true of the colour `focusRing` and the rendered border
 * **share** (`border.focus`, 3.4923:1 at worst in light on `surface.sunken`, which is the
 * "3.49:1 at worst" the neighbouring row records), so the number survived while the mechanism
 * behind it did not.
 *
 * **It is not dead code and is not deleted here.** TSD 6.6 names the nine groups
 * `buildComponentTokens` must provide and "focus ring" is the ninth, so removing it is a document
 * amendment rather than a cleanup — and removing the subject of a wrong rationale makes
 * `DECISIONS.md` unreadable rather than corrected. Nor is it unbuildable: RN 0.86.3 declares
 * `outlineColor`, `outlineOffset`, `outlineStyle` and `outlineWidth` on `ViewStyle`
 * (`node_modules/react-native/Libraries/StyleSheet/StyleSheetTypes.d.ts:496-499`), and
 * react-native-web 0.21.2 rejects only the `outline` *shorthand* (`validate.js`'s
 * `invalidShortforms`), not the longhands. So the ring is the token the indicator *should* use and
 * wiring it up is a visible change to two components this file does not own — reported, not made.
 *
 * Until then it is bounded here rather than left free to drift, in the house style
 * `touch-target.test.ts` uses for `touch.gap`: a token with no consumer gets an assertion, not a
 * consumer it does not have.
 */
describe('focusRing, the declared ring nothing draws yet', () => {
  it('names exactly the four members TSD 6.6 declares', () => {
    const { focusRing } = buildComponentTokens(colorsByScheme.light);

    expect([...Object.keys(focusRing)].sort()).toStrictEqual([...FOCUS_RING_MEMBERS].sort());
  });

  it.each(SCHEMES)('states the geometry DECISIONS.md §5 adopted, in %s', (scheme) => {
    const { focusRing } = buildComponentTokens(colorsByScheme[scheme]);

    expect(
      focusRing.width,
      `focusRing.width is ${String(focusRing.width)}; DECISIONS.md §5 adopted 3`,
    ).toBe(DECISIONS_RING_WIDTH_PX);
    // An offset is what makes it a ring around the control rather than a second border on it.
    expect(focusRing.offset).toBeGreaterThan(0);
    expect(focusRing.color).not.toBe('transparent');
  });

  it.each(SCHEMES)('sits concentric with the field it would surround, in %s', (scheme) => {
    const { field, focusRing } = buildComponentTokens(colorsByScheme[scheme]);

    // A ring drawn outside a corner needs a larger radius than the corner, or it cuts across it.
    // Relational, so it cannot be satisfied by pinning either radius to a constant.
    expect(focusRing.radius).toBeGreaterThan(field.radius);
  });

  it.each(SCHEMES)('is at least as strong as the indicator that is rendered, in %s', (scheme) => {
    const { field, focusRing } = buildComponentTokens(colorsByScheme[scheme]);

    // The two must not diverge in the direction that matters: a declared ring weaker than the
    // border the app actually thickens would mean adopting it later *reduced* the indicator.
    expect(focusRing.width).toBeGreaterThanOrEqual(field.borderWidthFocused);
  });
});
