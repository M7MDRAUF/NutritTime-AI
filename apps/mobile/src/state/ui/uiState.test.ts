import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI,
  STORAGE_DEFINITIONS,
  UI_TABS,
} from '../../infrastructure/storage/definitions.js';
import { uiActions, uiReducer, uiStoreConfig } from './uiState.js';
import type { UiState } from './uiState.js';

/**
 * T-18-01, whose acceptance is "`lastTab` and disclaimer flag persist".
 *
 * Two of these tests are the whole point of the module. The no-op tab change is asserted with
 * `toBe`, because `toEqual` would pass against a reducer that allocated a new object every press —
 * and a new reference is a queued storage write (`createStore`'s projection effect is keyed on
 * `state`). And the projection is run through the `ui` key's OWN schema, so the reducer is proved
 * unable to produce a value its key would reject: that is P14's CRITICAL defect, where a store held
 * a value its schema refused, the write persisted, and the next launch quarantined the entry.
 *
 * There is no test for `ui/cleared` because there is deliberately no such action; `uiState.ts`
 * carries the reasoning where a reader of the module will find it.
 */

const fresh: UiState = uiStoreConfig.create(DEFAULT_UI);

function projectionIsStorable(state: UiState): boolean {
  return STORAGE_DEFINITIONS.ui.schema.safeParse(uiStoreConfig.project(state)).success;
}

describe('uiReducer', () => {
  it('records a tab the user moved to, and leaves the disclaimer alone', () => {
    const moved = uiReducer(
      { lastTab: 'home', disclaimerAcknowledged: true },
      uiActions.changeTab('saved'),
    );

    expect(moved.lastTab).toBe('saved');
    // A tab change must not disturb the acknowledgement: they share a key, and a reducer that
    // rebuilt the object from the tab alone would silently un-acknowledge the safety disclaimer.
    expect(moved.disclaimerAcknowledged).toBe(true);
  });

  it('returns state IDENTICALLY for a tab change to the tab already stored', () => {
    const state: UiState = { lastTab: 'explore', disclaimerAcknowledged: false };

    // `toBe`, not `toEqual`. An allocating branch is equal-but-not-identical, and every tab press
    // would then queue a storage write.
    expect(uiReducer(state, uiActions.changeTab('explore'))).toBe(state);
  });

  it('returns state IDENTICALLY when the disclaimer is acknowledged twice', () => {
    const acknowledged = uiReducer(fresh, uiActions.acknowledgeDisclaimer());

    expect(acknowledged.disclaimerAcknowledged).toBe(true);
    expect(acknowledged).not.toBe(fresh);
    expect(uiReducer(acknowledged, uiActions.acknowledgeDisclaimer())).toBe(acknowledged);
  });
});

describe('uiStoreConfig', () => {
  it('round-trips a stored record through create and project, so both fields persist', () => {
    const stored = { lastTab: 'settings', disclaimerAcknowledged: true } as const;

    // The acceptance row, stated as a property: what storage gave us is what storage gets back.
    // A `create` that dropped either field would restore a default and lose the user's answer.
    expect(uiStoreConfig.project(uiStoreConfig.create(stored))).toStrictEqual(stored);
  });

  it('projects every tab in UI_TABS to a value the ui key accepts', () => {
    // Exhaustive over the tab list rather than a sample, so a tab added to `UI_TABS` without a
    // matching schema guard fails here instead of on a user's next launch.
    for (const tab of UI_TABS) {
      const state = uiReducer(fresh, uiActions.changeTab(tab));
      expect(projectionIsStorable(state), tab).toBe(true);
      expect(projectionIsStorable(uiReducer(state, uiActions.acknowledgeDisclaimer())), tab).toBe(
        true,
      );
    }
    // And the fallback shape itself, which is what a first launch projects.
    expect(projectionIsStorable(fresh)).toBe(true);
  });
});
