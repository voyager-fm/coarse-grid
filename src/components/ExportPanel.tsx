import { useMemo, useState } from 'react';

import { EXPORT_SCALES, PRODUCT_LIMITS, getExportDimensions, validateRenderDimensions } from '@voyager-labs/coarse-grid-core';

export interface RendererCapabilitiesLike {
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDims: number[];
  width: number;
  height: number;
}

interface ExportPanelProps {
  /** Loaded source dimensions, or null when no source is present. */
  sourceDims: { width: number; height: number } | null;
  /** Renderer GPU capabilities (may be null before init / mocked in probes). */
  capabilities: RendererCapabilitiesLike | null;
  /** Current blockPercent from the filter editor (drives block-FBO validation). */
  blockPercent: number;
  /** Master disable flag (`!hasSource || exportBusy || contextLost`). */
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onExport: (scale: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
}

interface ScaleOption {
  scale: number;
  valid: boolean;
}

function computeOptions(sourceDims: { width: number; height: number } | null, capabilities: RendererCapabilitiesLike | null, blockPercent: number): ScaleOption[] {
  if (!sourceDims || !capabilities) return EXPORT_SCALES.map((scale) => ({ scale, valid: false }));
  return EXPORT_SCALES.map((scale) => {
    const dims = getExportDimensions(sourceDims.width, sourceDims.height, scale);
    const validation = validateRenderDimensions(dims.width, dims.height, blockPercent, capabilities, PRODUCT_LIMITS);
    return { scale, valid: Boolean(validation.valid) };
  });
}

/**
 * Export controls: native `#export-scale` select with real `<option value>`
 * children (25–200%), per-scale option disabling against exportValidation
 * (GPU + product limits), an English dimensions summary, and an
 * undo/redo/reset/export action row. Does NOT persist the selected scale.
 */
export default function ExportPanel({
  sourceDims,
  capabilities,
  blockPercent,
  disabled,
  canUndo,
  canRedo,
  onExport,
  onUndo,
  onRedo,
  onReset,
}: ExportPanelProps) {
  const [scale, setScale] = useState(100);

  const options = useMemo(
    () => computeOptions(sourceDims, capabilities, blockPercent),
    [sourceDims, capabilities, blockPercent],
  );

  // Auto-select a valid fallback scale when the chosen scale is invalid,
  // mirroring vanilla updateExportOptions (script.js:410-417).
  const chosen = options.find((o) => o.scale === scale);
  const selected = chosen?.valid ? chosen : (options.find((o) => o.valid) ?? chosen ?? null);
  const selectedDims = sourceDims ? getExportDimensions(sourceDims.width, sourceDims.height, selected?.scale ?? scale) : null;
  const scaleDisabled = disabled || !sourceDims || !capabilities;
  const exportEnabled = !disabled && Boolean(selected?.valid);

  return (
    <div className="export-panel space-y-4">
      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-2 text-sm font-semibold text-foreground">Output</legend>

        <div className="export-scale-row flex items-center gap-3">
          <label htmlFor="export-scale" className="text-sm text-foreground">
            PNG scale
          </label>
          <select
            id="export-scale"
            className="rounded-sm border border-border bg-card px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            value={String(scale)}
            disabled={scaleDisabled}
            onChange={(e) => setScale(Number(e.target.value))}
          >
            {options.map(({ scale: s, valid }) => (
              <option key={s} value={String(s)} disabled={!valid}>
                {s}%
              </option>
            ))}
          </select>
        </div>

        <div className="export-summary mt-3 space-y-1">
          <output id="export-dimensions" className="block text-sm text-foreground">
            {selectedDims ? `${selectedDims.width}×${selectedDims.height} · ${selectedDims.pixels} pixels` : ''}
          </output>
          <p id="export-limit-message" className="text-sm text-destructive">
            {sourceDims && capabilities && !selected?.valid ? 'Selected export scale exceeds this browser\'s GPU rendering limits.' : ''}
          </p>
        </div>

        <div className="action-row mt-4 flex flex-wrap gap-2">
          <button
            id="undo-btn"
            type="button"
            className="rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onUndo}
            disabled={disabled || !canUndo}
          >
            Undo
          </button>
          <button
            id="redo-btn"
            type="button"
            className="rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onRedo}
            disabled={disabled || !canRedo}
          >
            Redo
          </button>
          <button
            id="reset-btn"
            type="button"
            className="rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onReset}
            disabled={disabled}
          >
            Reset to defaults
          </button>
          <button
            id="export-btn"
            type="button"
            className="rounded-sm border border-border bg-primary px-3 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => selected && onExport(selected.scale)}
            disabled={!exportEnabled}
          >
            Export PNG
          </button>
        </div>
      </fieldset>
    </div>
  );
}
