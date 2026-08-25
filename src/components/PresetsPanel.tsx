import { useRef, useState, type FormEvent } from 'react';

import { Dialog as DialogPrimitive } from 'radix-ui';

import { presetFilename } from '@voyager-labs/coarse-grid-core';

import { usePresets } from '@/hooks/usePresets';
import type { UseFilterEditorResult } from '@/hooks/useFilterEditor';

interface PresetsPanelProps {
  /** The todo-7 filter-editor state; `params` are saved as presets and `applyPreset` commits a loaded preset as one undoable entry. */
  editor: UseFilterEditorResult;
  /** Master disable flag (`!hasSource || exportBusy || contextLost` — mirrors script.js setControlsEnabled). */
  disabled: boolean;
}

const ERROR_COPY: Record<string, string> = {
  duplicate: 'A preset with this name already exists. Use Replace to overwrite it.',
  'invalid-name': 'Please enter a valid preset name.',
  quota: 'Could not save the preset: browser storage is full.',
  storage: 'Could not save the preset: browser storage is unavailable.',
};

function statusForSave(result: { ok: boolean; error?: string }, verb: string): string {
  return result.ok ? '' : `${verb} failed: ${ERROR_COPY[result.error ?? 'storage'] ?? 'unknown storage error.'}`;
}

/**
 * Presets manager: save/replace/delete/export/import named presets via
 * `usePresets`. Renders a compact action row (`#preset-save-btn` dialog
 * trigger + `#preset-import-btn` + hidden `#preset-import-input`), the
 * `#preset-save-dialog` Radix save dialog (labelled `#preset-save-name`
 * draft field with explicit Save / Replace-when-duplicate / Cancel), a
 * `#preset-status` live region, and a `#preset-list` of `.preset-item`
 * rows — each holding the `.preset-item-name` load/select button plus its
 * own `[data-preset-action="export"]` / `[data-preset-action="delete"]`
 * buttons (`preset-export-btn-<index>` / `preset-delete-btn-<index>`,
 * keyed by `data-preset-index`). Does NOT auto-apply presets on load and
 * does NOT persist any view state.
 */
