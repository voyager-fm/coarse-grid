import { useCallback, useState } from 'react';

import {
  deletePreset as coreDeletePreset,
  exportPresetJson as coreExportPresetJson,
  importPresetJson as coreImportPresetJson,
  listPresets as coreListPresets,
  loadPreset as coreLoadPreset,
  savePreset as coreSavePreset,
} from '@voyager-labs/coarse-grid-core';

import type { FilterParams } from '@/hooks/useFilterEditor';

/** Storage-failure recoverable result of a preset mutation. */
export type PresetMutationResult =
  | { ok: true }
  | { ok: false; error: 'duplicate' | 'invalid-name' | 'quota' | 'storage'; existingName?: string };

/** Result of loading a preset's params (parse only, no storage mutation). */
export type PresetLoadResult = { ok: true; params: FilterParams } | { ok: false; error: string };

/** Result of importing a preset JSON file (parse-then-mutate). */
export type PresetImportResult =
  | { ok: true; name: string; params: FilterParams }
  | { ok: false; error: string };

export interface UsePresetsResult {
  /** Currently saved preset names (mirror of listPresets), refreshed on demand. */
  names: string[];
  /** Re-read the preset list from storage (e.g. after an external change). */
  refresh: () => void;
  /**
   * Save `params` under `name`. Returns `{ok:false,error:'duplicate'}` when the
   * name already exists — the UI must then require an explicit replace.
   */
  save: (name: string, params: FilterParams) => PresetMutationResult;
  /** Save `params` under `name`, overwriting an existing preset of the same name. */
  replace: (name: string, params: FilterParams) => PresetMutationResult;
  /** Delete the preset `name` from storage. */
  remove: (name: string) => void;
  /** Load a preset's params (parse only — does not mutate storage or history). */
  load: (name: string) => PresetLoadResult;
  /** Serialize `params` as a preset JSON string for `name` (download artifact). */
  exportJson: (name: string, params: FilterParams) => string;
  /**
   * Import a preset from a JSON string. PARSE-THEN-MUTATE ordering: the JSON is
   * parsed first (coreImportPresetJson); only a successfully parsed preset is
   * then saved to storage (coreSavePreset). A malformed import leaves storage
   * untouched and returns a recoverable `{ok:false,error}`.
   */
  importJson: (json: string) => PresetImportResult;
}

/**
 * React wrapper around `@voyager-labs/coarse-grid-core` preset-store. All preset-store
 * functions already swallow storage failures and return `{ok:false,error}`
 * (or `[]` for list) — this hook surfaces those as a recoverable English
 * status the PresetsPanel renders into `#preset-status`. It does NOT auto-apply
 * presets on load and does NOT persist any view state.
 */
export function usePresets(): UsePresetsResult {
  const [names, setNames] = useState<string[]>(() => coreListPresets());

  const refresh = useCallback(() => {
    setNames(coreListPresets());
  }, []);

  const save = useCallback((name: string, params: FilterParams): PresetMutationResult => {
    const result = coreSavePreset(name, params);
    if (result.ok) refresh();
    return result;
  }, [refresh]);

  const replace = useCallback((name: string, params: FilterParams): PresetMutationResult => {
    const result = coreSavePreset(name, params, { replace: true });
    if (result.ok) refresh();
    return result;
  }, [refresh]);

  const remove = useCallback(
    (name: string) => {
      coreDeletePreset(name);
      refresh();
    },
    [refresh],
  );

  const load = useCallback((name: string): PresetLoadResult => {
    const result = coreLoadPreset(name);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, params: result.preset.params };
  }, []);

  const exportJson = useCallback((name: string, params: FilterParams): string => {
    return coreExportPresetJson(name, params);
  }, []);

  const importJson = useCallback((json: string): PresetImportResult => {
    // Parse first — never mutate storage from an unparseable payload.
    const parsed = coreImportPresetJson(json);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const preset = parsed.preset;
    const saved = coreSavePreset(preset.name, preset.params);
    if (!saved.ok) return { ok: false, error: saved.error };
    refresh();
    return { ok: true, name: preset.name, params: preset.params };
  }, [refresh]);

  return { names, refresh, save, replace, remove, load, exportJson, importJson };
}
