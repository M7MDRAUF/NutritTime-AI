import { describe, expect, it } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, iconNamesIn, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { StatusMessage } from './StatusMessage.js';
import type { StatusTone } from './StatusMessage.js';

const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

const TONES: readonly StatusTone[] = ['info', 'success', 'warning', 'danger'];

describe('StatusMessage', () => {
  it.each(TONES)('takes its %s boundary from that status role, in both schemes', (tone) => {
    const inLight = element(
      render(<StatusMessage testID="s" tone={tone} icon="info" title="T" description="D" />),
      's',
    );
    const inDark = element(
      render(
        <StatusMessage testID="s" tone={tone} icon="info" title="T" description="D" />,
        'dark',
      ),
      's',
    );

    expect(inLight.style.borderTopColor).toBe(asRendered(lightColors.status[tone]));
    expect(inDark.style.borderTopColor).toBe(asRendered(darkColors.status[tone]));
    // Dark is authored, not inverted: the two must not be the same colour.
    expect(inLight.style.borderTopColor).not.toBe(inDark.style.borderTopColor);
  });

  it('gives the four tones four different boundaries', () => {
    // A tone that looked like its neighbour would make the prop decorative. This fails if
    // `status` ever collapses two roles onto one colour.
    const borders = TONES.map(
      (tone) =>
        element(
          render(<StatusMessage testID="s" tone={tone} icon="info" title="T" description="D" />),
          's',
        ).style.borderTopColor,
    );

    expect(new Set(borders).size).toBe(TONES.length);
  });

  it('sits on the card surface, not on a status tint', () => {
    // `contrast.test.ts` verifies every text tone against canvas, raised, sunken and overlay, and
    // the ONLY foreground it verifies on a `statusSurface.*` tint is `status.*` itself. A tinted
    // panel would put `content.secondary` on an unmeasured background, so the tint is not used
    // as a fill anywhere in this component.
    const panel = element(
      render(<StatusMessage testID="s" tone="danger" icon="danger" title="T" description="D" />),
      's',
    );

    expect(panel.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(panel.style.backgroundColor).not.toBe(asRendered(light.badge.statusDangerBackground));
  });

  it('renders the icon it is given, so the tone is carried by a shape too', () => {
    // PRD 10.5: colour is never the only carrier, and `contrast.test.ts` says in as many words
    // that `icon` is required here for exactly that reason. Two different icons must produce two
    // different glyphs, or the prop is decoration.
    const warning = render(
      <StatusMessage testID="s" tone="warning" icon="warning" title="T" description="D" />,
    );
    const check = render(
      <StatusMessage testID="s" tone="warning" icon="check" title="T" description="D" />,
    );

    // By icon NAME rather than by character: `Icon` is a real set now (A-11), so the character
    // belongs to the font and jsdom cannot draw it either way. The claim being tested is unchanged
    // - two different `icon` props must produce two different marks, or the prop is decoration.
    expect(iconNamesIn(warning)).toStrictEqual(['alert-outline']);
    expect(iconNamesIn(check)).toStrictEqual(['check']);
    expect(iconNamesIn(warning)).not.toStrictEqual(iconNamesIn(check));
  });

  it('announces itself only when asked to', () => {
    // react-native-web maps `accessibilityLiveRegion: 'none'` to `aria-live="off"`, so the two
    // states are distinguishable rather than one being an absent attribute.
    const quiet = element(
      render(<StatusMessage testID="s" tone="info" icon="info" title="T" description="D" />),
      's',
    );
    const announced = element(
      render(
        <StatusMessage
          testID="s"
          tone="info"
          icon="info"
          title="T"
          description="D"
          announceOnMount
        />,
      ),
      's',
    );

    expect(quiet.getAttribute('aria-live')).toBe('off');
    expect(announced.getAttribute('aria-live')).toBe('polite');
  });

  it('renders what happened, what still works and what to do next, in that order', () => {
    // PRD 12's three clauses. The order is the claim: a reassurance printed after the action
    // button is a reassurance the user acts before reading.
    const container = render(
      <StatusMessage
        testID="s"
        tone="warning"
        icon="warning"
        title="Nutrition is unavailable"
        description="This meal's ingredients could not all be matched to published values."
        stillAvailable="Ingredients, allergens and prep time are unaffected."
        actionLabel="See how this is derived"
        onAction={() => undefined}
      />,
    );
    const text = container.textContent ?? '';

    const happened = text.indexOf('Nutrition is unavailable');
    const stillWorks = text.indexOf('Ingredients, allergens and prep time are unaffected.');
    const next = text.indexOf('See how this is derived');

    expect(happened).toBeGreaterThanOrEqual(0);
    expect(stillWorks).toBeGreaterThan(happened);
    expect(next).toBeGreaterThan(stillWorks);
  });

  it('puts the "what still works" sentence in its own bounded note', () => {
    const container = render(
      <StatusMessage
        testID="s"
        tone="info"
        icon="info"
        title="Local results only"
        description="The server did not answer."
        stillAvailable="Your saved meals are unaffected."
      />,
    );
    const note = element(container, 's-still-available');

    expect(note.textContent).toContain('Your saved meals are unaffected.');
    expect(note.textContent).not.toContain('The server did not answer.');
    expect(note.style.backgroundColor).toBe(asRendered(light.card.background));
  });

  it('renders no note and no button when neither is given', () => {
    const container = render(
      <StatusMessage testID="s" tone="info" icon="info" title="T" description="D" />,
    );

    expect(container.querySelector('[data-testid="s-still-available"]')).toBeNull();
    expect(queryByRole(container, 'button')).toBeNull();
  });

  it('renders no button when only half the action is given, and fires it when both are', () => {
    const labelOnly = render(
      <StatusMessage
        testID="s"
        tone="info"
        icon="info"
        title="T"
        description="D"
        actionLabel="Go"
      />,
    );
    expect(queryByRole(labelOnly, 'button')).toBeNull();

    let presses = 0;
    const both = render(
      <StatusMessage
        testID="s"
        tone="info"
        icon="info"
        title="T"
        description="D"
        actionLabel="Go"
        onAction={() => {
          presses += 1;
        }}
      />,
    );
    press(getByRole(both, 'button', { name: 'Go' }));
    expect(presses).toBe(1);
  });

  it('grows at a 2x font scale instead of clipping', () => {
    const panel = element(
      render(
        <StatusMessage testID="s" tone="info" icon="info" title="A long title" description="D" />,
        'light',
        2,
      ),
      's',
    );

    expect(panel.style.height).toBe('');
    expect(panel.style.maxHeight).toBe('');
    expect(panel.style.borderTopColor).toBe(asRendered(lightColors.status.info));
  });

  it('keeps the panel border at the card group’s width in dark as well as light', () => {
    const inDark = element(
      render(
        <StatusMessage testID="s" tone="success" icon="check" title="T" description="D" />,
        'dark',
      ),
      's',
    );
    expect(inDark.style.borderTopWidth).toBe(`${String(dark.card.borderWidth)}px`);
  });
});
