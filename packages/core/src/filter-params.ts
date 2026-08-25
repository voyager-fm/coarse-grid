/**
 * filter-params.ts — Filter parameter definitions, normalization, and limits
 *
 * Pure module: no DOM dependencies, no side effects on import.
 * Owns the authoritative CONTROL_DEFINITIONS table (the single source of truth
 * for the 36 filter parameters), default values, normalization/clamping, size
 * and GPU-limit checks, and preset (de)serialization.
 *
 * Erasable-syntax-only TypeScript: types are stripped by Node's native type
 * stripping; there is no build step and no non-erasable syntax (no enum,
 * namespace, decorator, or parameter property).
 *
 * @module filter-params
 */

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

/**
 * The normalized filter-parameter contract: exactly 36 keys.
 * Numbers for range controls, booleans for toggles, uppercase hex strings for
 * colors — derived from the CONTROL_DEFINITIONS truth and the unit tests.
 */
export type FilterParams = {
  blockPercent: number;
  posterization: number;
  contrast: number;
  contrastEnabled: boolean;
  bloom: number;
  bloomEnabled: boolean;
  bloomHighlightLow: number;
  bloomHighlightHigh: number;
  ribAngle: number;
  ribPitch: number;
  ribLowLuminanceWidth: number;
  ribHighLuminanceWidth: number;
  ribLowLuminanceDarkness: number;
  ribHighLuminanceDarkness: number;
  ribLowLuminanceValueScale: number;
  ribHighLuminanceValueScale: number;
  ribLowLuminanceSaturationScale: number;
  ribHighLuminanceSaturationScale: number;
  luminanceLow: number;
  luminanceHigh: number;
  luminanceGamma: number;
  ribEdgeSoftness: number;
  ribsEnabled: boolean;
  fringeDistance: number;
  fringeProbeDistance: number;
  fringeIntensity: number;
  fringeTintMix: number;
  fringeEdgeLow: number;
  fringeEdgeHigh: number;
  fringeRibEdgeLow: number;
  fringeRibEdgeHigh: number;
  fringeMinimumRibEdgeContribution: number;
  blockFringeGain: number;
  negativeFringeTint: string;
  positiveFringeTint: string;
  rgbFringeEnabled: boolean;
};

/** Every filter-parameter key. */
export type FilterParamKey = keyof FilterParams;
/** Keys whose normalized value is a number (range controls). */
export type NumericFilterParamKey = { [K in keyof FilterParams]: FilterParams[K] extends number ? K : never }[keyof FilterParams];
/** Keys whose normalized value is a boolean (toggles). */
export type BooleanFilterParamKey = { [K in keyof FilterParams]: FilterParams[K] extends boolean ? K : never }[keyof FilterParams];
/** Keys whose normalized value is a hex string (colors). */
export type ColorFilterParamKey = { [K in keyof FilterParams]: FilterParams[K] extends string ? K : never }[keyof FilterParams];

/** Control group membership used by the app's UI groupings. */
export type ControlGroup = 'block' | 'bloom' | 'ribs' | 'fringe';

/** A numeric range control definition. */
export interface RangeControlDefinition extends ControlDefinitionBase {
  readonly key: NumericFilterParamKey;
  readonly type: 'range';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  readonly defaultValue: number;
}

/** A boolean toggle control definition. */
export interface ToggleControlDefinition extends ControlDefinitionBase {
  readonly key: BooleanFilterParamKey;
  readonly type: 'boolean';
  readonly defaultValue: boolean;
}

/** An opaque sRGB color control definition. */
export interface ColorControlDefinition extends ControlDefinitionBase {
  readonly key: ColorFilterParamKey;
  readonly type: 'color';
  readonly defaultValue: string;
}

/**
 * Fields present on every control definition. Range-only fields are optional
 * here and redeclared as required on `RangeControlDefinition`, so the union can
 * be read generically while narrowing restores the required fields.
 */
