import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_FILTER_PARAMS,
  computeBlockSize,
  createRasterFilter,
  normalizeFilterParams,
} from '@voyager-labs/coarse-grid-core';

test('published package entry exposes the raster filter renderer contract', () => {
  assert.equal(typeof createRasterFilter, 'function');
  assert.equal(computeBlockSize(100, 50, DEFAULT_FILTER_PARAMS.blockPercent), 3);
  assert.equal(normalizeFilterParams({ ribPitch: 20 }).ribPitch, 20);
});
