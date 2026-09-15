import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { SearchField } from './SearchField.js';

const light = buildComponentTokens(lightColors).field;
const dark = buildComponentTokens(darkColors).field;

const noop = (): void => undefined;

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');

/**
 * The search bound, read from the two authorities that own it — **never from the component**.
 *
 * `SearchField.tsx` keeps `SEARCH_MAX_QUERY` module-private for exactly this reason: importing it
 * and asserting the field agrees with it would restate the implementation in test syntax and pin
 * nothing (BRIEF §6.1g). So the expectation comes from TSD §5.4's parameter table, which *decides*
 * the ceiling, and from the one place the code *declares* it. A drift in the document, the
 * declaration or the field turns one of the assertions below red.
 *
 * **The second authority moved at P28 and this reader followed it.** It used to be
 * `apps/server/src/routes/meals.ts`, which held its own `.max(100)` — one of three separate
 * declarations of 100, the shape R-78 is about. The figure now lives once, in
 * `packages/contracts/src/schemas.ts`, which both the route and this component read, so a
 * server/app divergence is unrepresentable rather than merely untested. That also means this file
 * can no longer claim anything about *enforcement*: a regex over a route never really did, and
 * there is no longer a literal there to find. The enforcement claim is asserted executably in
 * `apps/server/src/routes/meals.integration.test.ts` instead — a query at the ceiling accepted, one
 * over it answered 400 — which kills an off-by-one in either direction as no source read can.
 *
 * Read as source text rather than imported, even though `@nutritime/contracts` *is* importable
 * here, and the reason is the same BRIEF §6.1g: the component reads that constant, so importing it
 * would make the expectation and the subject one value. TSD has no export, and a test-time
 * `readFileSync` creates no runtime dependency — `packages/contracts/src/package.test.ts` reads
 * the manifest from disk on the same reasoning.
 *
 * **It throws on anything other than exactly one figure.** A reader that silently found nothing
 * would leave the ceiling unpinned while reporting success, which is the same defect as the bound
 * it exists to check (BRIEF §6.1o's corollary).
 */
