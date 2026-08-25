import type { ParsedPreset, FilterParams } from './filter-params.ts';
import { parsePreset, serializePreset, PRESET_STORAGE_KEY, sanitizePresetName } from './filter-params.ts';

/** Minimal storage surface the preset store needs (real `Storage` or a stub). */
export type PresetStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Recoverable result of a storage-mutating preset operation (save/delete). */
export type PresetMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: 'invalid-name' }
  | { readonly ok: false; readonly error: 'duplicate'; readonly existingName: string }
  | { readonly ok: false; readonly error: 'quota' | 'storage' };

/** Result of loading or importing a preset (parse only for import). */
export type PresetLoadResult =
  | { readonly ok: true; readonly preset: ParsedPreset }
  | { readonly ok: false; readonly error: string };

/** Options for {@link savePreset}. */
export interface SavePresetOptions {
  /** Overwrite an existing preset of the same sanitized name. */
  readonly replace?: boolean;
  /** Storage backend; defaults to `localStorage`. */
  readonly storage?: PresetStorage;
}

function storageKey(name: string): string { return PRESET_STORAGE_KEY + '.' + sanitizePresetName(name); }

export function listPresets(storage: PresetStorage = localStorage): string[] {
  try {
    const raw = storage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function savePreset(name: string, params: FilterParams, { replace = false, storage = localStorage }: SavePresetOptions = {}): PresetMutationResult {
  try {
    const sanitized = sanitizePresetName(name); if (!sanitized) return { ok: false, error: 'invalid-name' };
    const names = listPresets(storage); const idx = names.findIndex((n) => sanitizePresetName(n) === sanitized);
    if (idx !== -1 && !replace) return { ok: false, error: 'duplicate', existingName: names[idx] };
    storage.setItem(storageKey(name), serializePreset(name, params));
    if (idx === -1) names.push(name.trim()); else names[idx] = name.trim();
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify(names));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof DOMException && e.name === 'QuotaExceededError' ? 'quota' : 'storage' };
  }
}

export function loadPreset(name: string, storage: PresetStorage = localStorage): PresetLoadResult {
  try {
    const raw = storage.getItem(storageKey(name));
    if (!raw) return { ok: false, error: 'not-found' };
    return { ok: true, preset: parsePreset(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function deletePreset(name: string, storage: PresetStorage = localStorage): PresetMutationResult {
  try {
    storage.removeItem(storageKey(name));
    const names = listPresets(storage).filter((n) => sanitizePresetName(n) !== sanitizePresetName(name));
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify(names));
    return { ok: true };
  } catch {
    return { ok: false, error: 'storage' };
  }
}

export function exportPresetJson(name: string, params: FilterParams): string { return serializePreset(name, params); }

export function importPresetJson(jsonString: string): PresetLoadResult {
  try {
    return { ok: true, preset: parsePreset(jsonString) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
