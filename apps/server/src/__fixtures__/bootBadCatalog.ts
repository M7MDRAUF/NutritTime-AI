/**
 * A boot fixture, not a test.
 *
 * Spawned by `boot.integration.test.ts` to prove TSD 5.1 step 2 at the PROCESS level: an
 * invalid catalog record must exit non-zero naming the record index and the field path. It
 * boots the real `bootstrap()` over a deliberately broken record, so the refusal proved is the
 * one the real entry point performs - not a re-implementation of it.
 *
 * `CATALOG_FIXTURE` selects which shape to break, so one fixture file covers every case.
 */

import { seededCatalog } from '@nutritime/catalog';
import { bootstrap } from '../index.js';

const records: readonly unknown[] = Array.isArray(seededCatalog) ? seededCatalog : [];
const first: unknown = records[0];
const valid: Record<string, unknown> =
  typeof first === 'object' && first !== null ? { ...first } : {};

function chosen(): unknown {
  switch (process.env['CATALOG_FIXTURE']) {
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
