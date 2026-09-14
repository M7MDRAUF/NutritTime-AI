import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { getByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { MealCard } from './MealCard.js';
import type { MealCardProps } from './MealCard.js';

const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

const IMAGE = 'https://www.themealdb.com/images/media/meals/utxryw1511721587.jpg';
const noop = (): void => undefined;

/**
 * The five required props, once.
 *
 * Spelled out at every call site this file grew past SQG-09's 350-line cap on prop blocks alone,
 * which is the wrong reason for a file-length exception.
 */
const BASE: MealCardProps = {
  testID: 'm',
  name: 'Chicken Handi',
  imageUrl: IMAGE,
  priceLabel: '£4.20',
  preparationMinutes: 45,
  onPress: noop,
};

function cardNode(overrides: Partial<MealCardProps> = {}): ReactNode {
  return <MealCard {...BASE} {...overrides} />;
}

/** The box the photograph and the overlaid name share. It is the one element with an aspect. */
function imageBox(card: HTMLElement): HTMLElement {
  for (const node of card.querySelectorAll('*')) {
    if (node instanceof HTMLElement && node.style.aspectRatio !== '') {
      return node;
    }
  }
  throw new Error('no image box rendered');
}

/** The band the name sits on: the one element filled with `card.imageScrim`. */
function scrimBand(card: HTMLElement, scrim: string): HTMLElement {
  for (const node of imageBox(card).querySelectorAll('*')) {
    if (node instanceof HTMLElement && node.style.backgroundColor === asRendered(scrim)) {
      return node;
    }
  }
  throw new Error('no scrim rendered');
}

describe('MealCard', () => {
  it('is one control with one name, in reading order', () => {
    // A card whose tags and reason are separate elements is a card a screen-reader user has to
    // assemble by hand, and the three platforms disagree about how: iOS and Android group a
    // pressable's children, the web export would not. One name settles it.
    const card = element(
      render(
        cardNode({
          tags: ['Dinner', 'Halal'],
          reason: 'It fits your budget and your prep time.',
        }),
      ),
      'm',
    );

    expect(card.getAttribute('aria-label')).toBe(
      'Chicken Handi. £4.20. 45 minutes. Dinner, Halal. It fits your budget and your prep time.',
    );
  });

  it('drops every optional clause from the name when it is absent', () => {
    const card = element(render(cardNode()), 'm');
    expect(card.getAttribute('aria-label')).toBe('Chicken Handi. £4.20. 45 minutes');
  });

  it('spells the unit out for a screen reader and abbreviates it on screen', () => {
    // "45 min" read aloud is "45 min". The two spellings are deliberate, and this is what stops
    // one of them quietly becoming the other.
    const card = element(render(cardNode()), 'm');

    expect(card.textContent).toContain('45 min');
    expect(card.textContent).not.toContain('45 minutes');
    expect(card.getAttribute('aria-label')).toContain('45 minutes');
  });

  it('lays the name over the photograph on the scrim that was measured for it', () => {
    // `scrim.image` is the only token computed against a worst case rather than chosen, and
    // `content.onImage` is light in BOTH schemes because a photograph is not a surface this theme
    // picks. If the name were ever given a content tone instead, dark text over a darkened photo
    // would be unreadable in one of the two schemes.
    const card = element(render(cardNode()), 'm');
    const scrimmed = scrimBand(card, light.card.imageScrim);

    expect(scrimmed.textContent).toContain('Chicken Handi');

    const nameNode = scrimmed.firstElementChild;
    if (!(nameNode instanceof HTMLElement)) {
      throw new Error('no name rendered');
    }
    expect(nameNode.style.color).toBe(asRendered(light.card.imageText));
  });

  it('keeps the overlaid name light in dark as well as light', () => {
    // The one pairing in this theme that deliberately does NOT flip with the scheme.
    const inDark = scrimBand(element(render(cardNode(), 'dark'), 'm'), dark.card.imageScrim);
    const nameNode = inDark.firstElementChild;
    if (!(nameNode instanceof HTMLElement)) {
      throw new Error('no name rendered');
    }

    expect(nameNode.style.color).toBe(asRendered(dark.card.imageText));
  });

  it('puts a defined floor under the scrim, so a broken image is not a blank one', () => {
    // TSD 7.2: "a broken image is a broken image; it changes no decision the app makes." This is
    // what that costs to be true. The scrim's alpha holds AA over a pure-white photograph, which
    // is the brightest case - so the fill behind a photograph that never loads has to be no
    // brighter than white, and `card.skeleton` is.
    const card = element(render(cardNode()), 'm');
    expect(imageBox(card).style.backgroundColor).toBe(asRendered(light.card.skeleton));
  });

  it('crops nothing: the image box is the shape of the source', () => {
    // TheMealDB's `strMealThumb` images - the URLs TSD 7.2 keeps pointing at - are square. A 16:9
    // box would be a decision to cut the top and bottom off every photograph in the catalog.
    const card = element(render(cardNode()), 'm');
    expect(imageBox(card).style.aspectRatio).toBe('1 / 1');
  });

  it('says "unavailable" in words, and keeps the card openable', () => {
    // `unavailable` comes from the catalog's own `available` field. An unavailable meal is still
    // worth opening: its ingredients, allergen notices and nutrition are unchanged. So there is
    // no `aria-disabled` here - saying a working control is disabled would be the lie - and the
    // state is carried by words in two places, never by the tint alone.
    let presses = 0;
    const card = element(
      render(
        cardNode({
          unavailable: true,
          onPress: () => {
            presses += 1;
          },
        }),
      ),
      'm',
    );

    expect(card.textContent).toContain('Not available now');
    expect(card.getAttribute('aria-label')).toContain('Not available now');
    expect(card.getAttribute('aria-disabled')).toBeNull();

    press(card);
    expect(presses).toBe(1);
  });

  it('says nothing about availability when the meal is available', () => {
    const card = element(render(cardNode()), 'm');
    expect(card.textContent).not.toContain('Not available');
    expect(card.getAttribute('aria-label')).not.toContain('Not available');
  });

  it('renders tags as badges, not as controls', () => {
    // `component.ts`: "`MealCard` from `card` plus `badge`." A `Chip` is a control built to a 48
    // target, and four of them inside a card would be four times the height of the text they
    // label. The card is the control; these are labels on it.
    const card = element(render(cardNode({ tags: ['Dinner', 'Halal'] })), 'm');

    const badges = [...card.querySelectorAll('*')].filter(
      (node) =>
        node instanceof HTMLElement &&
        node.style.minHeight === `${String(light.badge.minHeight)}px`,
    );

    expect(badges.length).toBe(2);
    expect(card.querySelectorAll('[role="button"]').length).toBe(0);
    expect(light.badge.minHeight).not.toBe(light.chip.minHeight);
  });

  it('renders no tag row at all for an empty list', () => {
    // An empty array is not a row of nothing: a wrapper with a gap and no children still takes
    // space in the card.
    const withEmpty = element(render(cardNode({ tags: [] })), 'm');
    const withNone = element(render(cardNode()), 'm');

    expect(withEmpty.childElementCount).toBe(withNone.childElementCount);
  });

  it('renders the recommendation reason as its own line', () => {
    const card = element(
      render(cardNode({ reason: 'High in protein, and ready in under an hour.' })),
      'm',
    );
    expect(card.textContent).toContain('High in protein, and ready in under an hour.');
  });

  it('announces itself as a button and fires once per press', () => {
    let presses = 0;
    const container = render(
      cardNode({
        onPress: () => {
          presses += 1;
        },
      }),
    );

    press(getByRole(container, 'button', { name: /Chicken Handi/ }));
    expect(presses).toBe(1);
  });

  it('takes its surface from the card group in both schemes', () => {
    const inLight = element(render(cardNode()), 'm');
    const inDark = element(render(cardNode(), 'dark'), 'm');

    expect(inLight.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.card.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('grows at a 2x font scale instead of clipping', () => {
    const card = element(render(cardNode({ tags: ['Dinner'] }), 'light', 2), 'm');

    expect(card.style.height).toBe('');
    expect(card.style.maxHeight).toBe('');
    // The image keeps its shape while the type around it doubles.
    expect(imageBox(card).style.aspectRatio).toBe('1 / 1');
  });

  it('scales its type with the OS setting exactly once', () => {
    const base = scrimBand(
      element(render(cardNode()), 'm'),
      light.card.imageScrim,
    ).firstElementChild;
    const doubled = scrimBand(
      element(render(cardNode(), 'light', 2), 'm'),
      light.card.imageScrim,
    ).firstElementChild;

    if (!(base instanceof HTMLElement) || !(doubled instanceof HTMLElement)) {
      throw new Error('no name rendered');
    }

    const single = Number.parseFloat(base.style.fontSize);
    expect(single).toBeGreaterThan(0);
    expect(Number.parseFloat(doubled.style.fontSize)).toBe(single * 2);
  });
});
