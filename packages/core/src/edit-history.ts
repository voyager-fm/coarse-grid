/**
 * edit-history.ts — Pure filter-parameter edit history module
 *
 * Bounded (100-state) immutable undo/redo history for filter parameters.
 * No DOM dependencies, no side effects on import.
 * All stored states are deeply frozen to prevent mutation.
 *
 * Transaction semantics (documented here; controller integration in Task 9):
 * - Slider `input` (live preview):          NO commit — call current() only
 * - Slider `change` (gesture end):          ONE commit from gesture-start to gesture-end
 * - Checkbox/color change:                  ONE commit
 * - Preset apply / import:                  ONE commit
 * - Group reset / full reset:               ONE commit
 * - Successful new source upload:           reset(newState) — single baseline
 * - Comparison toggle, background change,      NO commit
 *   export scale, preset save/export/delete,
 *   PNG export, context loss, context restore
 *
 * Equality uses structural JSON-equivalent deep comparison.
 * Task 9 integration should swap to normalizeFilterParams for canonical equality.
 *
 * @module edit-history
 */

/**
 * The explicit 36-key filter-parameter contract, re-homed from filter-params.
 * Re-exported so consumers of this module keep a single source of truth.
 */
export type { FilterParams } from './filter-params.ts';

/**
 * Loose structural JSON-record accepted by the history container.
 * History states are arbitrary structural JSON records (the tests commit
 * partial parameter sets, nested objects, and arrays), so the container is
 * generic over this loose record shape rather than the full 36-key
 * `FilterParams` contract.
 */
type HistoryRecord = Record<string, unknown>;

/**
 * Result of an undo/redo transition.
 * `state` is the frozen state after the transition (unchanged when unavailable).
 */
export interface EditHistoryStep<T extends HistoryRecord = HistoryRecord> {
  readonly available: boolean;
  readonly state: T & HistoryRecord;
}

/**
 * Public contract of a bounded edit history.
 *
 * Generic over the initial state shape `T`. Reads (`current`, `undo`, `redo`,
 * `commit`, `reset`) return `T & HistoryRecord`: the initial shape plus an index
 * signature covering dynamically committed keys (states are structural JSON
 * records cloned and deep-frozen by the history).
 */
export interface EditHistoryAPI<T extends HistoryRecord = HistoryRecord> {
  /**
   * Commit a new state. Deduplicates equal states, truncates redo.
   * When the cap would be exceeded, evicts the oldest state.
   * Returns the newly committed (frozen) state.
   */
  commit(state: HistoryRecord): T & HistoryRecord;
  /** Undo to the previous state. */
  undo(): EditHistoryStep<T>;
  /** Redo to the next state. */
  redo(): EditHistoryStep<T>;
  /** Whether undo is available. */
  canUndo(): boolean;
  /** Whether redo is available. */
  canRedo(): boolean;
  /** The current state (frozen). */
  current(): T & HistoryRecord;
  /** Total number of states in history (past + present). Never exceeds 100. */
  size(): number;
  /** Replace the entire history with a single-state baseline. Used for new successful source upload. */
  reset(newState: HistoryRecord): T & HistoryRecord;
}

/**
 * Create a bounded edit history container.
 *
 * The initial filter state is the first committed state and must be a non-null
 * object; anything else (including primitives) is rejected at runtime with a
 * TypeError, which is why the loose overload below accepts `unknown`.
 *
 * @throws {TypeError} If initialState is not a non-null object.
 */
export function createEditHistory<T extends HistoryRecord>(initialState: T): EditHistoryAPI<T>;
export function createEditHistory(initialState?: unknown): EditHistoryAPI<HistoryRecord>;
export function createEditHistory(initialState?: unknown): EditHistoryAPI<HistoryRecord> {
  if (!isHistoryState(initialState)) {
    throw new TypeError('createEditHistory requires a non-null object initialState');
  }

  // Past states, oldest first.
  const past: HistoryRecord[] = [];

  // Current state (frozen).
  let present: HistoryRecord = deepFreeze(deepClone(initialState));

  // Future/redo states, oldest first (pop from end).
  const future: HistoryRecord[] = [];

  const MAX_SIZE = 100;

  return {
    commit(state) {
      const normalized = deepClone(state);
      const frozen = deepFreeze(normalized);

      // Dedup: skip if structurally equal to current
      if (deepEqual(frozen, present)) return present;

      // Push current to past
      past.push(present);

      // Evict oldest if cap exceeded (past + present > 100)
      if (past.length + 1 > MAX_SIZE) {
        past.shift();
      }

      present = frozen;

      // Truncate redo on any successful commit
      future.length = 0;

      return present;
    },

    undo() {
      if (past.length === 0) {
        return { available: false, state: present };
      }
      const previous = past[past.length - 1];
      past.pop();
      future.push(present);
      present = previous;
      return { available: true, state: present };
    },

    redo() {
      if (future.length === 0) {
        return { available: false, state: present };
      }
      const next = future[future.length - 1];
      future.pop();
      past.push(present);
      present = next;
      return { available: true, state: present };
    },

    canUndo() { return past.length > 0; },

    canRedo() { return future.length > 0; },

    current() { return present; },

    size() { return past.length + 1; },

    reset(newState) {
      const normalized = deepClone(newState);
      past.length = 0;
      future.length = 0;
      present = deepFreeze(normalized);
      return present;
    },
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Runtime guard mirroring the historical acceptance rule: any non-null,
 * non-undefined object (arrays included) is accepted as a history state.
 */
function isHistoryState(value: unknown): value is HistoryRecord {
  return value !== null && value !== undefined && typeof value === 'object';
}

/** True for non-array objects, i.e. string-keyed JSON records. */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-clone a JSON-serializable value.
 * The record overload preserves the caller's object type.
 */
function deepClone(value: HistoryRecord): HistoryRecord;
function deepClone(value: unknown): unknown;
function deepClone(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (!isJsonRecord(value)) {
    if (Array.isArray(value)) return value.map((element) => deepClone(element));
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    result[key] = deepClone(value[key]);
  }
  return result;
}

/**
 * Deep-freeze a value (recursive Object.freeze).
 * The record overload preserves the caller's object type.
 */
function deepFreeze(value: HistoryRecord): HistoryRecord;
function deepFreeze(value: unknown): unknown;
function deepFreeze(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return Object.freeze(value);
  if (Object.isFrozen(value)) return value;
  if (!isJsonRecord(value)) {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    }
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Structural deep equality for JSON-serializable values.
 * Compares object keys, array elements, and primitives.
 *
 * Note: Task 9 integration should swap to normalizeFilterParams for
 * canonical equality that handles parameter-specific normalization.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isJsonRecord(a) && isJsonRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    keysA.sort();
    keysB.sort();
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      if (!deepEqual(a[keysA[i]], b[keysB[i]])) return false;
    }

    return true;
  }

  return false;
}
