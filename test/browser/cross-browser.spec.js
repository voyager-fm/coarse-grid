import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDirectionalProbeUpload, createMulticolorGradientUpload, decodePngBuffer } from './fixtures.js';

const RESULT_DIRECTORY = path.resolve('test-results');

async function exportPng(page) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Playwright did not provide a path for the PNG download.');
  return decodePngBuffer(await readFile(downloadPath));
}

function assertOpaque(image) {
  for (let offset = 3; offset < image.data.length; offset += 4) {
    expect(image.data[offset], `alpha at pixel ${offset / 4}`).toBe(255);
  }
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return image.data.subarray(offset, offset + 4);
}

// Filter groups live behind segmented tabs; only the active group's panel is
// visible, so real clicks on group-owned controls must activate their tab first.
async function activateFilterTab(page, name) {
  await page.getByRole('tab', { name }).click();
}

test('exports deterministic, opaque, correctly oriented GPU PNG results', async ({ page, baseURL }, testInfo) => {
  const localOrigin = new URL(baseURL).origin;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === localOrigin) await route.continue();
    else await route.abort();
  });

  await page.goto('/');
  await page.locator('#file-input').setInputFiles(createMulticolorGradientUpload());
  await expect(page.locator('#source-meta')).toContainText('multicolor-gradient.png');
  await expect(page.locator('#export-scale')).toHaveValue('100');
  await expect(page.locator('#export-btn')).toBeEnabled();
  await expect(page.locator('#status')).toHaveText('');

  // Neutralize filter effects so orientation assertions test the pipeline's
  // top-left-origin contract, not the interaction of default filter params.
  await page.locator('#control-posterization').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#control-contrast').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#control-bloom').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  // Booleans are un-checked with a real click (React 19 onChange does not fire on
  // the checked-setter + change pattern), only when the box is currently checked.
  if (await page.locator('#control-contrastEnabled').isChecked()) {
    await activateFilterTab(page, 'Block');
    await page.locator('#control-contrastEnabled').click();
  }
  if (await page.locator('#control-ribsEnabled').isChecked()) {
    await activateFilterTab(page, 'Ribs');
    await page.getByRole('tab', { name: 'Response' }).click();
    await page.locator('#control-ribsEnabled').click();
  }
  if (await page.locator('#control-rgbFringeEnabled').isChecked()) {
    await activateFilterTab(page, 'Fringe');
    await page.locator('#control-rgbFringeEnabled').click();
  }

  const first = await exportPng(page);
  const second = await exportPng(page);

  expect(second.width).toBe(first.width);
  expect(second.height).toBe(first.height);
  expect(Buffer.compare(second.data, first.data)).toBe(0);
  expect(first.width).toBe(8);
  expect(first.height).toBe(4);
  assertOpaque(first);

// Verify orientation: the top-left source pixel is black (0,0,0) and the
  // bottom-right source pixel is white (255,255,255). After pipeline processing
  // the top-left must be darker than the bottom-right, proving top-left origin.
  const topLeft = pixel(first, 0, 0);
  const bottomRight = pixel(first, 7, 3);
  const topLeftLuma = 0.2126 * topLeft[0] + 0.7152 * topLeft[1] + 0.0722 * topLeft[2];
  const bottomRightLuma = 0.2126 * bottomRight[0] + 0.7152 * bottomRight[1] + 0.0722 * bottomRight[2];
  expect(bottomRightLuma, 'bottom-right (white source) must be brighter than top-left (black source)').toBeGreaterThan(topLeftLuma);

  await mkdir(RESULT_DIRECTORY, { recursive: true });
  await writeFile(
    path.join(RESULT_DIRECTORY, `cross-browser-${testInfo.project.name}.json`),
    `${JSON.stringify({ width: first.width, height: first.height, rgbaBase64: first.data.toString('base64') })}\n`,
    'utf8',
  );
});

test('Chromium renders deterministic byte-identical output on repeated exports', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'determinism verified in Chromium only');

  await page.goto('/');
  await page.locator('#file-input').setInputFiles(createDirectionalProbeUpload());
  await expect(page.locator('#source-meta')).toContainText('directional-probe.png');

  // Neutralize filter effects so the determinism assertion tests the pipeline's
  // repeatability, not the stability of specific filter parameter interactions.
  await page.locator('#control-posterization').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#control-contrast').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#control-bloom').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  // Booleans are un-checked with a real click (React 19 onChange does not fire on
  // the checked-setter + change pattern), only when the box is currently checked.
  if (await page.locator('#control-contrastEnabled').isChecked()) {
    await activateFilterTab(page, 'Block');
    await page.locator('#control-contrastEnabled').click();
  }
  if (await page.locator('#control-ribsEnabled').isChecked()) {
    await activateFilterTab(page, 'Ribs');
    await page.getByRole('tab', { name: 'Response' }).click();
    await page.locator('#control-ribsEnabled').click();
  }
  if (await page.locator('#control-rgbFringeEnabled').isChecked()) {
    await activateFilterTab(page, 'Fringe');
    await page.locator('#control-rgbFringeEnabled').click();
  }

  const first = await exportPng(page);
  const second = await exportPng(page);

  expect(second.width).toBe(first.width);
  expect(second.height).toBe(first.height);
  expect(Buffer.compare(second.data, first.data)).toBe(0);
});