function ceilingFrom(relativePath: string, pattern: RegExp): number {
  const text = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  const found = [...text.matchAll(pattern)];
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one search-query bound in ${relativePath}, found ${String(found.length)}`,
    );
  }
  const digits = found[0]?.[1];
  if (digits === undefined) {
    throw new Error(`the search-query bound in ${relativePath} captured no figure`);
  }
  return Number(digits);
}

/** TSD §5.4, `GET /api/v1/meals`: "| `query` | string | 1–100 chars |". */
function documentedCeiling(): number {
  return ceilingFrom('TSD.md', /\|\s*`query`\s*\|\s*string\s*\|\s*1[–—-](\d+)\s*chars\s*\|/g);
}

/** `packages/contracts`'s single declaration, which the route's `querySchema` and this field read. */
function declaredCeiling(): number {
  return ceilingFrom(
    'packages/contracts/src/schemas.ts',
    /export const MEAL_QUERY_MAX_LENGTH = (\d+);/g,
  );
}

/**
 * A string of `length` characters in which **position is visible**: a repeated character would let
 * a mutant reporting a different string of the right length pass the prefix comparisons below.
 */
function typedText(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  while (text.length < length) {
    text += alphabet;
  }
  return text.slice(0, length);
}

/** What `onChangeText` reports when a change event carries `text`. */
function reportOf(text: string): string {
  let reported = '<nothing reported>';
  const container = render(
    <SearchField
      testID="s"
      value=""
      onChangeText={(next) => {
        reported = next;
      }}
    />,
  );
  act(() => {
    fireEvent.change(input(container), { target: { value: text } });
  });
  return reported;
}

function input(container: HTMLElement): HTMLElement {
  const found = container.querySelector('input, textarea');
  if (!(found instanceof HTMLElement)) {
    throw new Error('no text input rendered');
  }
  return found;
}

describe('SearchField', () => {
  it('is a search landmark, so the glyph is never what says what this is', () => {
    // React Native 0.86 has no `searchbox` role for the input itself, and `role="search"` on an
    // `<input>` would be invalid ARIA, so the landmark goes on the container where it is correct.
    // This is the assertion that keeps the component honest if the icon ever fails to render.
    const container = render(<SearchField testID="s" value="" onChangeText={noop} />);
    expect(getByRole(container, 'search')).toBe(element(container, 's'));
  });

  it('always has an accessible name, defaulted, and never leans on the placeholder for one', () => {
    // TSD 6.7 gives this component no `label`, so the name is the only thing a screen reader has.
    // A placeholder is not a name: it disappears the moment the user types.
    const defaulted = render(
      <SearchField testID="s" value="" onChangeText={noop} placeholder="Search meals" />,
    );
    const named = render(
      <SearchField
        testID="s"
        value=""
        onChangeText={noop}
        accessibilityLabel="Search the catalog"
      />,
    );

    expect(input(defaulted).getAttribute('aria-label')).toBe('Search');
    expect(input(defaulted).getAttribute('placeholder')).toBe('Search meals');
    expect(input(named).getAttribute('aria-label')).toBe('Search the catalog');
  });

  it('keeps the leading icon decorative, so the field is not announced twice', () => {
    const container = render(<SearchField testID="s" value="" onChangeText={noop} />);
    const icon = container.querySelector('[aria-hidden="true"]');

    expect(icon).not.toBeNull();
    if (!(icon instanceof HTMLElement)) {
      throw new Error('no icon rendered');
    }
    expect(icon.style.color).toBe(asRendered(light.placeholder));
  });

  it('offers a clear control only when there is something to clear', () => {
    const empty = render(<SearchField testID="s" value="" onChangeText={noop} />);
    const filled = render(<SearchField testID="s" value="laksa" onChangeText={noop} />);

    expect(queryByRole(empty, 'button', { name: 'Clear search' })).toBeNull();
    expect(getByRole(filled, 'button', { name: 'Clear search' })).toBeTruthy();
  });

  it('empties the field through the same callback the user types into', () => {
    // Not internal state: the value is the caller's, so clearing it has to be reported rather
    // than performed. A component that emptied its own copy would desync from the screen.
    let latest = 'laksa';
    const container = render(
      <SearchField
        testID="s"
        value="laksa"
        onChangeText={(next) => {
          latest = next;
        }}
      />,
    );

    press(getByRole(container, 'button', { name: 'Clear search' }));
    expect(latest).toBe('');
  });

  it('reports what the user typed', () => {
    let typed = '';
    const container = render(
      <SearchField
        testID="s"
        value=""
        onChangeText={(next) => {
          typed = next;
        }}
      />,
    );

    act(() => {
      fireEvent.change(input(container), { target: { value: 'pie' } });
    });
    expect(typed).toBe('pie');
  });

  it('submits on the return key, and only when a handler was given', () => {
    let submissions = 0;
    const container = render(
      <SearchField
        testID="s"
        value="pie"
        onChangeText={noop}
        onSubmit={() => {
          submissions += 1;
        }}
      />,
    );

    act(() => {
      fireEvent.keyDown(input(container), { key: 'Enter' });
    });
    expect(submissions).toBe(1);

    // Without a handler the same key press must not throw.
    const plain = render(<SearchField testID="s" value="pie" onChangeText={noop} />);
    act(() => {
      fireEvent.keyDown(input(plain), { key: 'Enter' });
    });
    expect(submissions).toBe(1);
  });

  it('meets the build-to touch target as a minimum, not as a height', () => {
    const trough = element(render(<SearchField testID="s" value="" onChangeText={noop} />), 's');

    expect(trough.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(trough.style.height).toBe('');
    expect(trough.style.maxHeight).toBe('');
  });

  it('thickens its boundary on focus without changing the box it occupies', () => {
    const container = render(<SearchField testID="s" value="" onChangeText={noop} />);
    const trough = element(container, 's');
    const field = input(container);

    const outer = (node: HTMLElement): number =>
      Number.parseFloat(node.style.borderTopWidth) + Number.parseFloat(node.style.paddingLeft);
    const resting = outer(trough);

    act(() => {
      field.focus();
    });

    expect(trough.style.borderTopWidth).toBe(`${String(light.borderWidthFocused)}px`);
    expect(trough.style.borderTopColor).toBe(asRendered(light.borderColorFocused));
    expect(outer(trough)).toBe(resting);
  });

  it('takes its fill from the field group in both schemes', () => {
    const inLight = element(render(<SearchField testID="s" value="" onChangeText={noop} />), 's');
    const inDark = element(
      render(<SearchField testID="s" value="" onChangeText={noop} />, 'dark'),
      's',
    );

    expect(inLight.style.backgroundColor).toBe(asRendered(light.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('carries the ceiling TSD §5.4 documents and the code declares once, on the input itself', () => {
    // The two authorities first: if the document and the code ever disagree about the bound, that
    // is the finding, and it must not be papered over by a field that agrees with one of them. TSD
    // outranks the code, so a divergence here is a defect in the declaration. There is exactly one
    // declaration to disagree with as of P28, where there used to be three.
    expect(documentedCeiling()).toBe(declaredCeiling());

    // The platform half of the bound. React Native refuses the 101st keystroke natively, and
    // react-native-web 0.21.2 forwards `maxLength` onto the DOM input, where the browser refuses
    // it and truncates an over-long paste. Asserted because it is what a real user meets — but
    // it is NOT the assertion that carries the claim: see the next test.
    const field = input(render(<SearchField testID="s" value="" onChangeText={noop} />));
    expect(field.getAttribute('maxlength')).toBe(String(documentedCeiling()));
  });

  it('never reports more text than the meals route will accept, so the 400 is unreachable', () => {
    /**
     * **R-74's actual claim, and the reason it is not asserted on the attribute.**
     *
     * `maxlength` is enforced by whoever renders, and jsdom 30.0.1 enforces nothing: an over-long
     * value assigned to an input carrying the attribute is neither truncated nor marked
     * `validity.tooLong`. So an attribute assertion is a bound this environment cannot exercise
     * (BRIEF §6.1k). What is exercised here is the text that *leaves* the component — which is
     * what `ExploreScreen` stores and `exploreFilters.ts`'s `queryFrom` forwards verbatim into the
     * `MealQuery`, trimming and re-keying it but bounding nothing.
     *
     * **`queryFrom` is deliberately not imported**: a suite in `shared/components` reaching into
     * `features/catalog` would break on a file this component does not own, and it would buy
     * nothing — the forwarding is measured end to end out of tree instead (see the A3 report).
     */
    const ceiling = documentedCeiling();
    const tooLong = typedText(ceiling + 1);

    // Non-vacuity first: the input really is over the ceiling, so the two assertions below are
    // about a truncation rather than about a string that never needed one.
    expect(tooLong).toHaveLength(ceiling + 1);
    // Then the length, then the text: a hundred-character diff of two elided strings says
    // nothing, while "expected length 101 to be 100" says exactly what went wrong.
    expect(reportOf(tooLong)).toHaveLength(ceiling);
    expect(reportOf(tooLong)).toBe(typedText(ceiling));
  });

  it('passes a query at the ceiling, and a short one, through untouched', () => {
    // The bracketing pair, so no constant can satisfy the assertions above: a field that always
    // reported 100 characters would pass them and fail here, and one that always reported the
    // text unchanged passes here and fails there.
    const ceiling = documentedCeiling();

    expect(reportOf(typedText(ceiling))).toBe(typedText(ceiling));
    expect(reportOf('laksa')).toBe('laksa');
  });

  it('renders an over-long value it was given, rather than disagreeing with its caller', () => {
    /**
     * **The boundary of this fix, asserted so nobody reads it as wider than it is.**
     *
     * The bound is on what the field *reports*, not on what it *shows*: a component rendering a
     * truncated copy of a value its screen still held would desync from it, which is the same
     * reason the clear control reports `''` instead of emptying itself.
     *
     * So a screen that acquires an over-long search some other way still reaches the request with
     * it — `ExploreScreen.tsx` seeds `search` from `readStringParam(route.params, 'query')`, which
     * bounds nothing — and this field cannot stop that. That door is `ExploreScreen.tsx`'s, and it
     * is the assistant's `seedQuestion` shape exactly.
     */
    const tooLong = typedText(documentedCeiling() + 1);
    const field = input(render(<SearchField testID="s" value={tooLong} onChangeText={noop} />));
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('the search field did not render an input');
    }

    expect(field.value).toBe(tooLong);
  });

  it('scales its type with the OS setting exactly once', () => {
    const single = input(render(<SearchField testID="s" value="" onChangeText={noop} />));
    const doubled = input(
      render(<SearchField testID="s" value="" onChangeText={noop} />, 'light', 2),
    );

    const base = Number.parseFloat(single.style.fontSize);
    expect(base).toBeGreaterThan(0);
    expect(Number.parseFloat(doubled.style.fontSize)).toBe(base * 2);
  });
});
