import { describe, expect, it } from 'vitest';
import { getByRole, queryAllByRole } from '@testing-library/dom';
import { asRendered, element, render } from './testHarness.js';
import { darkColors, lightColors } from '../theme/index.js';
import { AppText } from './AppText.js';

describe('AppText', () => {
  it('takes its size, line box and weight from the token, not from a literal', () => {
    const container = render(<AppText testID="t">Chicken tikka</AppText>);
    const text = element(container, 't');

    expect(text.style.fontSize).toBe('16px');
    expect(text.style.lineHeight).toBe('24px');
    expect(text.style.fontWeight).toBe('400');
    // The FACE, not merely "something". `not.toBe('')` could not fail given four string
    // literals in `typeFamily`, and this is the one assertion in the component suites that would
    // catch an R-32-class regression - a CSS fallback stack, or a face nothing loads.
    expect(text.style.fontFamily).toBe('Inter_400Regular');
  });

  it('doubles with a 2x OS font scale and still fixes no height', () => {
    // PRD 10.5: text scales with the device setting WITHOUT clipping. A fixed height is the way
    // that requirement is broken, so this asserts the absence of one as well as the new size.
    const container = render(<AppText testID="t">Chicken tikka</AppText>, 'light', 2);
    const text = element(container, 't');

    expect(text.style.fontSize).toBe('32px');
    expect(text.style.lineHeight).toBe('48px');
    expect(text.style.height).toBe('');
    expect(text.style.maxHeight).toBe('');
  });

  it('scales exactly once', () => {
    // 16 at 1x and 32 at 2x. If React Native's own scaling were left on, the theme's factor and
    // the platform's would compound and this would be 64 - which is what `allowFontScaling`
    // being false prevents on a device. The web export ignores that prop, so this test proves
    // the arithmetic rather than the prop; the prop is documented at its single call site.
    const single = element(render(<AppText testID="t">x</AppText>, 'light', 2), 't');
    expect(single.style.fontSize).toBe('32px');
  });

  it('renders the label step uppercase from the token', () => {
    // TSD 6.6 fixes labels as uppercase. It is decided in the theme, so no call site can render
    // a lowercase label by forgetting.
    const container = render(
      <AppText testID="t" variant="label">
        breakfast
      </AppText>,
    );
    expect(element(container, 't').style.textTransform).toBe('uppercase');
  });

  it('resolves a tone through the active scheme in both schemes', () => {
    const inLight = element(
      render(
        <AppText testID="t" tone="secondary">
          x
        </AppText>,
      ),
      't',
    );
    const inDark = element(
      render(
        <AppText testID="t" tone="secondary">
          x
        </AppText>,
        'dark',
      ),
      't',
    );

    expect(inLight.style.color).toBe(asRendered(lightColors.content.secondary));
    expect(inDark.style.color).toBe(asRendered(darkColors.content.secondary));
    expect(inLight.style.color).not.toBe(inDark.style.color);
  });

  it('reaches the accessibility tree as a heading only when given a level', () => {
    const heading = render(
      <AppText testID="t" level={2} variant="title">
        Today
      </AppText>,
    );
    expect(getByRole(heading, 'heading', { name: 'Today' })).toBeTruthy();

    const prose = render(<AppText testID="t">Today</AppText>);
    expect(queryAllByRole(prose, 'heading')).toHaveLength(0);
  });

  it('lines digits up only where asked', () => {
    const numeric = element(
      render(
        <AppText testID="t" numeric>
          420
        </AppText>,
      ),
      't',
    );
    const prose = element(render(<AppText testID="t">420</AppText>), 't');

    expect(numeric.style.fontVariant).toBe('tabular-nums');
    expect(prose.style.fontVariant).toBe('');
  });
});
