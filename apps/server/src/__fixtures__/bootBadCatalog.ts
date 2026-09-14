/**
 * A boot fixture, not a test.
 *
 * Spawned by `boot.integration.test.ts` to prove TSD 5.1 step 2 at the PROCESS level: an
 * invalid catalog record must exit non-zero naming the record index and the field path. It
 * boots the real `bootstrap()` over a deliberately broken record, so the refusal proved is the
 * one the real entry point performs - not a re-implementation of it.
 *
 * The first command-line argument selects which shape to break, so one fixture file covers every
 * case. **Deliberately `process.argv` and not `process.env`.** This file used to read
 * `process.env['CATALOG_FIXTURE']`, which made it a third reader of the environment inside
 * `apps/server` against T-08-02's "exactly one file" - and unlike the boot test's own
 * `...process.env` spread it was not registered anywhere, so a reader auditing that acceptance
 * by grep got a different answer than the risk register promised. An argument carries the
 * selection just as well and leaves the grep at the two readers R-29 records.
 */

import { seededCatalog } from '@nutritime/catalog';
import { bootstrap } from '../index.js';

const records: readonly unknown[] = Array.isArray(seededCatalog) ? seededCatalog : [];
const first: unknown = records[0];
const valid: Record<string, unknown> =
  typeof first === 'object' && first !== null ? { ...first } : {};

function chosen(): unknown {
  switch (process.argv[2]) {
    case 'allergen-tag':
      // R-16: every field valid, the schema satisfied, and the tag resolves to no canonical
      // allergen - so the meal is offered to someone who declared a tree-nut allergy.
      return [valid, { ...valid, id: 'second-meal', allergenTags: ['treenut'] }];
    case 'empty':
      return [];
    case 'not-array':
      return { meals: [] };
    case 'duplicate':
      return [valid, { ...valid }];
    case 'mixed-version':
      return [valid, { ...valid, id: 'second-meal', catalogVersion: '9.9.9' }];
    case 'superrefine':
      // Every field individually valid; the record still forbidden.
      return [
        {
          ...valid,
          nutrition: { calories: 500, proteinGrams: 20, carbsGrams: 60, fatGrams: null },
        },
      ];
    default:
      // A field-level failure, two records in, so the INDEX has to be reported to be useful.
      return [valid, { ...valid, id: 'second-meal', preparationMinutes: -5 }];
  }
}

bootstrap({ seeded: chosen() });
