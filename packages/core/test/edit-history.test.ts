import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createEditHistory } from '../src/edit-history.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const defaults = {
  blockPercent: 5.6,
  contrast: 10,
  contrastEnabled: true,
  bloom: 0.12,
  bloomEnabled: true,
  ribAngle: 0,
  ribsEnabled: true,
  fringeDistance: 0.75,
  rgbFringeEnabled: true,
};

const stateA = { ...defaults, contrast: 20 };
const stateB = { ...defaults, contrast: 30, bloom: 0.5 };
const stateC = { ...defaults, contrast: 40, bloom: 0.8, ribAngle: 45 };

// ─── Constructor ─────────────────────────────────────────────────────────────

test('createEditHistory requires a non-null object initialState', () => {
  assert.throws(() => createEditHistory(), TypeError);
  assert.throws(() => createEditHistory(null), TypeError);
  assert.throws(() => createEditHistory(undefined), TypeError);
  assert.throws(() => createEditHistory('string'), TypeError);
  assert.throws(() => createEditHistory(42), TypeError);
  assert.throws(() => createEditHistory(true), TypeError);
  assert.doesNotThrow(() => createEditHistory({}));
  assert.doesNotThrow(() => createEditHistory(defaults));
});

test('initial state is frozen and returned by current()', () => {
  const history = createEditHistory(defaults);
  const current = history.current();
  assert.deepEqual(current, defaults);
  assert.ok(Object.isFrozen(current));
});

test('initial undo/redo availability is false; size is 1', () => {
  const history = createEditHistory(defaults);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  assert.equal(history.size(), 1);
});

// ─── Immutability ────────────────────────────────────────────────────────────

test('commit stores a frozen deep copy — mutating input does not affect stored state', () => {
  const history = createEditHistory(defaults);
  const original = { ...defaults, contrast: 50 };
  const committed = history.commit(original);

  original.contrast = 999;
  assert.equal(history.current().contrast, 50);
  assert.ok(Object.isFrozen(committed));
  assert.ok(Object.isFrozen(history.current()));
});

test('frozen state prevents mutation by consumers', () => {
  const history = createEditHistory(defaults);
  const current = history.current();
  assert.throws(() => { current.contrast = 999; }, { name: 'TypeError' });

  const committed = history.commit(stateA);
  assert.throws(() => { committed.blockPercent = 100; }, { name: 'TypeError' });

  const undoResult = history.undo();
  assert.ok(Object.isFrozen(undoResult.state));
});

// ─── Deduplication ───────────────────────────────────────────────────────────

test('commit deduplicates equal normalized states (no-op)', () => {
  const history = createEditHistory(defaults);
  assert.equal(history.size(), 1);

  // Same reference
  history.commit(defaults);
  assert.equal(history.size(), 1, 'same reference should dedup');

  // Different reference, equal values
  history.commit({ ...defaults });
  assert.equal(history.size(), 1, 'structural equality should dedup');

  // Different state increases size
  history.commit(stateA);
  assert.equal(history.size(), 2);
});

test('dedup returns the current (existing) state', () => {
  const history = createEditHistory(defaults);
  const result = history.commit(defaults);
  assert.strictEqual(result, history.current());
  assert.deepEqual(result, defaults);
});

test('deep equality: same values different references are equal', () => {
  const history = createEditHistory(defaults);

  const obj1 = { ...defaults, contrast: 50, nested: { value: 1 } };
  const obj2 = { ...defaults, contrast: 50, nested: { value: 1 } };

  history.commit(obj1);
  assert.equal(history.size(), 2);

  history.commit(obj2);
  assert.equal(history.size(), 2, 'should dedup structurally equal states');

  // Different nested value
  history.commit({ ...defaults, contrast: 50, nested: { value: 2 } });
  assert.equal(history.size(), 3, 'different nested value should create new state');
});

test('deep equality: arrays are compared by value', () => {
  const history = createEditHistory(defaults);

  history.commit({ ...defaults, tags: ['a', 'b'] });
  assert.equal(history.size(), 2);

  history.commit({ ...defaults, tags: ['a', 'b'] });
  assert.equal(history.size(), 2, 'same array values should dedup');

  history.commit({ ...defaults, tags: ['a', 'c'] });
  assert.equal(history.size(), 3, 'different array values should create new state');
});

// ─── Undo / Redo ─────────────────────────────────────────────────────────────

test('undo/redo availability and state transitions', () => {
  const history = createEditHistory(defaults);

  // Undo at oldest
  const undoEmpty = history.undo();
  assert.equal(undoEmpty.available, false);
  assert.deepEqual(undoEmpty.state, defaults);

  // Redo at newest
  const redoEmpty = history.redo();
  assert.equal(redoEmpty.available, false);
  assert.deepEqual(redoEmpty.state, defaults);

  // Commit, then undo
  history.commit(stateA);
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);

  const undo1 = history.undo();
  assert.equal(undo1.available, true);
  assert.deepEqual(undo1.state, defaults);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);

  // Redo back
  const redo1 = history.redo();
  assert.equal(redo1.available, true);
  assert.deepEqual(redo1.state, stateA);
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);
});

