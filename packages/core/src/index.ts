/**
 * index.ts — public entry of @voyager-labs/coarse-grid-core
 *
 * Runtime surface is IDENTICAL to the pre-TypeScript entry (same symbols, same
 * aliases, including the `createRasterFilter` alias of `createGpuFilter`); the
 * named `export type` blocks below are additive-only and erased at runtime by
 * Node's native type stripping.
 *
 * Erasable-syntax-only TypeScript: no build step, no non-erasable syntax.
 *
 * @module index
 */

export { createGpuFilter as createRasterFilter, createGpuFilter, GpuFilterError } from './gpu-filter.ts';

export {
  DEFAULT_FILTER_PARAMS,
  computeBlockResolution,
  computeBlockSize,
  computeLogicalScale,
  convertLogicalToTargetPixels,
  hexToLinearRgb,
  normalizeFilterParams,
  validateExportLimits,
  validateInputLimits,
} from './filter-params.ts';

export * from './edit-history.ts';
export * from './preset-store.ts';
export * from './filter-params.ts';

// ─── Named type surface (additive only; erased at runtime) ──────────────────

// Filter parameters and control definitions.
export type {
  FilterParams,
  FilterParamKey,
  NumericFilterParamKey,
  BooleanFilterParamKey,
  ColorFilterParamKey,
  ControlGroup,
  ControlDefinitionBase,
  RangeControlDefinition,
  ToggleControlDefinition,
  ColorControlDefinition,
  ControlDefinition,
  PresetFile,
  ParsedPreset,
  ProductLimits,
  ViewState,
} from './filter-params.ts';

// Edit history.
export type { EditHistoryStep, EditHistoryAPI } from './edit-history.ts';

// Preset store.
export type { PresetStorage, PresetMutationResult, PresetLoadResult, SavePresetOptions } from './preset-store.ts';

// GPU renderer: error-code union plus option/handle types.
export type {
  GpuErrorCode,
  GpuFilterOptions,
  GpuCapabilities,
  GpuFilterSourceInput,
  GpuFilterExportInput,
  GpuFilterExportResult,
  GpuFilterDisplayOptions,
  GpuFilterRenderer,
} from './gpu-filter.ts';

// Product-name aliases for consumers written against the renderer handle
// naming (`createRasterFilter`); same declarations as the Gpu* names above.
export type { GpuFilterRenderer as RasterFilterRenderer } from './gpu-filter.ts';
export type { GpuFilterSourceInput as RasterFilterSourceInput } from './gpu-filter.ts';
