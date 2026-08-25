import { expect, test } from '@playwright/test';
import {
  createAsymmetricOrientationUpload,
  createCorruptImageUpload,
  createDirectionalProbeUpload,
  createEightMegapixelCompressibleUpload,
  createHalfMegapixelCompressibleUpload,
  createHiddenRgbTransparentUpload,
  createMulticolorGradientUpload,
  createMultiFileUpload,
  createOverEightMegapixelCompressibleUpload,
  createSemiOpaqueTileSumUpload,
  createSmallValidUpload,
  createTransparencyCompositionUpload,
  decodePngBuffer,
} from './fixtures.js';

const LOCAL_URL = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/|blob:|data:|about:)/;

function control(page, key) {
  return page.locator(`#control-${key}`);
}

async function setRange(page, key, value) {
  await control(page, key).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function setColor(page, key, value) {
  await control(page, key).evaluate((input, next) => {
    input.value = next;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// Filter groups live behind segmented tabs; only the active group's panel is
// visible, so clicks and visibility assertions on group-owned elements must
// activate their tab first (evaluate dispatches and value/text assertions do not).
async function activateFilterTab(page, name) {
  await page.getByRole('tab', { name }).click();
}

function recordTiming(timings, key) {
  if (timings) timings[key] = Number(process.hrtime.bigint() - timings.startedAt) / 1_000_000;
}

async function upload(page, payload, dimensions, timings) {
  await page.locator('#file-input').setInputFiles(payload);
  await expect(page.locator('#source-meta')).toContainText(payload.name);
  const width = dimensions?.width ?? (payload.name === 'asymmetric-orientation.png' ? 4 : payload.name === 'transparent-composition.png' ? 4 : 2);
  await expect(page.locator('#preview-canvas')).toHaveJSProperty('width', width);
  await expect(page.locator('#empty-state')).toBeHidden();
  recordTiming(timings, 'uploadPreviewCompletedMs');
}

async function neutralizeEffects(page) {
  await setRange(page, 'posterization', 0);
  await setRange(page, 'contrast', 0);
  await activateFilterTab(page, 'Block');
  await control(page, 'contrastEnabled').uncheck();
  await activateFilterTab(page, 'Bloom');
  await setRange(page, 'bloom', 0);
  await activateFilterTab(page, 'Ribs');
  await page.getByRole('tab', { name: 'Response' }).click();
  await control(page, 'ribsEnabled').uncheck();
  await activateFilterTab(page, 'Fringe');
  await control(page, 'rgbFringeEnabled').uncheck();
  await expect(control(page, 'posterization')).toHaveValue('0');
}

async function decodeDownload(download, timings) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  recordTiming(timings, 'downloadCompletedMs');
  const decoded = decodePngBuffer(Buffer.concat(chunks));
  recordTiming(timings, 'pngDecodedMs');
  return decoded;
}

async function exportDecodedPng(page, scale = 100, timeout, timings) {
  await page.locator('#export-scale').selectOption(String(scale));
  const download = page.waitForEvent('download', timeout ? { timeout } : undefined);
  await page.locator('#export-btn').click();
  recordTiming(timings, 'exportClickedMs');
  return decodeDownload(await download, timings);
}

async function createFileDataTransfer(page, payloads) {
  const files = payloads.map(({ buffer, name, mimeType }) => ({ bytes: Array.from(buffer), name, mimeType }));
  return page.evaluateHandle((items) => {
    const transfer = new DataTransfer();
    for (const { bytes, name, mimeType } of items) transfer.items.add(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
    return transfer;
  }, files);
}

async function nextAnimationFrames(page, count = 2) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) await new Promise(requestAnimationFrame);
  }, count);
}

async function captureNextDefaultFramebufferPreview(page) {
  await page.locator('#preview-canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2');
    const original = gl.drawArrays;
    gl.drawArrays = function (...args) {
      const result = original.apply(this, args);
      if (this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        this.readPixels(0, 0, canvas.width, canvas.height, this.RGBA, this.UNSIGNED_BYTE, pixels);
        window.__defaultFramebufferPreview = { width: canvas.width, height: canvas.height, pixels: Array.from(pixels) };
        this.drawArrays = original;
      }
      return result;
    };
  });
}

async function readPreviewRgba(page) {
  return page.evaluate(() => {
    const preview = window.__defaultFramebufferPreview;
    if (!preview) throw new Error('The default framebuffer preview was not captured during its blit.');
    const pixels = Uint8Array.from(preview.pixels);
    // readPixels is bottom-left-origin; flip exactly once for top-left PNG parity.
    const rowLength = preview.width * 4;
    const scratch = new Uint8Array(rowLength);
    for (let y = 0; y < Math.floor(preview.height / 2); y += 1) {
      const top = y * rowLength;
      const bottom = (preview.height - 1 - y) * rowLength;
      scratch.set(pixels.subarray(top, top + rowLength));
      pixels.copyWithin(top, bottom, bottom + rowLength);
      pixels.set(scratch, bottom);
    }
    return { width: preview.width, height: preview.height, pixels: Array.from(pixels) };
  });
}

async function expectPreviewToMatchHundredPercentExport(page) {
  await nextAnimationFrames(page);
  const preview = await readPreviewRgba(page);
  const exported = await exportDecodedPng(page, 100);
  expect(exported).toMatchObject({ width: preview.width, height: preview.height });
  let maxRgbDelta = 0;
  for (let offset = 0; offset < exported.data.length; offset += 4) {
    expect(exported.data[offset + 3], `opaque alpha at pixel ${offset / 4}`).toBe(preview.pixels[offset + 3]);
    for (let channel = 0; channel < 3; channel += 1) maxRgbDelta = Math.max(maxRgbDelta, Math.abs(exported.data[offset + channel] - preview.pixels[offset + channel]));
  }
  // The preview blit uses mediump precision while the export reads its RGBA8 FBO directly.
  expect(maxRgbDelta, 'preview and 100% export parity must be within one RGBA8 code value').toBeLessThanOrEqual(1);
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return image.data.subarray(offset, offset + 4);
}