test('multi-step undo/redo round-trip', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  history.commit(stateB);
  history.commit(stateC);
  assert.equal(history.size(), 4);

  // Undo three times back to defaults
  assert.deepEqual(history.undo().state, stateB);
  assert.deepEqual(history.undo().state, stateA);
  assert.deepEqual(history.undo().state, defaults);
  assert.equal(history.canUndo(), false);

  // Redo three times back to stateC
  assert.deepEqual(history.redo().state, stateA);
  assert.deepEqual(history.redo().state, stateB);
  assert.deepEqual(history.redo().state, stateC);
  assert.equal(history.canRedo(), false);
});

// ─── Redo truncation ─────────────────────────────────────────────────────────

test('commit truncates redo stack', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  history.commit(stateB);

  // Undo twice
  history.undo(); // to stateA
  history.undo(); // to defaults

  assert.ok(history.canRedo(), 'should have redo after undo');
  // size() counts past + present only; redo stack is not counted in the cap
  assert.equal(history.size(), 1);

  // Commit new state — truncates redo
  history.commit(stateC);
  assert.equal(history.canRedo(), false, 'redo should be truncated');
  assert.equal(history.size(), 2); // defaults, stateC
  assert.deepEqual(history.current(), stateC);
});

// ─── 100-entry cap ───────────────────────────────────────────────────────────

test('cap at 100 entries: evicts oldest on overflow', () => {
  const history = createEditHistory({ id: 0 });

  // Commit 119 more states (total 120 with initial, but cap at 100)
  for (let i = 1; i < 120; i++) {
    history.commit({ id: i });
  }

  assert.equal(history.size(), 100, 'size should never exceed 100');

  // Undo back to the oldest retained state
  while (history.canUndo()) {
    history.undo();
  }
  // After 120 commits, past = [{id:20},...,{id:118}], present = {id:119}
  // The initial {id:0} through {id:19} were evicted; oldest retained is {id:20}
  assert.equal(history.current().id, 20, 'oldest retained state should be id 20');

  // Redo all the way back to newest
  while (history.canRedo()) {
    history.redo();
  }
  assert.equal(history.current().id, 119, 'newest state should be id 119');
});

test('cap at 100: exact boundary works', () => {
  const history = createEditHistory({ id: 0 });

  // Commit 99 more (total 100 — exactly at cap)
  for (let i = 1; i < 100; i++) {
    history.commit({ id: i });
  }
  assert.equal(history.size(), 100, 'should hold exactly 100 states');

  // All states 0-99 should be retained
  while (history.canUndo()) {
    history.undo();
  }
  assert.equal(history.current().id, 0, 'oldest state id 0 should be retained at exactly 100');
});

test('cap at 100: one more commit after 100 evicts oldest', () => {
  const history = createEditHistory({ id: 0 });

  for (let i = 1; i <= 100; i++) {
    history.commit({ id: i });
  }
  assert.equal(history.size(), 100);

  // Undo to oldest
  while (history.canUndo()) {
    history.undo();
  }
  // {id:0} was evicted when we committed {id:100}
  assert.equal(history.current().id, 1, 'oldest after 100 commits should be id 1');
});

// ─── reset() ─────────────────────────────────────────────────────────────────

test('reset replaces entire history with single baseline', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  history.commit(stateB);
  history.commit(stateC);
  assert.equal(history.size(), 4);
  assert.equal(history.canUndo(), true);

  const newDefaults = { ...defaults, blockPercent: 10, contrast: 0 };
  const result = history.reset(newDefaults);

  assert.equal(history.size(), 1, 'reset should leave exactly 1 state');
  assert.equal(history.canUndo(), false, 'no undo after reset');
  assert.equal(history.canRedo(), false, 'no redo after reset');
  assert.deepEqual(history.current(), newDefaults);
  assert.deepEqual(result, newDefaults);
  assert.ok(Object.isFrozen(result));
});

test('reset from empty-ish history works', () => {
  const history = createEditHistory(defaults);
  assert.equal(history.size(), 1);

  history.reset(stateA);
  assert.equal(history.size(), 1);
  assert.deepEqual(history.current(), stateA);
});

// ─── Transaction semantics ───────────────────────────────────────────────────

test('slider transaction: many current() reads, one commit()', () => {
  const history = createEditHistory(defaults);

  // Simulate slider input: many live preview values, no commit
  for (let i = 0; i < 50; i++) {
    const liveValue = 10 + i * 0.5;
    const preview = { ...defaults, contrast: liveValue };
    void preview; // computed but discarded mid-gesture (satisfies noUnusedLocals)
    // Controller reads current for live preview
    history.current();
    // No commit during slider input
  }
  assert.equal(history.size(), 1, 'no commits during slider input');

  // Slider change: commit one state from gesture-end
  const finalValue = { ...defaults, contrast: 35 };
  history.commit(finalValue);
  assert.equal(history.size(), 2, 'one commit after slider change');
  assert.deepEqual(history.current(), finalValue);

  // Second slider gesture
  for (let i = 0; i < 30; i++) {
    history.current();
  }
  history.commit({ ...defaults, contrast: 50 });
  assert.equal(history.size(), 3, 'second slider gesture commits one state');
});

