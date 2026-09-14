import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { typeFamily, typeScale } from './primitive.js';

/**
 * The regression suite for R-32, written because nothing here could have caught it.
 *
 * `typeFamily.sans` was the CSS stack `'Inter, -apple-system, Roboto, sans-serif'` and **nothing in
 * the app loaded Inter at all** — `expo-font` was a dependency with no importer and there were no
 * font assets. Two independent failures, both invisible: React Native's native `fontFamily` takes
 * one family name and does not parse a fallback list, so on a device it matched nothing and fell
 * back to the system face; and on web the stack is real CSS, so every existing test passed and the
 * design system looked correct in exactly the environment the tests run in.
 *
 * Every assertion below is chosen so that re-introducing one half of that failure breaks it.
 */

/** The file that actually loads the faces. Read from disk, because the claim is about agreement. */
const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', '..', '..', 'App.tsx'),
  'utf8',
);

describe('the type scale names faces that exist and are loaded', () => {
  it('gives every weight in the scale a face, with no weight left over', () => {
    const weightsUsed = new Set(Object.values(typeScale).map((step) => step.fontWeight));
    const facesDeclared = new Set(Object.keys(typeFamily));
    // Both directions. A missing face means a variant renders in the system font; a surplus face
    // means bytes are loaded that no variant can select, since `AppText` takes a variant name and
    // never a raw weight.
    expect([...weightsUsed].sort()).toStrictEqual([...facesDeclared].sort());
  });

  it('names ONE family per weight, never a CSS fallback list', () => {
    for (const [weight, family] of Object.entries(typeFamily)) {
      // The direct regression: a comma is what made the old value work on web and nowhere else.
      expect(family, `${weight} must name a single family`).not.toContain(',');
      expect(family).not.toContain(' ');
      expect(family).toMatch(/^Inter_\d{3}[A-Za-z]+$/);
    }
  });

  it('loads every face the scale names, in App.tsx', () => {
    // The other half of R-32, and the half a unit test would normally miss: a token can name a
    // perfectly good face that nothing ever loads, and on web it still renders because the browser
    // falls back silently. Reading the loader from disk is the only way to assert they agree.
    for (const family of Object.values(typeFamily)) {
      expect(appSource, `App.tsx must load ${family}`).toContain(family);
    }
  });

  it('loads no face the scale cannot select', () => {
    const loaded = [...appSource.matchAll(/\bInter_\d{3}[A-Za-z]+\b/g)].map((match) => match[0]);
    expect(loaded.length).toBeGreaterThan(0);
    const declared = new Set<string>(Object.values(typeFamily));
    for (const family of loaded) {
      expect(declared.has(family), `App.tsx loads ${family}, which no variant uses`).toBe(true);
    }
  });

  it('advances past the font gate even when loading fails', () => {
    // A typeface must not be able to brick the app. Gating on `fontsLoaded` alone would hold the
    // splash forever on a device where the load failed - a blank screen with no way out.
    expect(appSource).toContain('fontError !== null');
  });
});