export default function PresetsPanel({ editor, disabled }: PresetsPanelProps) {
  const presets = usePresets();
  const [name, setName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const isDuplicate = trimmed.length > 0 && presets.names.some((n) => n.trim().toLowerCase() === trimmed.toLowerCase());
  const selectedName = selected && presets.names.includes(selected) ? selected : null;

  const saveEnabled = !disabled && trimmed.length > 0 && !isDuplicate;
  const replaceEnabled = !disabled && trimmed.length > 0 && isDuplicate;

  const handleDialogOpenChange = (open: boolean) => {
    setSaveOpen(open);
    if (open) {
      setName('');
      setSaveError('');
    }
  };

  const commitDialogSave = (replaceExisting: boolean) => {
    if (replaceExisting ? !replaceEnabled : !saveEnabled) return;
    const result = replaceExisting ? presets.replace(trimmed, editor.params) : presets.save(trimmed, editor.params);
    if (result.ok) {
      setSaveOpen(false);
      setName('');
      setSaveError('');
      setStatus(replaceExisting ? `Overwrote preset "${trimmed}".` : `Saved preset "${trimmed}".`);
      return;
    }
    if (result.error === 'duplicate') presets.refresh();
    const message = statusForSave(result, replaceExisting ? 'Replace' : 'Save');
    setSaveError(message);
    setStatus(message);
  };

  // Enter must only ever run the plain Save path — Replace is explicit-only.
  const handleSaveFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitDialogSave(false);
  };

  const handleDelete = (target: string) => {
    presets.remove(target);
    if (selected === target) setSelected(null);
    setStatus(`Deleted preset "${target}".`);
  };

  const handleApply = (target: string) => {
    const result = presets.load(target);
    if (result.ok) {
      editor.applyPreset(result.params);
      setSelected(target);
      setStatus(`Loaded preset "${target}".`);
    } else {
      setStatus(`Load failed: ${result.error}`);
    }
  };

  const handleExport = (target: string) => {
    const result = presets.load(target);
    if (!result.ok) {
      setStatus(`Export failed: ${result.error}`);
      return;
    }
    const json = presets.exportJson(target, result.params);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = presetFilename(target);
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== 'string') {
        setStatus('Could not read the file.');
        return;
      }
      const result = presets.importJson(text);
      if (result.ok) {
        setStatus(`Imported preset "${result.name}".`);
      } else {
        setStatus(`Import failed: ${result.error}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <fieldset className="presets-panel rounded-md border border-border p-4">
      <legend className="px-2 text-sm font-semibold text-foreground">Presets</legend>

      <div className="space-y-4">
        <DialogPrimitive.Root open={saveOpen} onOpenChange={handleDialogOpenChange}>
          <div className="presets-actions flex flex-wrap gap-2">
            <DialogPrimitive.Trigger asChild>
              <button
                id="preset-save-btn"
                type="button"
                className="min-w-[calc(50%-0.25rem)] flex-1 whitespace-nowrap rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                disabled={disabled}
              >
                Save preset
              </button>
            </DialogPrimitive.Trigger>
            <button
              id="preset-import-btn"
              type="button"
              className="min-w-[calc(50%-0.25rem)] flex-1 whitespace-nowrap rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
            >
              Import
            </button>
            <input
              ref={fileInputRef}
              id="preset-import-input"
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                handleImportFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          </div>

          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay
              id="preset-save-overlay"
              className="fixed inset-0 z-50 animate-in fade-in-0 bg-black/60 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
            />
            <DialogPrimitive.Content
              id="preset-save-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="preset-save-title"
              aria-describedby="preset-save-description"
              className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 animate-in rounded-md border border-border bg-card p-4 shadow-lg fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
              onInteractOutside={(event) => event.preventDefault()}
            >
              <DialogPrimitive.Title id="preset-save-title" className="text-sm font-semibold text-foreground">
                Save preset
              </DialogPrimitive.Title>
              <DialogPrimitive.Description id="preset-save-description" className="mt-1 text-sm text-muted-foreground">
                Name the current settings. Saving over an existing name requires an explicit replace.
              </DialogPrimitive.Description>
              <form id="preset-save-form" className="mt-3 space-y-3" onSubmit={handleSaveFormSubmit}>
                <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor="preset-save-name">
                  <span className="text-muted-foreground">Preset name</span>
                  <input
                    id="preset-save-name"
                    type="text"
                    autoFocus
                    className="w-full min-w-0 rounded-sm border border-border bg-card px-3 py-2 text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    value={name}
                    disabled={disabled}
                    aria-invalid={saveError === '' ? undefined : true}
                    aria-describedby={
                      saveError === '' ? 'preset-save-description' : 'preset-save-description preset-save-error'
                    }
                    onChange={(e) => {
                      setName(e.target.value);
                      if (saveError !== '') setSaveError('');
                    }}
                  />
                </label>
                <p
                  id="preset-save-error"
                  role="alert"
                  className={saveError === '' ? 'sr-only' : 'text-sm text-destructive'}
                >
                  {saveError}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <DialogPrimitive.Close asChild>
                    <button
                      id="preset-save-cancel-btn"
                      type="button"
                      className="rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                    >
                      Cancel
                    </button>
                  </DialogPrimitive.Close>
                  <button
                    id="preset-replace-btn"
                    type="button"
                    hidden={!isDuplicate}
                    className="rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => commitDialogSave(true)}
                    disabled={!replaceEnabled}
                  >
                    Replace "{trimmed}"
                  </button>
                  <button
                    id="preset-save-confirm-btn"
                    type="submit"
                    className="rounded-sm border border-primary bg-primary px-3 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!saveEnabled}
                  >
                    Save
                  </button>
                </div>
              </form>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <div
          id="preset-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={status === '' ? 'sr-only' : 'text-sm text-foreground'}
        >
          {status}
        </div>

        <div id="preset-list" className="preset-list flex flex-col gap-1">
          {presets.names.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved presets.</p>
          ) : (
            presets.names.map((presetName, index) => {
              const isSelected = presetName === selectedName;
              return (
                <div
                  key={presetName}
                  data-preset-index={index}
                  data-preset-name={presetName}
                  className={`preset-item flex items-center justify-between gap-2 rounded-sm border px-3 py-2 text-sm ${
                    isSelected ? 'selected border-primary bg-accent/10' : 'border-border bg-card'
                  }`}
                >
                  <button
                    type="button"
                    className="preset-item-name flex-1 text-left text-foreground"
                    data-preset-name={presetName}
                    onClick={() => handleApply(presetName)}
                  >
                    {presetName}
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      id={`preset-export-btn-${index}`}
                      type="button"
                      className="rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      data-preset-action="export"
                      data-preset-index={index}
                      data-preset-name={presetName}
                      onClick={() => handleExport(presetName)}
                      disabled={disabled}
                    >
                      Export
                    </button>
                    <button
                      id={`preset-delete-btn-${index}`}
                      type="button"
                      className="preset-delete-btn rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      data-preset-action="delete"
                      data-preset-index={index}
                      data-preset-name={presetName}
                      onClick={() => handleDelete(presetName)}
                      disabled={disabled}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </fieldset>
  );
}
