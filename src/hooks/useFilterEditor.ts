import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CONTROL_DEFINITIONS,
  createEditHistory,
  DEFAULT_FILTER_PARAMS,
  normalizeControlEdit,
  normalizeFilterParams,
  type EditHistoryAPI,
  type FilterParamKey,
} from '@voyager-labs/coarse-grid-core';

import { CONTROL_COPY, type ControlGroup } from '@/lib/control-copy';

export type { FilterParams } from '@voyager-labs/coarse-grid-core';
import type { FilterParams } from '@voyager-labs/coarse-grid-core';

// Only range sliders capture/consume a gesture baseline (mirrors script.js:
// the range `input`/`change` pair). Checkbox/color changes always commit from
// the current params (script.js non-range change path). Keyed loosely by
// string because the hook's edit API accepts any candidate key.
const RANGE_KEYS = new Set<string>(CONTROL_DEFINITIONS.filter((definition) => definition.type === 'range').map((definition) => definition.key));

export interface UseFilterEditorOptions {
  /**
   * Optional callback invoked after params change (live preview or commit) so
   * the consumer can push the latest params into the renderer. Wired to
   * `renderer.requestPreview` in App.
   */
  onPreview?: (params: FilterParams) => void;
}

export interface UseFilterEditorResult {
  /** Current filter params (mirror of `history.current()` during commits; live value mid-gesture). */
  params: FilterParams;
  /** Total committed states in history (past + present). */
  historyLength: number;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Live-preview edit (slider `input`). Normalizes + updates `params` WITHOUT a
   * history commit. Captures the pre-gesture baseline on first call so the
   * subsequent `change` commits exactly once against the gesture start.
   */
  previewEdit: (key: string, value: unknown) => void;
  /**
   * Commit-once edit (slider `change`, checkbox/color `change`). Normalizes and
   * commits a single history entry, truncating any redo. For a slider that was
   * preceded by `previewEdit` calls, commits from the captured gesture baseline
   * with the final value.
   */
  applyEdit: (key: string, value: unknown) => void;
  /** Reset one group's keys to their defaults in a single undoable commit. */
  resetGroup: (group: ControlGroup) => void;
  /** Reset all controls to defaults in a single undoable commit. */
  resetControls: () => void;
  /**
   * Apply a full set of params (e.g. a loaded preset) as a SINGLE undoable
   * history entry. Mirrors script.js:735 `history.commit(normalizeFilterParams(...))`
   * so one undo restores the pre-apply state. Unlike `resetBaseline`, this does
   * NOT clear history — it commits on top of the current history.
   */
  applyPreset: (params: FilterParams) => void;
  undo: () => void;
  redo: () => void;
  /** Replace the entire history with a fresh defaults baseline (new-source upload). */
  resetBaseline: () => void;
}

/**
 * React state hook wrapping `@voyager-labs/coarse-grid-core` edit-history + filter-params.
 *
 * Replicates the vanilla script.js transaction semantics exactly:
 *  - range `input`  → `previewEdit` (live preview, NO history commit)
 *  - range `change` → `applyEdit`   (commit once from the gesture baseline)
 *  - checkbox/color `change` → `applyEdit` (commit once from current params)
 *
 * Undo/redo mirror `history.undo()/redo()`; a new commit truncates redo (the
 * core edit-history already does this). Keyboard shortcuts (Cmd/Ctrl+Z,
 * Cmd/Ctrl+Shift+Z, Ctrl+Y) replicate script.js guards, ignored while focus is
 * in a text input.
 */
