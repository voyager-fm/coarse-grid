import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_FILTER_PARAMS,
  GpuFilterError,
  computeBlockSize,
  createRasterFilter,
  normalizeFilterParams,
} from '../src/index.ts';

test('core entry exposes the browser renderer and filter parameter contract', () => {
  assert.equal(createRasterFilter.name, 'createGpuFilter');
  assert.equal(GpuFilterError.name, 'GpuFilterError');
  assert.deepEqual(normalizeFilterParams(), DEFAULT_FILTER_PARAMS);
  assert.equal(computeBlockSize(100, 50, 5.6), 3);
});