export interface ControlDefinitionBase {
  readonly key: FilterParamKey;
  readonly label: string;
  readonly defaultValue: number | boolean | string;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

/** Discriminated union of every control definition kind. */
export type ControlDefinition = RangeControlDefinition | ToggleControlDefinition | ColorControlDefinition;

/** A serialized preset file (canonical schema/version envelope). */
export interface PresetFile {
  readonly schema: 'coarse-grid/preset';
  readonly version: 1;
  readonly name: string;
  readonly params: FilterParams;
}

/** Result of parsing a preset: the validated name plus normalized params. */
export interface ParsedPreset {
  readonly name: string;
  readonly params: FilterParams;
}

/** Product export scales (percent), in ascending order. */
export const EXPORT_SCALES: readonly number[] = freeze([25, 50, 75, 100, 125, 150, 200]);

/** Product upload/export pixel and axis limits. */
export interface ProductLimits {
  readonly maxInputPixels: number;
  readonly maxInputAxis: number;
  readonly maxExportPixels: number;
  readonly maxExportAxis: number;
  readonly maxPixels: number;
  readonly maxAxis: number;
}

export const PRODUCT_LIMITS: ProductLimits = freeze({
  maxInputPixels: 40_000_000, maxInputAxis: 16_384,
  maxExportPixels: 8_000_000, maxExportAxis: 16_384,
  maxPixels: 8_000_000, maxAxis: 16_384,
});

export const DEFAULT_FILTER_PARAMS: FilterParams = freeze({
  blockPercent: 5.6, posterization: 0.83, contrast: 18, contrastEnabled: true,
  bloom: 0.12, bloomEnabled: true, bloomHighlightLow: 0.35, bloomHighlightHigh: 0.82,
  ribAngle: 0, ribPitch: 16, ribLowLuminanceWidth: 1, ribHighLuminanceWidth: 2.25,
  ribLowLuminanceDarkness: 0.45, ribHighLuminanceDarkness: 0.65,
  ribLowLuminanceValueScale: 0.52, ribHighLuminanceValueScale: 0.72,
  ribLowLuminanceSaturationScale: 0.90, ribHighLuminanceSaturationScale: 1.05,
  luminanceLow: 0.45, luminanceHigh: 0.88, luminanceGamma: 1.25,
  ribEdgeSoftness: 0.65, ribsEnabled: true,
  fringeDistance: 0.75, fringeProbeDistance: 10, fringeIntensity: 0.32,
  fringeTintMix: 0.08, fringeEdgeLow: 0.01, fringeEdgeHigh: 0.04,
  fringeRibEdgeLow: 0.35, fringeRibEdgeHigh: 1.20,
  fringeMinimumRibEdgeContribution: 0.15, blockFringeGain: 0.9,
  negativeFringeTint: '#00C7FF', positiveFringeTint: '#FF1475', rgbFringeEnabled: true,
});

/** App view state, kept separate from the filter parameters. */
export interface ViewState {
  readonly previewBackground: string;
  readonly exportScale: number;
  readonly comparison: boolean;
}

export const DEFAULT_VIEW_STATE: ViewState = freeze({
  previewBackground: '#FFFFFF',
  exportScale: 100,
  comparison: false,
});

const range = (key: NumericFilterParamKey, min: number, max: number, step: number, label: string, unit = ''): RangeControlDefinition =>
  freeze({ key, type: 'range', min, max, step, label, unit, defaultValue: DEFAULT_FILTER_PARAMS[key] });
const toggle = (key: BooleanFilterParamKey, label: string): ToggleControlDefinition =>
  freeze({ key, type: 'boolean', label, defaultValue: DEFAULT_FILTER_PARAMS[key] });
const color = (key: ColorFilterParamKey, label: string): ColorControlDefinition =>
  freeze({ key, type: 'color', label, defaultValue: DEFAULT_FILTER_PARAMS[key] });

export const CONTROL_DEFINITIONS: readonly ControlDefinition[] = freeze([
  range('blockPercent', 1, 50, 0.1, 'Block size', '%'), range('posterization', 0, 1, 0.01, 'Posterization'), range('contrast', -100, 100, 1, 'Contrast'), toggle('contrastEnabled', 'Contrast enabled'),
  range('bloom', 0, 1, 0.01, 'Bloom'), toggle('bloomEnabled', 'Bloom enabled'), range('bloomHighlightLow', 0, 1, 0.001, 'Bloom highlight low'), range('bloomHighlightHigh', 0, 1, 0.001, 'Bloom highlight high'),
  range('ribAngle', 0, 180, 1, 'Rib angle', '°'), range('ribPitch', 2, 64, 0.25, 'Rib pitch', 'lu'), range('ribLowLuminanceWidth', 0, 16, 0.05, 'Low-luminance rib width', 'lu'), range('ribHighLuminanceWidth', 0, 16, 0.05, 'High-luminance rib width', 'lu'),
  range('ribLowLuminanceDarkness', 0, 1, 0.01, 'Low-luminance darkness'), range('ribHighLuminanceDarkness', 0, 1, 0.01, 'High-luminance darkness'),
  range('ribLowLuminanceValueScale', 0, 2, 0.01, 'Low-luminance value scale'), range('ribHighLuminanceValueScale', 0, 2, 0.01, 'High-luminance value scale'),
  range('ribLowLuminanceSaturationScale', 0, 2, 0.01, 'Low-luminance saturation scale'), range('ribHighLuminanceSaturationScale', 0, 2, 0.01, 'High-luminance saturation scale'),
  range('luminanceLow', 0, 1, 0.001, 'Luminance low'), range('luminanceHigh', 0, 1, 0.001, 'Luminance high'), range('luminanceGamma', 0.1, 4, 0.05, 'Luminance gamma'), range('ribEdgeSoftness', 0, 4, 0.05, 'Rib edge softness', 'lu'), toggle('ribsEnabled', 'Ribs enabled'),
  range('fringeDistance', 0, 8, 0.05, 'Fringe distance', 'lu'), range('fringeProbeDistance', 1, 32, 0.25, 'Fringe probe distance', 'lu'), range('fringeIntensity', 0, 2, 0.01, 'Fringe intensity'), range('fringeTintMix', 0, 1, 0.01, 'Fringe tint mix'), range('fringeEdgeLow', 0, 1, 0.0001, 'Fringe edge low'), range('fringeEdgeHigh', 0, 1, 0.0001, 'Fringe edge high'), range('fringeRibEdgeLow', 0, 4, 0.05, 'Fringe rib-edge low', 'lu'), range('fringeRibEdgeHigh', 0, 4, 0.05, 'Fringe rib-edge high', 'lu'), range('fringeMinimumRibEdgeContribution', 0, 1, 0.01, 'Fringe minimum rib-edge contribution'), range('blockFringeGain', 0, 3, 0.05, 'Block fringe gain'),
  color('negativeFringeTint', 'Negative fringe tint'), color('positiveFringeTint', 'Positive fringe tint'), toggle('rgbFringeEnabled', 'RGB fringe enabled'),
]);

/** Key-widened view of the definitions map: lookups accept any candidate key string. */
type DefinitionIndex = {
  has(key: string): boolean;
  get(key: string): ControlDefinition | undefined;
};
const definitions: DefinitionIndex = new Map<FilterParamKey, ControlDefinition>(
  CONTROL_DEFINITIONS.map((definition): [FilterParamKey, ControlDefinition] => [definition.key, definition]),
);
const pairs = freeze([
  ['bloomHighlightLow', 'bloomHighlightHigh'], ['luminanceLow', 'luminanceHigh'], ['fringeEdgeLow', 'fringeEdgeHigh'], ['fringeRibEdgeLow', 'fringeRibEdgeHigh'],
] as const);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// Supported boolean inputs are booleans, serialized 'true'/'false', and numeric 1/0.
function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return fallback;
}