export function useFilterEditor({ onPreview }: UseFilterEditorOptions = {}): UseFilterEditorResult {
  // Lazy-initialize the immutable history once.
  const historyRef = useRef<EditHistoryAPI<FilterParams> | null>(null);
  if (historyRef.current === null) {
    historyRef.current = createEditHistory({ ...DEFAULT_FILTER_PARAMS });
  }

  const [params, setParamsState] = useState<FilterParams>(() => ({ ...DEFAULT_FILTER_PARAMS }));
  const paramsRef = useRef<FilterParams>(params);
  const gestureBaselineRef = useRef<FilterParams | null>(null);

  const [historyLength, setHistoryLength] = useState(() => historyRef.current!.size());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Keep the latest onPreview in a ref so the hook's stable callbacks can read
  // it without recreating themselves on every render.
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const emitPreview = useCallback(() => {
    onPreviewRef.current?.(paramsRef.current);
  }, []);

  const previewEdit = useCallback(
    (key: string, value: unknown) => {
      if (!gestureBaselineRef.current) gestureBaselineRef.current = historyRef.current!.current();
      const next = normalizeControlEdit(paramsRef.current, key, value);
      setParamsState({ ...next });
      paramsRef.current = next;
      emitPreview();
    },
    [emitPreview],
  );

  const applyEdit = useCallback(
    (key: string, value: unknown) => {
      const history = historyRef.current!;
      const baseline = gestureBaselineRef.current;
      let committed: FilterParams;
      if (baseline && RANGE_KEYS.has(key)) {
        // Range gesture ended: commit once against the pre-gesture baseline.
        committed = history.commit(normalizeFilterParams(normalizeControlEdit(baseline, key, value)));
        gestureBaselineRef.current = null;
      } else {
        // Checkbox / color / direct change: commit once from current params.
        committed = history.commit(normalizeFilterParams(normalizeControlEdit(paramsRef.current, key, value)));
      }
      setParamsState({ ...committed });
      paramsRef.current = committed;
      setHistoryLength(history.size());
      setCanUndo(history.canUndo());
      setCanRedo(history.canRedo());
      emitPreview();
    },
    [emitPreview],
  );

  const resetGroup = useCallback(
    (group: ControlGroup) => {
      const history = historyRef.current!;
      const groupKeys = Object.keys(CONTROL_COPY).filter((key): key is FilterParamKey => CONTROL_COPY[key][0] === group);
      const reset: FilterParams = { ...history.current() };
      // Same object as `reset`: a union FilterParamKey write needs the widened
      // value view (number | boolean | string), which every param satisfies.
      const writableReset: Record<string, number | boolean | string> = reset;
      for (const key of groupKeys) writableReset[key] = DEFAULT_FILTER_PARAMS[key];
      const committed = history.commit(normalizeFilterParams(reset));
      gestureBaselineRef.current = null;
      setParamsState({ ...committed });
      paramsRef.current = committed;
      setHistoryLength(history.size());
      setCanUndo(history.canUndo());
      setCanRedo(history.canRedo());
      emitPreview();
    },
    [emitPreview],
  );

  const resetControls = useCallback(() => {
    const history = historyRef.current!;
    const committed = history.commit({ ...DEFAULT_FILTER_PARAMS });
    gestureBaselineRef.current = null;
    setParamsState({ ...committed });
    paramsRef.current = committed;
    setHistoryLength(history.size());
    setCanUndo(history.canUndo());
    setCanRedo(history.canRedo());
    emitPreview();
  }, [emitPreview]);

  const applyPreset = useCallback(
    (params: FilterParams) => {
      const history = historyRef.current!;
      const committed = history.commit(normalizeFilterParams(params));
      gestureBaselineRef.current = null;
      setParamsState({ ...committed });
      paramsRef.current = committed;
      setHistoryLength(history.size());
      setCanUndo(history.canUndo());
      setCanRedo(history.canRedo());
      emitPreview();
    },
    [emitPreview],
  );

  const undo = useCallback(() => {
    const history = historyRef.current!;
    const result = history.undo();
    if (result.available) {
      gestureBaselineRef.current = null;
      setParamsState({ ...result.state });
      paramsRef.current = result.state;
      setHistoryLength(history.size());
      setCanUndo(history.canUndo());
      setCanRedo(history.canRedo());
      emitPreview();
    }
  }, [emitPreview]);

  const redo = useCallback(() => {
    const history = historyRef.current!;
    const result = history.redo();
    if (result.available) {
      gestureBaselineRef.current = null;
      setParamsState({ ...result.state });
      paramsRef.current = result.state;
      setHistoryLength(history.size());
      setCanUndo(history.canUndo());
      setCanRedo(history.canRedo());
      emitPreview();
    }
  }, [emitPreview]);

  const resetBaseline = useCallback(() => {
    const history = historyRef.current!;
    const baseline = normalizeFilterParams();
    history.reset(baseline);
    gestureBaselineRef.current = null;
    setParamsState({ ...baseline });
    paramsRef.current = baseline;
    setHistoryLength(history.size());
    setCanUndo(history.canUndo());
    setCanRedo(history.canRedo());
  }, []);

  // Keyboard shortcuts (replicates script.js:863-867 guards): Cmd/Ctrl+Z undo,
  // Cmd/Ctrl+Shift+Z and Ctrl+Y redo, ignored while focus is in a text input.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text') return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (((event.metaKey || event.ctrlKey) && event.key === 'z' && event.shiftKey) || (event.ctrlKey && event.key === 'y')) {
        event.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  return {
    params,
    historyLength,
    canUndo,
    canRedo,
    previewEdit,
    applyEdit,
    resetGroup,
    resetControls,
    applyPreset,
    undo,
    redo,
    resetBaseline,
  };
}
