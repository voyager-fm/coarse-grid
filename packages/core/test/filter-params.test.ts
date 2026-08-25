import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CONTROL_DEFINITIONS, DEFAULT_FILTER_PARAMS, DEFAULT_VIEW_STATE, EXPORT_SCALES, PRODUCT_LIMITS,
  computeBlockResolution, computeBlockSize, computeLogicalScale, convertLogicalToTargetPixels,
  flipRowsInPlace, getExportDimensions,
  getExportFilename, getNominalBlockTaps, hexToLinearRgb, intersectGpuLimits,
  linearRgbToHex, normalizeControlEdit, normalizeFilterParams, sanitizeStem,
  parsePreset, serializePreset, sanitizePresetName, presetFilename, PRESET_STORAGE_KEY,
  srgbChannelToLinear, validateExportLimits, validateInputLimits, validateRenderDimensions,
} from '../src/filter-params.ts';

test('defaults, controls, and export scales match the approved contract', () => {
  assert.deepEqual(EXPORT_SCALES, [25, 50, 75, 100, 125, 150, 200]);
  assert.equal(PRODUCT_LIMITS.maxInputPixels, 40_000_000);
  assert.equal(PRODUCT_LIMITS.maxInputAxis, 16_384);
  assert.equal(PRODUCT_LIMITS.maxExportPixels, 8_000_000);
  assert.equal(PRODUCT_LIMITS.maxExportAxis, 16_384);
  assert.equal(PRODUCT_LIMITS.maxPixels, 8_000_000);
  assert.equal(PRODUCT_LIMITS.maxAxis, 16_384);
  // Verify removed keys are absent
  assert.ok(!('background' in DEFAULT_FILTER_PARAMS));
  assert.ok(!('strength' in DEFAULT_FILTER_PARAMS));
  assert.ok(!('ribLowLuminanceColor' in DEFAULT_FILTER_PARAMS));
  assert.ok(!('ribHighLuminanceColor' in DEFAULT_FILTER_PARAMS));
  // Verify new keys are present
  assert.ok('posterization' in DEFAULT_FILTER_PARAMS);
  assert.ok('ribLowLuminanceValueScale' in DEFAULT_FILTER_PARAMS);
  assert.ok('ribHighLuminanceValueScale' in DEFAULT_FILTER_PARAMS);
  assert.ok('ribLowLuminanceSaturationScale' in DEFAULT_FILTER_PARAMS);
  assert.ok('ribHighLuminanceSaturationScale' in DEFAULT_FILTER_PARAMS);
  assert.equal(CONTROL_DEFINITIONS.length, 36);
  assert.deepEqual(DEFAULT_FILTER_PARAMS, {
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
  assert.deepEqual(normalizeFilterParams(), DEFAULT_FILTER_PARAMS);
  assert.deepEqual(Object.keys(DEFAULT_FILTER_PARAMS), CONTROL_DEFINITIONS.map(({ key }) => key));
  assert.deepEqual(CONTROL_DEFINITIONS.filter(({ type }) => type === 'color').map(({ key, defaultValue }) => [key, defaultValue]), [
    ['negativeFringeTint', '#00C7FF'], ['positiveFringeTint', '#FF1475'],
  ]);
  assert.deepEqual(CONTROL_DEFINITIONS.filter(({ type }) => type === 'range').map(({ key, min, max, step }) => [key, min, max, step]), [
    ['blockPercent', 1, 50, 0.1], ['posterization', 0, 1, 0.01], ['contrast', -100, 100, 1], ['bloom', 0, 1, 0.01],
    ['bloomHighlightLow', 0, 1, 0.001], ['bloomHighlightHigh', 0, 1, 0.001],
    ['ribAngle', 0, 180, 1], ['ribPitch', 2, 64, 0.25], ['ribLowLuminanceWidth', 0, 16, 0.05], ['ribHighLuminanceWidth', 0, 16, 0.05],
    ['ribLowLuminanceDarkness', 0, 1, 0.01], ['ribHighLuminanceDarkness', 0, 1, 0.01],
    ['ribLowLuminanceValueScale', 0, 2, 0.01], ['ribHighLuminanceValueScale', 0, 2, 0.01],
    ['ribLowLuminanceSaturationScale', 0, 2, 0.01], ['ribHighLuminanceSaturationScale', 0, 2, 0.01],
    ['luminanceLow', 0, 1, 0.001], ['luminanceHigh', 0, 1, 0.001], ['luminanceGamma', 0.1, 4, 0.05], ['ribEdgeSoftness', 0, 4, 0.05],
    ['fringeDistance', 0, 8, 0.05], ['fringeProbeDistance', 1, 32, 0.25], ['fringeIntensity', 0, 2, 0.01], ['fringeTintMix', 0, 1, 0.01],
    ['fringeEdgeLow', 0, 1, 0.0001], ['fringeEdgeHigh', 0, 1, 0.0001], ['fringeRibEdgeLow', 0, 4, 0.05], ['fringeRibEdgeHigh', 0, 4, 0.05],
    ['fringeMinimumRibEdgeContribution', 0, 1, 0.01], ['blockFringeGain', 0, 3, 0.05],
  ]);
  for (const definition of CONTROL_DEFINITIONS) {
    if (definition.type === 'range') assert.ok(DEFAULT_FILTER_PARAMS[definition.key] >= definition.min && DEFAULT_FILTER_PARAMS[definition.key] <= definition.max, definition.key);
  }
});

test('DEFAULT_VIEW_STATE is separate from filter params', () => {
  assert.deepEqual(DEFAULT_VIEW_STATE, { previewBackground: '#FFFFFF', exportScale: 100, comparison: false });
  assert.ok(!('previewBackground' in DEFAULT_FILTER_PARAMS));
  assert.ok(!('exportScale' in DEFAULT_FILTER_PARAMS));
  assert.ok(!('comparison' in DEFAULT_FILTER_PARAMS));
});

test('color conversions use standard sRGB and canonical uppercase hex', () => {
  assert.equal(srgbChannelToLinear(0.5).toFixed(6), '0.214041');
  assert.deepEqual(hexToLinearRgb('#000000'), [0, 0, 0]);
  assert.equal(linearRgbToHex([1, 0, 0.21404114048223255]), '#FF0080');
  assert.equal(normalizeFilterParams({ negativeFringeTint: '#abcdef' }).negativeFringeTint, '#ABCDEF');
  assert.equal(normalizeFilterParams({ positiveFringeTint: '#abc123' }).positiveFringeTint, '#ABC123');
  assert.equal(normalizeControlEdit(DEFAULT_FILTER_PARAMS, 'positiveFringeTint', '#f0e1d2').positiveFringeTint, '#F0E1D2');
  assert.equal(normalizeFilterParams({ positiveFringeTint: 'invalid' }).positiveFringeTint, '#FF1475');
});

test('normalization clamps ranges, defaults invalid values, and retains every strict pair', () => {
  const normalized = normalizeFilterParams({ posterization: 4, ribPitch: 'bad', bloomHighlightLow: 1, bloomHighlightHigh: 0, negativeFringeTint: 'bad' });
  assert.equal(normalized.posterization, 1);
  assert.equal(normalized.ribPitch, 16);
  for (const [low, high] of [['bloomHighlightLow', 'bloomHighlightHigh'], ['luminanceLow', 'luminanceHigh'], ['fringeEdgeLow', 'fringeEdgeHigh'], ['fringeRibEdgeLow', 'fringeRibEdgeHigh']] as const) assert.ok(normalizeFilterParams({ [low]: 1, [high]: 0 })[low] < normalizeFilterParams({ [low]: 1, [high]: 0 })[high], `${low}/${high}`);
  assert.equal(normalized.negativeFringeTint, '#00C7FF');
  const edited = normalizeControlEdit(DEFAULT_FILTER_PARAMS, 'luminanceLow', 1);
  assert.ok(edited.luminanceLow < edited.luminanceHigh);
});

test('boolean normalization supports booleans, serialized true/false, and numeric 1/0', () => {
  const supportedValues = [[true, true], [false, false], ['true', true], ['false', false], [1, true], [0, false]];
  for (const [value, expected] of supportedValues) {
    assert.equal(normalizeFilterParams({ contrastEnabled: value }).contrastEnabled, expected);
    assert.equal(normalizeControlEdit(DEFAULT_FILTER_PARAMS, 'contrastEnabled', value).contrastEnabled, expected);
  }
  for (const value of ['', 'TRUE', 2, null, undefined, NaN]) {
    assert.equal(normalizeFilterParams({ contrastEnabled: value }).contrastEnabled, DEFAULT_FILTER_PARAMS.contrastEnabled);
    assert.equal(normalizeControlEdit(DEFAULT_FILTER_PARAMS, 'contrastEnabled', value).contrastEnabled, DEFAULT_FILTER_PARAMS.contrastEnabled);
  }
});

test('block size and block grid follow target short-edge rounding', () => {
  assert.equal(computeBlockSize(100, 50, 5.6), 3);
  assert.equal(computeBlockSize(1, 1, 1), 1);
  assert.deepEqual(computeBlockResolution(10, 7, 3), { width: 4, height: 3 });
});

test('partial blocks keep their nominal 4 by 4 taps and clamp each edge tap', () => {
  const taps = getNominalBlockTaps(1, 1, 4, 5, 5);
  assert.equal(taps.length, 16);
  assert.deepEqual(taps[0], { x: 4, y: 4 });
  assert.ok(taps.every((tap) => tap.x === 4 && tap.y === 4));
});

test('computeLogicalScale returns min(width,height)/1000', () => {
  assert.equal(computeLogicalScale(250, 500), 0.25);
  assert.equal(computeLogicalScale(1000, 500), 0.5);
  assert.equal(computeLogicalScale(1000, 1000), 1);
  assert.equal(computeLogicalScale(2000, 1000), 1);
  assert.equal(computeLogicalScale(2000, 2000), 2);
  assert.equal(computeLogicalScale(250, 1000), 0.25);
  assert.equal(computeLogicalScale(1000, 2000), 1);
});

test('convertLogicalToTargetPixels converts lu spatial params to target pixels', () => {
  const params = {
    ribPitch: 16, ribLowLuminanceWidth: 1, ribHighLuminanceWidth: 2.25,
    ribEdgeSoftness: 0.65, fringeDistance: 0.75, fringeProbeDistance: 10,
    fringeRibEdgeLow: 0.35, fringeRibEdgeHigh: 1.20,
    posterization: 0.83, // non-spatial param — must pass through unchanged
  };
  // At short edge 250: scale = 0.25
  const result250 = convertLogicalToTargetPixels(params, 250, 500);
  assert.equal(result250.ribPitch, 4); // 16 * 0.25
  assert.equal(result250.ribLowLuminanceWidth, 0.25); // 1 * 0.25
  assert.equal(result250.ribHighLuminanceWidth, 0.5625); // 2.25 * 0.25
  assert.equal(result250.fringeDistance, 0.1875); // 0.75 * 0.25
  assert.equal(result250.posterization, 0.83); // pass-through
  // At short edge 1000: scale = 1.0
  const result1000 = convertLogicalToTargetPixels(params, 1000, 1000);
  assert.equal(result1000.ribPitch, 16);
  assert.equal(result1000.ribLowLuminanceWidth, 1);
  assert.equal(result1000.ribHighLuminanceWidth, 2.25);
  assert.equal(result1000.fringeDistance, 0.75);
  // At short edge 2000: scale = 2.0
  const result2000 = convertLogicalToTargetPixels(params, 2000, 3000);
  assert.equal(result2000.ribPitch, 32);
  assert.equal(result2000.ribLowLuminanceWidth, 2);
  assert.equal(result2000.ribHighLuminanceWidth, 4.5);
  assert.equal(result2000.fringeDistance, 1.5);
  // Verify all 8 spatial keys are converted
  assert.equal(result2000.ribEdgeSoftness, 1.3); // 0.65 * 2
  assert.equal(result2000.fringeProbeDistance, 20); // 10 * 2
  assert.equal(result2000.fringeRibEdgeLow, 0.7); // 0.35 * 2
  assert.equal(result2000.fringeRibEdgeHigh, 2.4); // 1.20 * 2
});

test('export dimensions, stem cleanup, and filename selection are deterministic', () => {
  assert.deepEqual(getExportDimensions(3, 5, 25), { width: 1, height: 1, pixels: 1 });
  assert.deepEqual(getExportDimensions(101, 99, 150), { width: 152, height: 149, pixels: 22648 });
  assert.equal(sanitizeStem('my photo.png'), 'my_photo');
  assert.equal(getExportFilename('my photo.png', 100), 'my_photo-grid.png');
  assert.equal(getExportFilename('my photo.png', 200), 'my_photo-grid-200.png');
});

test('GPU caps intersect texture, renderbuffer, and viewport limits with product limits', () => {
  const gpu = intersectGpuLimits({ maxTextureSize: 8192, maxRenderbufferSize: 4096, maxViewportDims: [5000, 3000] });
  assert.deepEqual(gpu, { width: 4096, height: 3000 });
  assert.deepEqual(validateRenderDimensions(2000, 1000, 5.6, gpu), { valid: true, blocks: { width: 36, height: 18 }, blockSize: 56 });
  assert.equal(validateRenderDimensions(4097, 10, 5.6, gpu).reason, 'gpu');
  assert.equal(validateRenderDimensions(16_385, 1, 5.6, { width: 20_000, height: 20_000 }).reason, 'product');
  const generousGpu = { width: 20_000, height: 20_000 };
  assert.equal(validateInputLimits(16_385, 1, 1, generousGpu).reason, 'product');
  assert.equal(validateExportLimits(8_193, 1, 1, generousGpu).valid, true);
  assert.equal(validateExportLimits(2_828, 2_828, 1, generousGpu).valid, true);
  assert.equal(validateExportLimits(2_829, 2_828, 1, generousGpu).reason, 'product');
});

test('readback row flip mutates once and handles asymmetric rows', () => {
  const bytes = new Uint8Array([
    1, 1, 1, 255, 2, 2, 2, 255,
    3, 3, 3, 255, 4, 4, 4, 255,
    5, 5, 5, 255, 6, 6, 6, 255,
  ]);
  assert.strictEqual(flipRowsInPlace(bytes, 2, 3), bytes);
  assert.deepEqual(Array.from(bytes), [5, 5, 5, 255, 6, 6, 6, 255, 3, 3, 3, 255, 4, 4, 4, 255, 1, 1, 1, 255, 2, 2, 2, 255]);
  flipRowsInPlace(bytes, 2, 3);
  assert.deepEqual(Array.from(bytes.slice(0, 8)), [1, 1, 1, 255, 2, 2, 2, 255]);
});

test('PRESET_STORAGE_KEY is correct', () => {
  assert.equal(PRESET_STORAGE_KEY, 'coarse-grid.presets.v1');
});

test('sanitizePresetName and presetFilename work correctly', () => {
  assert.equal(sanitizePresetName('  My Preset!  '), 'My_Preset_');
  assert.equal(sanitizePresetName('hello-world'), 'hello-world');
  assert.equal(sanitizePresetName(''), 'unnamed');
  assert.equal(presetFilename('My Preset'), 'My_Preset.coarse-grid-preset.json');
  assert.equal(presetFilename('hello'), 'hello.coarse-grid-preset.json');
});

test('preset round-trip produces canonical JSON', () => {
  const name = 'My Look';
  const customParams = { ...DEFAULT_FILTER_PARAMS, posterization: 0.5, contrast: 42 };
  const json = serializePreset(name, customParams);
  const parsed = parsePreset(json);
  assert.equal(parsed.name, 'My Look');
  // Verify posterization was snapped
  assert.equal(parsed.params.posterization, 0.5);
  assert.equal(parsed.params.contrast, 42);
  // Verify all keys match
  const expectedKeys = CONTROL_DEFINITIONS.map((d) => d.key).sort();
  assert.deepEqual(Object.keys(parsed.params).sort(), expectedKeys);
  // Serialize again and compare byte-for-byte
  const json2 = serializePreset(parsed.name, parsed.params);
  assert.equal(json, json2);
});

test('preset serialized JSON contains no removed keys', () => {
  const json = serializePreset('Test', DEFAULT_FILTER_PARAMS);
  assert.ok(!json.includes('"background"'));
  assert.ok(!json.includes('"strength"'));
  assert.ok(!json.includes('"ribLowLuminanceColor"'));
  assert.ok(!json.includes('"ribHighLuminanceColor"'));
  assert.ok(!json.includes('"previewBackground"'));
  assert.ok(!json.includes('"exportScale"'));
  assert.ok(!json.includes('"comparison"'));
});

test('parsePreset rejects version 2', () => {
  const json = JSON.stringify({ schema: 'coarse-grid/preset', version: 2, name: 'Test', params: {} });
  assert.throws(() => parsePreset(json), /Invalid version/);
});

test('parsePreset rejects unknown schema', () => {
  const json = JSON.stringify({ schema: 'wrong', version: 1, name: 'Test', params: {} });
  assert.throws(() => parsePreset(json), /Invalid schema/);
});

test('parsePreset rejects unknown key strength', () => {
  const params = Object.fromEntries(CONTROL_DEFINITIONS.map((d) => [d.key, d.defaultValue]));
  params.strength = 0.5;
  const json = JSON.stringify({ schema: 'coarse-grid/preset', version: 1, name: 'Test', params });
  assert.throws(() => parsePreset(json), /Unknown parameter: strength/);
});

test('parsePreset rejects missing posterization', () => {
  const params = Object.fromEntries(CONTROL_DEFINITIONS.map((d) => [d.key, d.defaultValue]));
  delete params.posterization;
  const json = JSON.stringify({ schema: 'coarse-grid/preset', version: 1, name: 'Test', params });
  assert.throws(() => parsePreset(json), /Missing parameter: posterization/);
});

test('parsePreset rejects invalid name (empty, too long)', () => {
  const params = Object.fromEntries(CONTROL_DEFINITIONS.map((d) => [d.key, d.defaultValue]));
  let json = JSON.stringify({ schema: 'coarse-grid/preset', version: 1, name: '', params });
  assert.throws(() => parsePreset(json), /Invalid name/);
  json = JSON.stringify({ schema: 'coarse-grid/preset', version: 1, name: 'a'.repeat(65), params });
  assert.throws(() => parsePreset(json), /Invalid name/);
});

test('parsePreset rejects malformed JSON', () => {
  assert.throws(() => parsePreset('not json'), /Invalid JSON/);
});

test('parsePreset rejects missing params', () => {
  const json = JSON.stringify({ schema: 'coarse-grid/preset', version: 1, name: 'Test' });
  assert.throws(() => parsePreset(json), /Missing params/);
});

test('parsePreset applies normalization on parse', () => {
  const params = Object.fromEntries(CONTROL_DEFINITIONS.map((d) => [d.key, d.defaultValue]));
  params.contrast = 999;
  params.posterization = -1;
  const json = JSON.stringify({ schema: 'coarse-grid/preset', version: 1, name: 'Test', params });
  const parsed = parsePreset(json);
  assert.equal(parsed.params.contrast, 100);
  assert.equal(parsed.params.posterization, 0);
});