function snapToStep(value: number, definition: RangeControlDefinition): number {
  const snapped = definition.min + Math.round((clamp(value, definition.min, definition.max) - definition.min) / definition.step) * definition.step;
  return Number(snapped.toFixed(10));
}

export function srgbChannelToLinear(value: unknown): number {
  const channel = clamp(finiteNumber(value, 0), 0, 1);
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export const srgbToLinear = srgbChannelToLinear;
export const srgbEotf = srgbChannelToLinear;

export function linearToSrgb(value: unknown): number {
  const channel = clamp(finiteNumber(value, 0), 0, 1);
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

export const srgbOetf = linearToSrgb;

export function hexToSrgb(hex: unknown, fallback = '#FFFFFF'): number[] {
  const match = typeof hex === 'string' && /^#([0-9a-f]{6})$/i.exec(hex);
  const source = match ? match[1] : /^#([0-9a-f]{6})$/i.exec(fallback)?.[1] ?? 'FFFFFF';
  return [0, 2, 4].map((offset) => Number.parseInt(source.slice(offset, offset + 2), 16) / 255);
}

export function hexToLinearRgb(hex: unknown, fallback?: string): number[] { return hexToSrgb(hex, fallback).map(srgbChannelToLinear); }
export function srgbToHex(rgb: readonly number[]): string { return `#${rgb.map((value) => Math.round(clamp(finiteNumber(value, 0), 0, 1) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`; }
export function linearRgbToHex(rgb: readonly number[]): string { return srgbToHex(rgb.map(linearToSrgb)); }

/**
 * Runtime narrowing used by the pair-normalization loops. Unreachable in
 * practice (both endpoints of every stored pair are range controls), but
 * required because Map.get cannot encode key-correlated value types.
 */
function isRangeDefinition(definition: ControlDefinition | undefined): definition is RangeControlDefinition {
  return definition?.type === 'range';
}

/** Inputs (typed partial, untrusted record, or none) normalize into the full 36-key shape plus a mixed dynamic view. */
export function normalizeFilterParams(params?: Record<string, unknown>): FilterParams & Record<string, number | boolean | string>;
export function normalizeFilterParams(params: Record<string, unknown> = {}): Record<string, unknown> {
  const normalized = { ...DEFAULT_FILTER_PARAMS };
  for (const definition of CONTROL_DEFINITIONS) {
    if (!(definition.key in params)) continue;
    const value = params[definition.key];
    if (definition.type === 'range') normalized[definition.key] = snapToStep(finiteNumber(value, definition.defaultValue), definition);
    else if (definition.type === 'boolean') normalized[definition.key] = normalizeBoolean(value, definition.defaultValue);
    else normalized[definition.key] = srgbToHex(hexToSrgb(value, definition.defaultValue));
  }
  for (const [low, high] of pairs) {
    if (normalized[low] < normalized[high]) continue;
    const highDefinition = definitions.get(high);
    const lowDefinition = definitions.get(low);
    if (!isRangeDefinition(highDefinition) || !isRangeDefinition(lowDefinition)) continue;
    if (normalized[low] < highDefinition.max) normalized[high] = snapToStep(normalized[low] + highDefinition.step, highDefinition);
    else {
      normalized[high] = highDefinition.max;
      normalized[low] = snapToStep(highDefinition.max - lowDefinition.step, lowDefinition);
    }
  }
  return normalized;
}

export function normalizeControlEdit(params: Record<string, unknown>, key: string, value: unknown): FilterParams & Record<string, number | boolean | string> {
  if (!definitions.has(key)) return normalizeFilterParams(params);
  const next = normalizeFilterParams(params);
  const definition = definitions.get(key);
  if (definition === undefined) return next;
  if (definition.type === 'range') next[key] = snapToStep(finiteNumber(value, definition.defaultValue), definition);
  else if (definition.type === 'boolean') next[key] = normalizeBoolean(value, definition.defaultValue);
  else next[key] = srgbToHex(hexToSrgb(value, definition.defaultValue));
  for (const [low, high] of pairs) {
    const lowDefinition = definitions.get(low);
    const highDefinition = definitions.get(high);
    if (!isRangeDefinition(lowDefinition) || !isRangeDefinition(highDefinition)) continue;
    if (key === low && next[low] >= next[high]) next[low] = snapToStep(next[high] - lowDefinition.step, lowDefinition);
    if (key === high && next[high] <= next[low]) next[high] = snapToStep(next[low] + highDefinition.step, highDefinition);
  }
  return next;
}

export const normalizeFilterParamEdit = normalizeControlEdit;

export function computeLogicalScale(width: number, height: number): number {
  const shortEdge = Math.min(Number(width), Number(height));
  return shortEdge / 1000;
}

/**
 * Converts logical-unit (lu) spatial parameters to target pixels.
 * Uses the canonical short-edge scale: min(w,h)/1000.
 * This makes the filter resolution-independent — the same lu values
 * produce proportionally larger/smaller pixel effects at any output size.
 */
export interface LogicalSpatialParams {
  readonly ribPitch: number;
  readonly ribLowLuminanceWidth: number;
  readonly ribHighLuminanceWidth: number;
  readonly ribEdgeSoftness: number;
  readonly fringeDistance: number;
  readonly fringeProbeDistance: number;
  readonly fringeRibEdgeLow: number;
  readonly fringeRibEdgeHigh: number;
}

export function convertLogicalToTargetPixels<T extends LogicalSpatialParams>(params: T, targetWidth: number, targetHeight: number): T {
  const scale = computeLogicalScale(targetWidth, targetHeight);
  const toPx = (lu: number): number => lu * scale;
  return {
    ...params,
    ribPitch: toPx(params.ribPitch),
    ribLowLuminanceWidth: toPx(params.ribLowLuminanceWidth),
    ribHighLuminanceWidth: toPx(params.ribHighLuminanceWidth),
    ribEdgeSoftness: toPx(params.ribEdgeSoftness),
    fringeDistance: toPx(params.fringeDistance),
    fringeProbeDistance: toPx(params.fringeProbeDistance),
    fringeRibEdgeLow: toPx(params.fringeRibEdgeLow),
    fringeRibEdgeHigh: toPx(params.fringeRibEdgeHigh),
  };
}

export function computeBlockSize(width: number, height: number, blockPercent?: number): number {
  const shortEdge = Math.min(Number(width), Number(height));
  if (!Number.isFinite(shortEdge) || shortEdge <= 0) throw new RangeError('target dimensions must be positive');
  return Math.max(1, Math.round(shortEdge * finiteNumber(blockPercent, DEFAULT_FILTER_PARAMS.blockPercent) / 100));
}

export const getBlockSize = computeBlockSize;
export const calculateBlockSize = computeBlockSize;

export function computeBlockResolution(width: number, height: number, blockSize: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !Number.isInteger(blockSize) || blockSize <= 0) throw new RangeError('dimensions and block size must be positive integers');
  return { width: Math.ceil(width / blockSize), height: Math.ceil(height / blockSize) };
}

export const getBlockResolution = computeBlockResolution;
export const calculateBlockResolution = computeBlockResolution;

export function getNominalBlockTaps(blockX: number, blockY: number, blockSize: number, width: number, height: number): { x: number; y: number }[] {
  const taps: { x: number; y: number }[] = [];
  for (let ty = 0; ty < 4; ty += 1) for (let tx = 0; tx < 4; tx += 1) {
    taps.push({ x: clamp(blockX * blockSize + tx * blockSize / 4 + blockSize / 8, 0, width - 1), y: clamp(blockY * blockSize + ty * blockSize / 4 + blockSize / 8, 0, height - 1) });
  }
  return taps;
}

export function getExportDimensions(sourceWidth: number, sourceHeight: number, scale: number): { width: number; height: number; pixels: number } {
  const width = Math.max(1, Math.round(Number(sourceWidth) * Number(scale) / 100));
  const height = Math.max(1, Math.round(Number(sourceHeight) * Number(scale) / 100));
  return { width, height, pixels: width * height };
}

export function sanitizeStem(name: string): string { return String(name ?? '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'image'; }
export const sanitizeFilenameStem = sanitizeStem;
export function getExportFilename(stem: string, scale: number): string { const safeScale = Number(scale); return `${sanitizeStem(stem)}-grid${safeScale === 100 ? '' : `-${safeScale}`}.png`; }
export const makeExportFilename = getExportFilename;

/** Input shape accepted by intersectGpuLimits (regl capability values or camel-case aliases). */
export interface GpuCapabilitiesInput {
  readonly maxViewportDims?: readonly number[];
  readonly MAX_VIEWPORT_DIMS?: readonly number[];
  readonly maxTextureSize?: number;
  readonly MAX_TEXTURE_SIZE?: number;
  readonly maxRenderbufferSize?: number;
  readonly MAX_RENDERBUFFER_SIZE?: number;
}

/** Intersected renderable size (width/height in target pixels). */
export interface GpuLimits {
  readonly width: number;
  readonly height: number;
}

/** Runtime narrowing: is a value numerically indexable (array or TypedArray view)? */
function isIndexedView(value: unknown): value is readonly number[] {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

export function intersectGpuLimits(capabilities?: GpuCapabilitiesInput | null): GpuLimits | null {
  const viewport = capabilities?.maxViewportDims ?? capabilities?.MAX_VIEWPORT_DIMS;
  const texture = capabilities?.maxTextureSize ?? capabilities?.MAX_TEXTURE_SIZE;
  const renderbuffer = capabilities?.maxRenderbufferSize ?? capabilities?.MAX_RENDERBUFFER_SIZE;
  if (!isIndexedView(viewport) || typeof texture !== 'number' || typeof renderbuffer !== 'number' || !Number.isFinite(texture) || !Number.isFinite(renderbuffer)) return null;
  return { width: Math.min(texture, renderbuffer, viewport[0]), height: Math.min(texture, renderbuffer, viewport[1]) };
}

/** Subset of product limits used per validation stage. */
export interface AxisPixelLimits {
  readonly maxPixels: number;
  readonly maxAxis: number;
}

/** Result of a target-limit validation. Flat shape (optional fields) so callers can read `.reason` on any outcome. */
export interface TargetLimitResult {
  readonly valid: boolean;
  readonly reason?: 'dimensions' | 'product' | 'gpu' | 'gpu-blocks';
  readonly blocks?: { readonly width: number; readonly height: number };
}

export function validateTargetLimits(width: number, height: number, blockSize: number, gpuLimits: GpuLimits | null | undefined, productLimits: AxisPixelLimits = PRODUCT_LIMITS): TargetLimitResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return { valid: false, reason: 'dimensions' };
  if (width * height > productLimits.maxPixels || width > productLimits.maxAxis || height > productLimits.maxAxis) return { valid: false, reason: 'product' };
  if (!gpuLimits || width > gpuLimits.width || height > gpuLimits.height) return { valid: false, reason: 'gpu' };
  const blocks = computeBlockResolution(width, height, blockSize);
  return blocks.width <= gpuLimits.width && blocks.height <= gpuLimits.height ? { valid: true, blocks } : { valid: false, reason: 'gpu-blocks', blocks };
}

export function validateRenderDimensions(width: number, height: number, blockPercent: number, gpuLimits: GpuLimits | null | undefined, productLimits: AxisPixelLimits = PRODUCT_LIMITS): TargetLimitResult & { readonly blockSize: number } {
  const blockSize = computeBlockSize(width, height, blockPercent);
  const validation = validateTargetLimits(width, height, blockSize, gpuLimits, productLimits);
  return { ...validation, blockSize };
}

export function validateInputLimits(width: number, height: number, blockSize: number, gpuLimits: GpuLimits | null | undefined, productLimits: ProductLimits = PRODUCT_LIMITS): TargetLimitResult {
  return validateTargetLimits(width, height, blockSize, gpuLimits, {
    maxPixels: productLimits.maxInputPixels,
    maxAxis: productLimits.maxInputAxis,
  });
}

export function validateExportLimits(width: number, height: number, blockSize: number, gpuLimits: GpuLimits | null | undefined, productLimits: ProductLimits = PRODUCT_LIMITS): TargetLimitResult {
  return validateTargetLimits(width, height, blockSize, gpuLimits, {
    maxPixels: productLimits.maxExportPixels,
    maxAxis: productLimits.maxExportAxis,
  });
}

export function flipRowsInPlace(bytes: Uint8Array, width: number, height: number): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || bytes.length !== width * height * 4) throw new RangeError('RGBA byte buffer dimensions do not match');
  const rowLength = width * 4;
  const scratch = new Uint8Array(rowLength);
  for (let y = 0; y < Math.floor(height / 2); y += 1) {
    const top = y * rowLength; const bottom = (height - 1 - y) * rowLength;
    scratch.set(bytes.subarray(top, top + rowLength)); bytes.copyWithin(top, bottom, bottom + rowLength); bytes.set(scratch, bottom);
  }
  return bytes;
}

// --- Preset system ---

export const PRESET_STORAGE_KEY = 'coarse-grid.presets.v1';
const VALID_KEYS: ReadonlySet<string> = new Set(CONTROL_DEFINITIONS.map((definition) => definition.key));

export function sanitizePresetName(name: string): string {
  const trimmed = String(name).trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized || 'unnamed';
}

export function presetFilename(name: string): string {
  return `${sanitizePresetName(name)}.coarse-grid-preset.json`;
}

export function parsePreset(json: string): ParsedPreset {
  // Boundary annotation: JSON.parse yields `any`; the guards below validate
  // each field before use, so pre-typing params as a record is sound.
  let parsed: { schema: unknown; version: unknown; name: unknown; params: Record<string, unknown> };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (parsed.schema !== 'coarse-grid/preset') {
    throw new Error('Invalid schema');
  }
  if (parsed.version !== 1) {
    throw new Error('Invalid version');
  }
  if (typeof parsed.name !== 'string' || parsed.name.trim().length < 1 || parsed.name.trim().length > 64) {
    throw new Error('Invalid name');
  }
  if (!parsed.params || typeof parsed.params !== 'object' || Array.isArray(parsed.params)) {
    throw new Error('Missing params');
  }
  const providedKeys = Object.keys(parsed.params);
  for (const key of providedKeys) {
    if (!VALID_KEYS.has(key)) {
      throw new Error(`Unknown parameter: ${key}`);
    }
  }
  for (const key of VALID_KEYS) {
    if (!(key in parsed.params)) {
      throw new Error(`Missing parameter: ${key}`);
    }
  }
  const normalized = normalizeFilterParams(parsed.params);
  return { name: parsed.name.trim(), params: normalized };
}

export function serializePreset(name: string, params: Record<string, unknown>): string {
  const normalized = normalizeFilterParams(params);
  const preset = {
    schema: 'coarse-grid/preset',
    version: 1,
    name: String(name).trim(),
    params: Object.fromEntries(CONTROL_DEFINITIONS.map((d): [FilterParamKey, number | boolean | string] => [d.key, normalized[d.key]])),
  };
  return JSON.stringify(preset, null, 2);
}