test('checkbox/color edit commits once', () => {
  const history = createEditHistory(defaults);

  history.commit({ ...defaults, contrastEnabled: false });
  assert.equal(history.size(), 2);
  assert.deepEqual(history.current(), { ...defaults, contrastEnabled: false });

  history.commit({ ...defaults, negativeFringeTint: '#FF0000' });
  assert.equal(history.size(), 3);
});

test('preset apply commits one undoable state', () => {
  const history = createEditHistory(defaults);

  const presetState = { ...defaults, contrast: 50, bloom: 0.5, ribAngle: 90 };
  history.commit(presetState);
  assert.equal(history.size(), 2);
  assert.deepEqual(history.current(), presetState);

  // Undo back to defaults
  const undo = history.undo();
  assert.equal(undo.available, true);
  assert.deepEqual(undo.state, defaults);
});

test('group reset commits one undoable state', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  history.commit(stateB);

  // Group reset: restore bloom group to defaults
  const groupReset = { ...stateB, bloom: defaults.bloom, bloomEnabled: defaults.bloomEnabled };
  history.commit(groupReset);
  assert.equal(history.size(), 4);
  assert.deepEqual(history.current(), groupReset);

  // Undo group reset
  const undo = history.undo();
  assert.equal(undo.available, true);
  assert.deepEqual(undo.state, stateB);
});

test('full reset commits one undoable state', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  history.commit(stateB);
  history.commit(stateC);
  assert.equal(history.size(), 4);

  // Full reset: commit back to defaults
  history.commit(defaults);
  assert.equal(history.size(), 5);

  // Undo full reset
  const undo = history.undo();
  assert.equal(undo.available, true);
  assert.deepEqual(undo.state, stateC);
});

test('new source upload replaces history with one baseline', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  history.commit(stateB);
  assert.equal(history.size(), 3);

  const redesignedDefaults = { ...defaults, blockPercent: 10, contrast: 18 };
  history.reset(redesignedDefaults);
  assert.equal(history.size(), 1);
  assert.deepEqual(history.current(), redesignedDefaults);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});

// ─── Excluded actions — no history delta ─────────────────────────────────────

test('excluded actions do not change history', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  assert.equal(history.size(), 2);

  // Snapshot before excluded actions
  const snapshot = {
    size: history.size(),
    current: history.current(),
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
  };

  // These actions MUST NOT enter history — they simply don't call commit() or reset().
  // The controller calls none of: commit(), reset().
  // We verify the module's state is unchanged after read-only operations.

  // 1. Comparison toggle → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'comparison: size unchanged');

  // 2. Preview background change → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'background: size unchanged');

  // 3. Export scale change → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'export scale: size unchanged');

  // 4. Preset save → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'preset save: size unchanged');

  // 5. Preset export → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'preset export: size unchanged');

  // 6. Preset delete → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'preset delete: size unchanged');

  // 7. PNG export → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'PNG export: size unchanged');

  // 8. Context loss → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'context loss: size unchanged');

  // 9. Context restore → current() only
  history.current();
  assert.equal(history.size(), snapshot.size, 'context restore: size unchanged');

  // Verify all invariants preserved
  assert.deepEqual(history.current(), snapshot.current, 'current unchanged');
  assert.equal(history.canUndo(), snapshot.canUndo, 'canUndo unchanged');
  assert.equal(history.canRedo(), snapshot.canRedo, 'canRedo unchanged');
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test('commit with empty object works', () => {
  const history = createEditHistory(defaults);
  const result = history.commit({});
  assert.equal(history.size(), 2);
  assert.deepEqual(history.current(), {});
  assert.ok(Object.isFrozen(result));
});

test('commit with nested objects works', () => {
  const history = createEditHistory(defaults);
  const nested = { ...defaults, metadata: { preset: 'test', version: 1 } };
  history.commit(nested);
  assert.equal(history.size(), 2);
  assert.deepEqual(history.current(), nested);
  assert.ok(Object.isFrozen(history.current().metadata));
});

test('multiple resets in sequence work', () => {
  const history = createEditHistory(defaults);
  history.reset(stateA);
  assert.equal(history.size(), 1);
  assert.deepEqual(history.current(), stateA);

  history.reset(stateB);
  assert.equal(history.size(), 1);
  assert.deepEqual(history.current(), stateB);
});

test('undo after redo then commit correctly truncates future', () => {
  const history = createEditHistory(defaults);
  history.commit(stateA);
  history.commit(stateB);

  // Undo once, redo once, then commit new state
  history.undo(); // to stateA, past=[defaults], present=stateA, future=[stateB]
  history.redo(); // back to stateB, past=[defaults, stateA], present=stateB, future=[]

  history.commit(stateC); // past=[defaults, stateA, stateB], present=stateC, future=[]
  assert.equal(history.canRedo(), false, 'commit after redo truncates');
  assert.equal(history.size(), 4, 'defaults, stateA, stateB, stateC');
  assert.deepEqual(history.current(), stateC);
});