test.describe.serial('GPU raster filter acceptance', () => {
  let failures;

  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    failures = [];
    page.on('pageerror', (error) => failures.push(`pageerror: ${error.stack || error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console: ${message.text()}`);
    });
    page.on('request', (request) => {
      if (!LOCAL_URL.test(request.url())) failures.push(`network: ${request.url()}`);
    });
    await page.goto('/');
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (failures.length) await testInfo.attach('browser-failures.txt', { body: failures.join('\n'), contentType: 'text/plain' });
    expect(failures, 'normal product flow must not emit page, console, or non-local network errors').toEqual([]);
    await expect(page.locator('#status')).not.toContainText('A GPU processing error occurred');
  });

  test('starts disabled, exposes only filter controls, and preserves the desktop layout', async ({ page }) => {
    await expect(control(page, 'blockPercent')).toBeDisabled();
    for (const [key, label, defaultColor] of [['negativeFringeTint', 'Negative fringe tint', '#00c7ff'], ['positiveFringeTint', 'Positive fringe tint', '#ff1475']]) {
      await expect(page.locator(`label[for="control-${key}"]`)).toHaveText(label);
      await expect(control(page, key)).toHaveValue(defaultColor);
      await expect(control(page, key)).toBeDisabled();
    }
    await expect(page.locator('#export-scale')).toBeDisabled();
    await expect(page.locator('#reset-btn')).toBeDisabled();
    await expect(page.locator('#export-btn')).toBeDisabled();

    // Segmented tabs: exactly four tabs, Block selected by default, and an
    // inactive panel stays mounted but hidden until its tab activates it.
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.getByRole('tab', { name: 'Block' })).toHaveAttribute('aria-selected', 'true');
    const bloomPanel = page.locator('#filter-panel-bloom');
    await expect(bloomPanel).toHaveCount(1);
    await expect(bloomPanel).toBeHidden();
    await activateFilterTab(page, 'Bloom');
    await expect(bloomPanel).toBeVisible();

    await activateFilterTab(page, 'Ribs');
    await expect(page.getByRole('tab', { name: 'Geometry' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#filter-panel-ribs-geometry')).toBeVisible();
    await expect(page.locator('#filter-panel-ribs-response')).toBeHidden();
    await page.getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#filter-panel-ribs-response')).toBeVisible();

    await activateFilterTab(page, 'Fringe');
    const help = page.getByRole('button', { name: 'Negative fringe tint help' });
    await expect(help).toBeEnabled();
    await help.click();
    await expect(page.locator(`#${await help.getAttribute('aria-controls')}`)).toBeVisible();
    await expect(page.locator('#workspace')).toContainText('Output preview');
    await expect(page.locator('#preview-canvas')).toHaveAttribute('aria-label', 'GPU-filtered image preview composited over an opaque background');
    await expect(page.locator('#controls')).toContainText('RGB fringe');
    await expect(page.locator('body')).not.toContainText(/scanline|dither|duotone|palette|grain|glow|rgb shift/i);

    const desktop = await page.evaluate(() => {
      const controls = document.querySelector('#controls').getBoundingClientRect();
      const workspace = document.querySelector('#workspace').getBoundingClientRect();
      const exportPanel = document.querySelector('.export-panel').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, controls, workspace, exportPanel };
    });
    expect(desktop.overflow).toBe(false);
    expect(desktop.controls.x).toBeLessThan(desktop.workspace.x);
    // The Output panel lives in the main column, below the preview workspace.
    expect(desktop.exportPanel.x).toBeGreaterThanOrEqual(desktop.workspace.x);
    expect(desktop.exportPanel.top).toBeGreaterThanOrEqual(desktop.workspace.top);
  });

  test('uploads through picker and drop, renders top-left orientation, and clamps edits', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    await expect(control(page, 'blockPercent')).toBeEnabled();
    await expect(page.locator('#export-btn')).toBeEnabled();
    await expect(page.locator('#status')).toHaveText('');

    const dataTransfer = await createFileDataTransfer(page, [createAsymmetricOrientationUpload()]);
    await page.locator('#drop-target').dispatchEvent('drop', { dataTransfer });
    await dataTransfer.dispose();
    await expect(page.locator('#source-meta')).toContainText('asymmetric-orientation.png');
    await neutralizeEffects(page);
    const decoded = await exportDecodedPng(page);
    expect(decoded).toMatchObject({ width: 4, height: 3 });

    await setRange(page, 'posterization', 99);
    await expect(control(page, 'posterization')).toHaveValue('1');
    await setRange(page, 'contrast', -999);
    await expect(control(page, 'contrast')).toHaveValue('-100');
    await setRange(page, 'bloomHighlightLow', 1);
    await expect(control(page, 'bloomHighlightLow')).toHaveValue('0.819');

    // Posterization lives in the Block panel; neutralizeEffects left Fringe active.
    await activateFilterTab(page, 'Block');
    const posterizationNumber = page.locator('#control-posterization-number');
    await expect(posterizationNumber).toHaveValue('1');
    await posterizationNumber.fill('0.5');
    await posterizationNumber.press('Enter');
    await expect(control(page, 'posterization')).toHaveValue('0.5');
    await expect(posterizationNumber).toHaveValue('0.5');
    await page.locator('#control-posterization-increment').click();
    await expect(control(page, 'posterization')).toHaveValue('0.51');
    await expect(posterizationNumber).toHaveValue('0.51');

    await posterizationNumber.fill('invalid');
    await posterizationNumber.evaluate((input) => input.blur());
    await expect(posterizationNumber).toHaveValue('0.51');
  });

  test('keeps default-framebuffer preview byte-identical to a 100% FBO export after block geometry changes', async ({ page }) => {
    await upload(page, createAsymmetricOrientationUpload());
    await captureNextDefaultFramebufferPreview(page);
    await setRange(page, 'blockPercent', 25);
    await expect(control(page, 'blockPercent')).toHaveValue('25');
    await expectPreviewToMatchHundredPercentExport(page);
  });

  test('rebuilds block geometry consistently for reset and source replacement', async ({ page }) => {
    await upload(page, createAsymmetricOrientationUpload());
    await setRange(page, 'blockPercent', 25);
    await captureNextDefaultFramebufferPreview(page);
    await page.locator('#reset-btn').click();
    await expect(control(page, 'blockPercent')).toHaveValue('5.6');
    await expectPreviewToMatchHundredPercentExport(page);

    await captureNextDefaultFramebufferPreview(page);
    await upload(page, createSmallValidUpload());
    await expectPreviewToMatchHundredPercentExport(page);
  });

  test('renders distinct 45° and 135° rib/fringe directions at stable asymmetric probes', async ({ page }) => {
    await upload(page, createDirectionalProbeUpload(), { width: 64, height: 64 });
    await setRange(page, 'posterization', 0);
    await setRange(page, 'blockPercent', 1);
    await setRange(page, 'bloom', 0);
    // Params are in logical units (lu). At 64×64 target, scale = 0.064.
    // Use max values to ensure visible effects: ribPitch 64lu → 4.1px, widths 16lu → 1px.
    await setRange(page, 'ribPitch', 64);
    await setRange(page, 'ribLowLuminanceWidth', 16);
    await setRange(page, 'ribHighLuminanceWidth', 16);
    await setRange(page, 'ribLowLuminanceDarkness', 1);
    await setRange(page, 'ribHighLuminanceDarkness', 1);
    await setRange(page, 'ribEdgeSoftness', 0);
    await setRange(page, 'fringeDistance', 8);
    await setRange(page, 'fringeProbeDistance', 32);
    await setRange(page, 'fringeIntensity', 2);
    await setRange(page, 'fringeTintMix', 0);

    await setRange(page, 'ribAngle', 45);
    const diagonal45 = await exportDecodedPng(page);
    await setRange(page, 'ribAngle', 135);
    const diagonal135 = await exportDecodedPng(page);

    expect(Buffer.compare(diagonal45.data, diagonal135.data), '45° and 135° must not collapse to the same directional output').not.toBe(0);
    // At top-left source probes (8,8) and (9,8), 45° advances along (+x,+y) while
    // 135° advances along (-x,+y). The enabled fringe uses the same normal, so both
    // probes must distinguish the two diagonal directions without inspecting shader text.
    expect(pixel(diagonal45, 8, 8)).not.toEqual(pixel(diagonal135, 8, 8));
    expect(pixel(diagonal45, 9, 8)).not.toEqual(pixel(diagonal135, 9, 8));
  });

  test('applies independent low/high rib darkness across luminance probes while preserving preview/export and reset parity', async ({ page }) => {
    await upload(page, createDirectionalProbeUpload(), { width: 64, height: 64 });
    const defaultExport = await exportDecodedPng(page);

    await setRange(page, 'posterization', 0);
    await setRange(page, 'blockPercent', 1);
    await setRange(page, 'contrast', 0);
    await setRange(page, 'bloom', 0);
    await activateFilterTab(page, 'Fringe');
    await control(page, 'rgbFringeEnabled').uncheck();
    await setRange(page, 'ribAngle', 0);
    await setRange(page, 'ribPitch', 4);
    await setRange(page, 'ribLowLuminanceWidth', 2);
    await setRange(page, 'ribHighLuminanceWidth', 2);
    await setRange(page, 'ribEdgeSoftness', 0);
    await setRange(page, 'luminanceLow', 0.2);
    await setRange(page, 'luminanceHigh', 0.6);
    await setRange(page, 'luminanceGamma', 1);
    const calibrated = await exportDecodedPng(page);

    await setRange(page, 'ribLowLuminanceDarkness', 0.5);
    const lowDark = await exportDecodedPng(page);
    expect(Buffer.compare(lowDark.data, calibrated.data), 'the low-luminance darkness must alter GPU output independently').not.toBe(0);

    await captureNextDefaultFramebufferPreview(page);
    await setRange(page, 'ribHighLuminanceDarkness', 0.5);
    const bothDark = await exportDecodedPng(page);
    expect(Buffer.compare(bothDark.data, lowDark.data), 'the high-luminance darkness must alter GPU output independently').not.toBe(0);
    await expectPreviewToMatchHundredPercentExport(page);

    await page.locator('#reset-btn').click();
    await expect(control(page, 'ribLowLuminanceDarkness')).toHaveValue('0.45');
    await expect(control(page, 'ribHighLuminanceDarkness')).toHaveValue('0.65');
    const resetExport = await exportDecodedPng(page);
    expect(Buffer.compare(resetExport.data, defaultExport.data), 'defaults after reset must match the current default export baseline').toBe(0);
  });

  test('snapshots rib darkness before yielding an export animation frame', async ({ page }) => {
    await upload(page, createDirectionalProbeUpload(), { width: 64, height: 64 });
    await setRange(page, 'posterization', 0);
    await setRange(page, 'blockPercent', 1);
    await setRange(page, 'contrast', 0);
    await setRange(page, 'bloom', 0);
    await activateFilterTab(page, 'Fringe');
    await control(page, 'rgbFringeEnabled').uncheck();
    await setRange(page, 'ribAngle', 0);
    await setRange(page, 'ribPitch', 4);
    await setRange(page, 'ribLowLuminanceWidth', 2);
    await setRange(page, 'ribHighLuminanceWidth', 2);
    await setRange(page, 'ribEdgeSoftness', 0);
    await setRange(page, 'luminanceLow', 0.2);
    await setRange(page, 'luminanceHigh', 0.6);
    await setRange(page, 'luminanceGamma', 1);
    await setRange(page, 'ribLowLuminanceDarkness', 0.8);
    await setRange(page, 'ribHighLuminanceDarkness', 0.1);
    const originalDarkness = await exportDecodedPng(page);

    await page.evaluate(() => {
      window.__originalRequestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = (callback) => {
        window.__heldExportAnimationFrame = callback;
        return 1;
      };
    });
    const heldDownload = page.waitForEvent('download');
    await page.locator('#export-btn').click();
    await expect(page.locator('#status')).toHaveText('Creating PNG on the GPU…');
    await expect(page.locator('#export-btn')).toBeDisabled();
    await expect(page.locator('#export-scale')).toBeDisabled();
    await expect(control(page, 'ribLowLuminanceDarkness')).toBeDisabled();
    await expect(control(page, 'ribHighLuminanceDarkness')).toBeDisabled();

    await setRange(page, 'ribLowLuminanceDarkness', 0.1);
    await setRange(page, 'ribHighLuminanceDarkness', 0.8);
    await expect(control(page, 'ribLowLuminanceDarkness')).toHaveValue('0.1');
    await expect(control(page, 'ribHighLuminanceDarkness')).toHaveValue('0.8');
    await page.evaluate(() => {
      const callback = window.__heldExportAnimationFrame;
      window.requestAnimationFrame = window.__originalRequestAnimationFrame;
      callback(performance.now());
    });
    const snapshotExport = await decodeDownload(await heldDownload);
    expect(Buffer.compare(snapshotExport.data, originalDarkness.data), 'the held export must retain darkness from its initial snapshot').toBe(0);
    await expect(page.locator('#status')).toContainText('exported.');
    await expect(page.locator('#export-btn')).toBeEnabled();
    await expect(page.locator('#export-scale')).toBeEnabled();
    await expect(control(page, 'ribLowLuminanceDarkness')).toBeEnabled();
    await expect(control(page, 'ribHighLuminanceDarkness')).toBeEnabled();

    const editedDarkness = await exportDecodedPng(page);
    expect(Buffer.compare(editedDarkness.data, originalDarkness.data), 'a later export must reflect the edited darkness').not.toBe(0);
    await page.evaluate(() => { delete window.__heldExportAnimationFrame; delete window.__originalRequestAnimationFrame; });
  });

  test('resets on demand and after a replacement upload while invalid uploads preserve the prior source', async ({ page }) => {
    await upload(page, createAsymmetricOrientationUpload());
    await setRange(page, 'posterization', 0.5);
    await activateFilterTab(page, 'Ribs');
    await page.getByRole('tab', { name: 'Response' }).click();
    await control(page, 'ribsEnabled').uncheck();
    await setColor(page, 'negativeFringeTint', '#112233');
    await setColor(page, 'positiveFringeTint', '#445566');
    await page.locator('#reset-btn').click();
    await expect(control(page, 'posterization')).toHaveValue('0.83');
    await expect(control(page, 'ribsEnabled')).toBeChecked();
    await expect(control(page, 'negativeFringeTint')).toHaveValue('#00c7ff');
    await expect(control(page, 'positiveFringeTint')).toHaveValue('#ff1475');

    await upload(page, createMulticolorGradientUpload(), { width: 8, height: 4 });
    await expect(page.locator('#source-meta')).toContainText('multicolor-gradient.png');
    await expect(control(page, 'posterization')).toHaveValue('0.83');
    await expect(control(page, 'ribsEnabled')).toBeChecked();
    await expect(control(page, 'negativeFringeTint')).toHaveValue('#00c7ff');
    await expect(control(page, 'positiveFringeTint')).toHaveValue('#ff1475');

    await setColor(page, 'negativeFringeTint', '#112233');
    await setColor(page, 'positiveFringeTint', '#445566');
    await nextAnimationFrames(page);

    await page.locator('#file-input').setInputFiles(createCorruptImageUpload());
    await expect(page.locator('#status')).toContainText('Could not read the image');
    await expect(page.locator('#source-meta')).toContainText('multicolor-gradient.png');
    await expect(control(page, 'posterization')).toBeEnabled();
    await expect(control(page, 'negativeFringeTint')).toHaveValue('#112233');
    await expect(control(page, 'positiveFringeTint')).toHaveValue('#445566');
    const dataTransfer = await createFileDataTransfer(page, createMultiFileUpload());
    await page.locator('#drop-target').dispatchEvent('drop', { dataTransfer });
    await dataTransfer.dispose();
    await expect(page.locator('#status')).toContainText('Only one image can be selected at a time.');
    await expect(page.locator('#source-meta')).toContainText('multicolor-gradient.png');
    await expect(control(page, 'negativeFringeTint')).toHaveValue('#112233');
    await expect(control(page, 'positiveFringeTint')).toHaveValue('#445566');
  });

  test('preserves straight alpha in export and composites only in display', async ({ page }) => {
    await upload(page, createTransparencyCompositionUpload());
    await neutralizeEffects(page);
    const output = await exportDecodedPng(page);
    expect(output).toMatchObject({ width: 4, height: 2 });

    // Pixel layout of the transparency composition fixture (4x2):
    // Row 0: [0,255,255,0]  [255,0,0,128]  [0,255,0,128]  [0,0,255,128]
    // Row 1: [255,255,255,0] [255,255,0,64] [0,0,0,255]    [255,255,255,255]

    // Fully transparent source pixels (alpha=0) must have alpha 0 in the export.
    // Pixels at (0,0) and (0,1) have alpha=0 in the source.
    for (const [x, y] of [[0, 0], [0, 1]]) {
      const offset = (y * output.width + x) * 4;
      expect(output.data[offset + 3], `alpha at (${x},${y})`).toBe(0);
    }

    // The export is not fully opaque — some pixels are transparent.
    // This proves the pipeline preserves straight alpha rather than always compositing.
    const transparentCount = [...output.data].filter((_v, i) => i % 4 === 3 && output.data[i] === 0).length;
    expect(transparentCount).toBeGreaterThan(0);

    // Fully transparent pixels must have RGB (0,0,0) — hidden RGB is not preserved.
    // Pixel at (0,0) has source [0,255,255,0] — after processing, RGB should be (0,0,0).
    const transparentOffset = (0 * output.width + 0) * 4;
    expect(output.data[transparentOffset], 'R at (0,0)').toBe(0);
    expect(output.data[transparentOffset + 1], 'G at (0,0)').toBe(0);
    expect(output.data[transparentOffset + 2], 'B at (0,0)').toBe(0);
  });

  test('does not create alpha halo from hidden RGB under transparent pixels', async ({ page }) => {
    await upload(page, createHiddenRgbTransparentUpload(), { width: 4, height: 2 });
    await neutralizeEffects(page);
    const output = await exportDecodedPng(page);
    expect(output).toMatchObject({ width: 4, height: 2 });

    // All pixels in the hidden-RGB fixture have alpha=0 with bright RGB values.
    // Verify that alpha is 0 for every pixel — no hidden RGB bleeds into alpha.
    for (let offset = 3; offset < output.data.length; offset += 4) {
      expect(output.data[offset], `alpha at pixel ${offset / 4}`).toBe(0);
    }

    // Verify no NaN-like values in the decoded PNG data.
    for (let offset = 0; offset < output.data.length; offset += 1) {
      const value = output.data[offset];
      expect(Number.isNaN(value)).toBe(false);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });

  test('keeps export single-flight and recovers from PNG encoding failure', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    await page.evaluate(() => {
      window.__originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); };
    });
    await page.locator('#export-btn').click();
    await expect(page.locator('#status')).toContainText('Could not create the PNG');
    await expect(page.locator('#export-btn')).toBeEnabled();
    await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = window.__originalToBlob; });

    const downloads = [];
    page.on('download', (download) => downloads.push(download));
    await page.locator('#export-btn').click({ clickCount: 2 });
    await expect.poll(() => downloads.length).toBe(1);
    await expect(page.locator('#export-btn')).toBeEnabled();
  });

  test('reports webgl2-unavailable when getContext returns null for webgl2', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const testFailures = [];
    page.on('pageerror', (error) => testFailures.push(error.message));
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === 'webgl2') return null;
        return original.call(this, type, attrs);
      };
    });
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('WebGL2 is unavailable');
    await expect(page.locator('#source-meta')).toHaveText('');
    await expect(page.locator('#export-btn')).toBeDisabled();
    expect(testFailures).toEqual([]);
    await context.close();
  });

  test('reports float-color-buffer-unavailable when EXT_color_buffer_float is missing', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const testFailures = [];
    page.on('pageerror', (error) => testFailures.push(error.message));
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name) {
        if (name === 'EXT_color_buffer_float') return null;
        return original.call(this, name);
      };
    });
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('EXT_color_buffer_float');
    await expect(page.locator('#source-meta')).toHaveText('');
    await expect(page.locator('#export-btn')).toBeDisabled();
    expect(testFailures).toEqual([]);
    await context.close();
  });

  test('reports float-framebuffer-incomplete when the RGBA32F probe fails', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const testFailures = [];
    page.on('pageerror', (error) => testFailures.push(error.message));
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name) {
        if (name === 'EXT_color_buffer_float') return {}; // mock object, real GL extension not enabled
        return original.call(this, name);
      };
    });
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('floating-point framebuffer');
    await expect(page.locator('#source-meta')).toHaveText('');
    await expect(page.locator('#export-btn')).toBeDisabled();
    expect(testFailures).toEqual([]);
    await context.close();
  });

  test('reports GPU size restrictions when WebGL capabilities are safely constrained', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const testFailures = [];
    page.on('pageerror', (error) => testFailures.push(error.message));
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === this.MAX_TEXTURE_SIZE || parameter === this.MAX_RENDERBUFFER_SIZE) return 1;
        if (parameter === this.MAX_VIEWPORT_DIMS) return new Int32Array([1, 1]);
        return original.call(this, parameter);
      };
    });
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(createSmallValidUpload());
    await expect(page.locator('#status')).toContainText("exceeds this browser's GPU rendering limits");
    await expect(page.locator('#source-meta')).toHaveText('');
    expect(testFailures).toEqual([]);
    await context.close();
  });

  test('rejects constrained replacement without changing the retained source metadata or export', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === this.MAX_TEXTURE_SIZE || parameter === this.MAX_RENDERBUFFER_SIZE) return 3;
        if (parameter === this.MAX_VIEWPORT_DIMS) return new Int32Array([3, 3]);
        return original.call(this, parameter);
      };
    });
    await page.goto('/');
    await upload(page, createSmallValidUpload());
    const before = await exportDecodedPng(page);
    await page.locator('#file-input').setInputFiles(createAsymmetricOrientationUpload());
    await expect(page.locator('#status')).toContainText("exceeds this browser's GPU rendering limits");
    await expect(page.locator('#source-meta')).toContainText('small-valid.png');
    const after = await exportDecodedPng(page);
    expect(Buffer.compare(after.data, before.data)).toBe(0);
    await context.close();
  });

  test('handles WebGL context loss and restoration when the extension is available', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    const supported = await page.locator('#preview-canvas').evaluate((canvas) => Boolean(canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')));
    test.skip(!supported, 'WEBGL_lose_context is unavailable in this browser project.');
    const before = await exportDecodedPng(page);
    await page.locator('#preview-canvas').evaluate((canvas) => {
      window.__webglLoseContext = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
      window.__webglLoseContext.loseContext();
    });
    await expect(page.locator('#status')).toContainText('GPU context was lost');
    await expect(control(page, 'blockPercent')).toBeDisabled();
    await page.evaluate(() => window.__webglLoseContext.restoreContext());
    await expect(control(page, 'blockPercent')).toBeEnabled();
    await expect(page.locator('#status')).not.toContainText('GPU context was lost');
    await expect(page.locator('#source-meta')).toContainText('small-valid.png');
    const after = await exportDecodedPng(page);
    expect(Buffer.compare(after.data, before.data), 'context restoration must reproduce the retained source byte-for-byte').toBe(0);
    await page.evaluate(() => { delete window.__webglLoseContext; });
  });

  test('cancels an active export on context loss and successfully exports after restoration', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    const supported = await page.locator('#preview-canvas').evaluate((canvas) => Boolean(canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')));
    test.skip(!supported, 'WEBGL_lose_context is unavailable in this browser project.');
    await page.evaluate(() => {
      window.__originalRequestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 1;
    });
    await page.locator('#export-btn').click();
    await expect(page.locator('#export-btn')).toBeDisabled();
    await page.locator('#preview-canvas').evaluate((canvas) => {
      const extension = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
      extension.loseContext();
      window.__webglLoseContext = extension;
    });
    await expect(page.locator('#status')).toContainText('GPU context was lost');
    await page.evaluate(() => {
      window.requestAnimationFrame = window.__originalRequestAnimationFrame;
      window.__webglLoseContext.restoreContext();
    });
    await expect(page.locator('#export-btn')).toBeEnabled();
    const recovered = await exportDecodedPng(page);
    expect(recovered).toMatchObject({ width: 2, height: 2 });
    await page.evaluate(() => { delete window.__webglLoseContext; delete window.__originalRequestAnimationFrame; });
  });

  test('exports the real 8MP boundary without persisting a binary fixture', async ({ page }) => {
    test.setTimeout(90_000);
    const timings = { startedAt: process.hrtime.bigint() };
    const payload = createEightMegapixelCompressibleUpload();
    recordTiming(timings, 'fixtureCreatedMs');
    await upload(page, payload, { width: 2828, height: 2828 }, timings);
    const output = await exportDecodedPng(page, 100, 60_000, timings);
    console.log('8MP export timings', JSON.stringify({ fixtureCreatedMs: timings.fixtureCreatedMs, uploadPreviewCompletedMs: timings.uploadPreviewCompletedMs, exportClickedMs: timings.exportClickedMs, downloadCompletedMs: timings.downloadCompletedMs, pngDecodedMs: timings.pngDecodedMs }));
    expect(output).toMatchObject({ width: 2828, height: 2828 });
    const transparentAlpha = output.data.find((value, offset) => offset % 4 === 3 && value !== 255);
    expect(transparentAlpha).toBeUndefined();
  });

  test('tile-sum reduction preserves correct RGB and alpha for blockSize > 16', async ({ page }) => {
  test.setTimeout(90_000);
  // The half-megapixel fixture is 1000×500 uniform (48,96,144,255).
  // At blockPercent=12.8%, bs = round(500 * 12.8 / 100) = 64, which is a
  // multiple of 16. Every tile in a 64×64 block is fully contained, so the
  // tile-sum path processes 100% of the pixels. The broken implementation
  // clamps tile sums to 1.0, making every block pure white (255,255,255).
  const payload = createHalfMegapixelCompressibleUpload();
  await upload(page, payload, { width: 1000, height: 500 });
  await setRange(page, 'blockPercent', 12.8);
  await neutralizeEffects(page);
  const output = await exportDecodedPng(page, 100, 60_000);

  expect(output).toMatchObject({ width: 1000, height: 500 });

  // All pixels must be opaque — the tile-sum path must not corrupt alpha.
  const transparentAlpha = output.data.find((value, offset) => offset % 4 === 3 && value !== 255);
  expect(transparentAlpha, 'all pixels must be opaque in the tile-sum export').toBeUndefined();

  // The first pixel must not be white (255,255,255,255) — the broken
  // implementation clamps tile sums to 1.0, making every block pure white.
  const firstPixel = [output.data[0], output.data[1], output.data[2], output.data[3]];
  expect(firstPixel, 'tile-sum reduction must not produce white blocks').not.toEqual([255, 255, 255, 255]);

  // The first pixel should be approximately the source color (48,96,144,255)
  // within the 8-bit pipeline's precision.
  expect(output.data[0]).toBeGreaterThanOrEqual(30);
  expect(output.data[0]).toBeLessThanOrEqual(65);
  expect(output.data[1]).toBeGreaterThanOrEqual(80);
  expect(output.data[1]).toBeLessThanOrEqual(115);
  expect(output.data[2]).toBeGreaterThanOrEqual(130);
  expect(output.data[2]).toBeLessThanOrEqual(160);
  expect(output.data[3]).toBe(255);
});

  test('tile-sum path preserves partial alpha with fully-contained tiles', async ({ page }) => {
    test.setTimeout(60_000);
    // 64×64 semi-opaque fixture: uniform RGB (128,128,128), alpha=128.
    // At blockPercent=50%, bs = round(64 * 50 / 100) = 32 (> 16, multiple of 16).
    // All 4 tiles in each 32×32 block are fully contained; the tile-sum path
    // processes 100% of the pixels.
    const payload = createSemiOpaqueTileSumUpload();
    await upload(page, payload, { width: 64, height: 64 });
    await setRange(page, 'blockPercent', 50);
    await neutralizeEffects(page);
    const output = await exportDecodedPng(page, 100, 60_000);

    expect(output).toMatchObject({ width: 64, height: 64 });

    // The block reduction computes sumRgb = sum(linear * alpha), sumAlpha = sum(alpha).
    // For uniform RGB (128) and uniform alpha (128): avgRgb ≈ linear, avgAlpha = 0.5.
    // The post shader outputs the block-average alpha from the blocks texture (128/255 ≈ 0.502 for uniform alpha).
    // The output alpha should be ~128, not 0 or 255.
    const firstPixel = [output.data[0], output.data[1], output.data[2], output.data[3]];
    // RGB must match the source (128,128,128) within 8-bit pipeline precision.
    expect(firstPixel[0]).toBeGreaterThanOrEqual(120);
    expect(firstPixel[0]).toBeLessThanOrEqual(136);
    expect(firstPixel[1]).toBeGreaterThanOrEqual(120);
    expect(firstPixel[1]).toBeLessThanOrEqual(136);
    expect(firstPixel[2]).toBeGreaterThanOrEqual(120);
    expect(firstPixel[2]).toBeLessThanOrEqual(136);
    // Alpha must be semi-transparent (not 0, not 255).
    expect(firstPixel[3]).toBeGreaterThanOrEqual(100);
    expect(firstPixel[3]).toBeLessThanOrEqual(156);
    // Verify at least 10% of pixels have non-255 alpha (proves partial alpha preserved).
    const semiTransparentCount = [...output.data].filter((_v, i) => i % 4 === 3 && output.data[i] < 255).length;
    expect(semiTransparentCount).toBeGreaterThan(output.width * output.height * 0.1);
  });

  test('tile-sum path preserves partial alpha with boundary tiles', async ({ page }) => {
    test.setTimeout(60_000);
    // Same 64×64 semi-opaque fixture. At blockPercent=30%,
    // bs = round(64 * 30 / 100) = 19 (> 16, NOT a multiple of 16).
    // Each 19×19 block has 4 tiles: (0,0) fully contained → tile sum,
    // (1,0), (0,1), (1,1) are boundary tiles → direct sampling.
    // The two paths must produce the same result for a uniform input.
    const payload = createSemiOpaqueTileSumUpload();
    await upload(page, payload, { width: 64, height: 64 });
    await setRange(page, 'blockPercent', 30);
    await neutralizeEffects(page);
    const output = await exportDecodedPng(page, 100, 60_000);

    expect(output).toMatchObject({ width: 64, height: 64 });

    // Same expected values as the fully-contained tile test.
    const firstPixel = [output.data[0], output.data[1], output.data[2], output.data[3]];
    expect(firstPixel[0]).toBeGreaterThanOrEqual(120);
    expect(firstPixel[0]).toBeLessThanOrEqual(136);
    expect(firstPixel[1]).toBeGreaterThanOrEqual(120);
    expect(firstPixel[1]).toBeLessThanOrEqual(136);
    expect(firstPixel[2]).toBeGreaterThanOrEqual(120);
    expect(firstPixel[2]).toBeLessThanOrEqual(136);
    expect(firstPixel[3]).toBeGreaterThanOrEqual(100);
    expect(firstPixel[3]).toBeLessThanOrEqual(156);

    // Verify partial alpha is preserved (not all opaque).
    const semiTransparentCount = [...output.data].filter((_v, i) => i % 4 === 3 && output.data[i] < 255).length;
    expect(semiTransparentCount).toBeGreaterThan(output.width * output.height * 0.1);
  });

test('rejects export scales that exceed the 8MP product limit', async ({ page }) => {
    test.setTimeout(90_000);
    const payload = createOverEightMegapixelCompressibleUpload();
    await upload(page, payload, { width: 2829, height: 2828 });
    // The 100% scale option should be disabled (8,003,240 pixels > 8MP product limit).
    await expect(page.locator('#export-scale option[value="100"]')).toBeDisabled();
    // At least one lower scale should still be enabled (e.g., 25%).
    await expect(page.locator('#export-scale option[value="25"]')).not.toBeDisabled();
    // The export button should be enabled since a valid fallback scale is selected.
    await expect(page.locator('#export-btn')).toBeEnabled();
  });

  test('toggles undo/redo button states and responds to keyboard shortcuts', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    await expect(page.locator('#undo-btn')).toBeDisabled();
    await expect(page.locator('#redo-btn')).toBeDisabled();

    // Make a slider edit that commits to history (input + change events).
    await control(page, 'posterization').evaluate((input) => {
      input.value = '0.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#undo-btn')).toBeEnabled();
    await expect(page.locator('#redo-btn')).toBeDisabled();

    // Undo via keyboard shortcut (Ctrl+Z / Cmd+Z).
    await page.keyboard.press('Control+z');
    await expect(page.locator('#undo-btn')).toBeDisabled();
    await expect(page.locator('#redo-btn')).toBeEnabled();
    await expect(control(page, 'posterization')).toHaveValue('0.83');

    // Redo via keyboard shortcut (Ctrl+Shift+Z / Cmd+Shift+Z).
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('#undo-btn')).toBeEnabled();
    await expect(page.locator('#redo-btn')).toBeDisabled();
    await expect(control(page, 'posterization')).toHaveValue('0.5');

    // Redo via button click.
    await page.locator('#undo-btn').click();
    await expect(page.locator('#undo-btn')).toBeDisabled();
    await expect(page.locator('#redo-btn')).toBeEnabled();
    await page.locator('#redo-btn').click();
    await expect(page.locator('#undo-btn')).toBeEnabled();
    await expect(page.locator('#redo-btn')).toBeDisabled();
  });

  test('resets each filter group independently and commits to history', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    // Change a block-group control (posterization) and a bloom-group control (bloom).
    await control(page, 'posterization').evaluate((input) => {
      input.value = '0.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await control(page, 'bloom').evaluate((input) => {
      input.value = '0.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(control(page, 'posterization')).toHaveValue('0.5');
    await expect(control(page, 'bloom')).toHaveValue('0.5');

    // Click the block group reset button (the .group-reset inside the Block fieldset).
    await activateFilterTab(page, 'Block');
    await page.locator('fieldset.filter-group:has(legend:text-is("Block"))').locator('.group-reset').click();
    await expect(control(page, 'posterization')).toHaveValue('0.83');
    // The bloom control should be unchanged by the block reset.
    await expect(control(page, 'bloom')).toHaveValue('0.5');

    // Verify the group reset committed to history: undo should restore the edited state.
    await expect(page.locator('#undo-btn')).toBeEnabled();
    await page.locator('#undo-btn').click();
    await expect(control(page, 'posterization')).toHaveValue('0.5');
    await expect(control(page, 'bloom')).toHaveValue('0.5');
  });

  test('saves, loads, replaces, and deletes presets through the save dialog and localStorage', async ({ page }) => {
    await page.evaluate(() => localStorage.clear());
    await upload(page, createSmallValidUpload());
    await expect(page.locator('#preset-list')).toContainText('No saved presets.');
    // Status live region is mounted from initial render; empty status stays sr-only.
    const presetStatus = page.locator('#preset-status');
    await expect(presetStatus).toHaveCount(1);
    await expect(presetStatus).toHaveAttribute('role', 'status');
    await expect(presetStatus).toHaveAttribute('aria-live', 'polite');
    await expect(presetStatus).toHaveAttribute('aria-atomic', 'true');
    await expect(presetStatus).toHaveClass(/sr-only/);
    // Presets group is a bordered fieldset with a legend.
    await expect(page.locator('fieldset.presets-panel > legend')).toHaveText('Presets');
    // The inline name field is gone; saving happens only through the dialog.
    await expect(page.locator('#preset-name')).toHaveCount(0);
    // Actions are contextual row actions; the top-level selected-action buttons are gone.
    await expect(page.locator('#preset-delete-btn')).toHaveCount(0);
    await expect(page.locator('#preset-export-btn')).toHaveCount(0);

    await control(page, 'posterization').evaluate((input) => {
      input.value = '0.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Radix portals the dialog to body, so every locator here is document-wide.
    const saveDialog = page.locator('#preset-save-dialog');
    const saveName = page.locator('#preset-save-name');
    const saveError = page.locator('#preset-save-error');
    const replaceBtn = page.locator('#preset-replace-btn');

    await page.locator('#preset-save-btn').click();
    await expect(saveDialog).toBeVisible();
    await expect(saveDialog).toHaveAttribute('role', 'dialog');
    await expect(saveDialog).toHaveAttribute('aria-modal', 'true');
    await expect(saveDialog).toHaveAttribute('aria-labelledby', 'preset-save-title');
    await expect(saveDialog).toHaveAttribute('aria-describedby', 'preset-save-description');
    await expect(page.locator('#preset-save-overlay')).toBeVisible();
    await expect(page.locator('#preset-save-title')).toHaveText('Save preset');
    await expect(page.locator('#preset-save-description')).toContainText('explicit replace');
    await expect(page.locator('#preset-save-form')).toBeVisible();
    await expect(saveName).toBeFocused();
    await expect(saveName).toHaveValue('');
    await expect(saveError).toHaveCount(1);
    await expect(saveError).toHaveAttribute('role', 'alert');
    await expect(saveError).toHaveClass(/sr-only/);
    await expect(page.locator('#preset-save-confirm-btn')).toBeDisabled();
    await expect(replaceBtn).toBeHidden();
    await expect(page.locator('#preset-save-cancel-btn')).toBeEnabled();

    // Unique name: Save commits, closes the dialog, and updates status and list.
    await saveName.fill('test preset');
    await expect(page.locator('#preset-save-confirm-btn')).toBeEnabled();
    await page.locator('#preset-save-confirm-btn').click();
    await expect(saveDialog).toBeHidden();
    await expect(page.locator('#preset-list')).toContainText('test preset');
    await expect(presetStatus).toContainText('Saved preset "test preset".');
    await expect(presetStatus).not.toHaveClass(/sr-only/);

    // Each saved row owns one export and one delete action, scoped to that row.
    const savedRow = page.locator('#preset-list .preset-item');
    await expect(savedRow).toHaveCount(1);
    await expect(savedRow).toHaveAttribute('data-preset-name', 'test preset');
    await expect(savedRow).toHaveAttribute('data-preset-index', '0');
    await expect(savedRow.locator('[data-preset-action="export"]')).toHaveCount(1);
    await expect(savedRow.locator('[data-preset-action="delete"]')).toHaveCount(1);
    await expect(savedRow.locator('#preset-export-btn-0')).toHaveCount(1);
    await expect(savedRow.locator('#preset-delete-btn-0')).toHaveCount(1);

    const rowExportDownload = page.waitForEvent('download');
    await savedRow.locator('[data-preset-action="export"]').click();
    const rowExport = await rowExportDownload;
    expect(rowExport.suggestedFilename()).toBe('test_preset.coarse-grid-preset.json');

    await control(page, 'posterization').evaluate((input) => {
      input.value = '0.9';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(control(page, 'posterization')).toHaveValue('0.9');
    await page.locator('#preset-list .preset-item-name').click();
    await expect(control(page, 'posterization')).toHaveValue('0.5');

    await control(page, 'posterization').evaluate((input) => {
      input.value = '0.9';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#preset-save-btn').click();
    await expect(saveName).toBeFocused();
    await expect(saveName).toHaveValue('');
    await expect(page.locator('#preset-save-confirm-btn')).toBeDisabled();
    await saveName.fill('test preset');
    await expect(replaceBtn).toBeVisible();
    await expect(replaceBtn).toHaveText('Replace "test preset"');
    await expect(replaceBtn).toBeEnabled();
    await expect(page.locator('#preset-save-confirm-btn')).toBeDisabled();

    // Explicit Replace is the only overwrite path; it closes the dialog and
    // keeps exactly one list row.
    await replaceBtn.click();
    await expect(saveDialog).toBeHidden();
    await expect(presetStatus).toContainText('Overwrote preset "test preset".');
    await expect(page.locator('#preset-list .preset-item')).toHaveCount(1);

    // The replace stored the edited params: reloading now yields 0.9, not 0.5.
    await control(page, 'posterization').evaluate((input) => {
      input.value = '0.3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#preset-list .preset-item-name').click();
    await expect(control(page, 'posterization')).toHaveValue('0.9');

    await page.locator('#preset-list .preset-item [data-preset-action="delete"]').click();
    await expect(page.locator('#preset-list')).toContainText('No saved presets.');
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('coarse-grid.presets.v1.')));
    expect(stored).toEqual([]);
  });

  test('toggles between original and result comparison', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    const compareBtn = page.locator('#compare-btn');
    await expect(compareBtn).toBeEnabled();
    await expect(compareBtn).toHaveText('Show original');
    await compareBtn.click();
    await expect(compareBtn).toHaveText('Show result');
    await compareBtn.click();
    await expect(compareBtn).toHaveText('Show original');
  });

  test('changes preview background color without error', async ({ page }) => {
    await upload(page, createSmallValidUpload());
    const bgInput = page.locator('#preview-background');
    await expect(bgInput).toBeEnabled();
    await bgInput.evaluate((input) => {
      input.value = '#ff0000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(bgInput).toHaveValue('#ff0000');
    await expect(page.locator('#preview-canvas')).toBeVisible();
    await expect(page.locator('#status')).not.toContainText('error');
  });
});

test.describe('WebGL resource lifecycle isolation', () => {

  test('monotonically deletes WebGL textures, framebuffers, and buffers across replacement and page teardown', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    const counts = { texture: 0, framebuffer: 0, buffer: 0 };
    window.__webglDeletionCounts = counts;
    for (const [method, key] of [['deleteTexture', 'texture'], ['deleteFramebuffer', 'framebuffer'], ['deleteBuffer', 'buffer']]) {
      const original = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (resource) {
        if (resource) counts[key] += 1;
        return original.call(this, resource);
      };
    }
  });
  await page.goto('/');
  await upload(page, createSmallValidUpload());
  const initial = await page.evaluate(() => ({ ...window.__webglDeletionCounts }));
  await upload(page, createAsymmetricOrientationUpload());
  const replaced = await page.evaluate(() => ({ ...window.__webglDeletionCounts }));
  expect(replaced.texture).toBeGreaterThan(initial.texture);
  expect(replaced.framebuffer).toBeGreaterThan(initial.framebuffer);
  expect(replaced.buffer).toBeGreaterThanOrEqual(initial.buffer);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const tornDown = await page.evaluate(() => ({ ...window.__webglDeletionCounts }));
  for (const key of ['texture', 'framebuffer', 'buffer']) {
    expect(tornDown[key], `${key} deletion count must be monotonic through pagehide teardown`).toBeGreaterThanOrEqual(replaced[key]);
    expect(tornDown[key], `${key} resources must be deleted by teardown`).toBeGreaterThan(0);
  }
  await context.close();
  });
});
