import { PNG } from 'pngjs';

const PNG_MIME_TYPE = 'image/png';

function rgba(...pixels) {
  return Buffer.from(pixels.flat());
}

function encodePng(width, height, pixels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError('PNG dimensions must be positive integers.');
  }

  const data = Buffer.from(pixels);
  if (data.length !== width * height * 4) {
    throw new RangeError('PNG pixel data must contain exactly width * height * 4 bytes.');
  }

  const image = new PNG({ colorType: 6, inputColorType: 6, inputHasAlpha: true, width, height });
  data.copy(image.data);
  return PNG.sync.write(image, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
}

function filePayload(name, mimeType, buffer) {
  return { name, mimeType, buffer: Buffer.from(buffer) };
}

/**
 * Creates a 4 by 3 opaque PNG with distinct red, green, blue, and yellow
 * corners. Its asymmetric interior makes top-left orientation mistakes visible.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createAsymmetricOrientationUpload() {
  return filePayload('asymmetric-orientation.png', PNG_MIME_TYPE, encodePng(4, 3, rgba(
    [255, 0, 0, 255], [32, 32, 32, 255], [255, 255, 255, 255], [0, 255, 0, 255],
    [255, 0, 255, 255], [64, 128, 192, 255], [16, 16, 16, 255], [0, 255, 255, 255],
    [0, 0, 255, 255], [255, 128, 0, 255], [128, 0, 255, 255], [255, 255, 0, 255],
  )));
}

/**
 * Creates a 4 by 2 PNG for opaque-background compositing checks. It includes
 * fully transparent cyan and white pixels plus 50% alpha red, green, and blue pixels.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createTransparencyCompositionUpload() {
  return filePayload('transparent-composition.png', PNG_MIME_TYPE, encodePng(4, 2, rgba(
    [0, 255, 255, 0], [255, 0, 0, 128], [0, 255, 0, 128], [0, 0, 255, 128],
    [255, 255, 255, 0], [255, 255, 0, 64], [0, 0, 0, 255], [255, 255, 255, 255],
  )));
}

/**
 * Creates an 8 by 4 opaque PNG with explicit multicolor ramps, dark values,
 * highlights, and abrupt color transitions for gradient and effect assertions.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createMulticolorGradientUpload() {
  return filePayload('multicolor-gradient.png', PNG_MIME_TYPE, encodePng(8, 4, rgba(
    [0, 0, 0, 255], [36, 0, 72, 255], [72, 0, 144, 255], [108, 0, 216, 255], [144, 0, 255, 255], [180, 36, 255, 255], [216, 72, 255, 255], [255, 108, 255, 255],
    [0, 36, 72, 255], [0, 72, 108, 255], [0, 108, 144, 255], [0, 144, 180, 255], [0, 180, 216, 255], [0, 216, 255, 255], [72, 236, 255, 255], [144, 255, 255, 255],
    [0, 72, 0, 255], [36, 108, 0, 255], [72, 144, 0, 255], [108, 180, 0, 255], [144, 216, 0, 255], [180, 255, 0, 255], [216, 255, 72, 255], [255, 255, 144, 255],
    [72, 0, 0, 255], [108, 36, 0, 255], [144, 72, 0, 255], [180, 108, 0, 255], [216, 144, 0, 255], [255, 180, 0, 255], [255, 216, 72, 255], [255, 255, 255, 255],
  )));
}

/**
 * Creates a 4 by 2 PNG where transparent pixels have bright RGB values.
 * Used to verify that hidden RGB under alpha=0 does not create an alpha halo
 * or bleed into the exported alpha channel.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createHiddenRgbTransparentUpload() {
  return filePayload('hidden-rgb-transparent.png', PNG_MIME_TYPE, encodePng(4, 2, rgba(
    [255, 255, 255, 0], [255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0],
    [255, 255, 0, 0], [255, 0, 255, 0], [0, 255, 255, 0], [128, 128, 128, 0],
  )));
}

/**
 * Creates a compact, valid 2 by 2 opaque PNG for successful upload flows.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createSmallValidUpload() {
  return filePayload('small-valid.png', PNG_MIME_TYPE, encodePng(2, 2, rgba(
    [255, 0, 0, 255], [0, 255, 0, 255],
    [0, 0, 255, 255], [255, 255, 0, 255],
  )));
}

/**
 * Creates a 64 by 64 opaque, asymmetric fixture with a diagonal color edge.
 * The long, high-contrast edge makes 45° and 135° rib/fringe probes observable
 * without relying on shader source text.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createDirectionalProbeUpload() {
  const width = 64;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const upper = x + y < width;
      pixels[offset] = upper ? 250 : 16;
      pixels[offset + 1] = upper ? 224 : 48;
      pixels[offset + 2] = upper ? 32 : 244;
      pixels[offset + 3] = 255;
    }
  }
  return filePayload('directional-probe.png', PNG_MIME_TYPE, encodePng(width, height, pixels));
}

/**
 * Creates a 64 by 64 semi-opaque uniform PNG with RGB (128,128,128) and alpha=128.
 * At blockPercent=50%, bs = round(64 * 50 / 100) = 32 (> 16, all tiles fully contained).
 * At blockPercent=30%, bs = round(64 * 30 / 100) = 19 (> 16, boundary tiles exist).
 * Used to verify the tile-sum path preserves partial alpha and handles boundary tiles.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createSemiOpaqueTileSumUpload() {
  const width = 64;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = 128;
    pixels[i * 4 + 1] = 128;
    pixels[i * 4 + 2] = 128;
    pixels[i * 4 + 3] = 128;
  }
  return filePayload('semi-opaque-tile-sum.png', PNG_MIME_TYPE, encodePng(width, height, pixels));
}

/**
 * Creates a 1000 by 500 opaque, highly compressible PNG. At 200% it reaches
 * the product's real 2000 by 1000 (2MP) export boundary without committing a binary fixture.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createHalfMegapixelCompressibleUpload() {
  const width = 1000;
  const height = 500;
  const pixels = Buffer.alloc(width * height * 4);
  pixels.fill(Buffer.from([48, 96, 144, 255]));
  return filePayload('half-megapixel-compressible.png', PNG_MIME_TYPE, encodePng(width, height, pixels));
}

/**
 * Creates a 2828 by 2828 opaque, highly compressible PNG. At 100% export it reaches
 * ~8MP (7,997,584 pixels) — the product's raised export boundary.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createEightMegapixelCompressibleUpload() {
  const width = 2828;
  const height = 2828;
  const pixels = Buffer.alloc(width * height * 4);
  pixels.fill(Buffer.from([48, 96, 144, 255]));
  return filePayload('eight-megapixel-compressible.png', PNG_MIME_TYPE, encodePng(width, height, pixels));
}

/**
 * Creates a 2829 by 2828 opaque, highly compressible PNG. At 100% export it reaches
 * 8,003,240 pixels — just over the 8MP product limit, so 100% should be disabled.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createOverEightMegapixelCompressibleUpload() {
  const width = 2829;
  const height = 2828;
  const pixels = Buffer.alloc(width * height * 4);
  pixels.fill(Buffer.from([48, 96, 144, 255]));
  return filePayload('over-eight-megapixel-compressible.png', PNG_MIME_TYPE, encodePng(width, height, pixels));
}

/**
 * Creates a non-empty PNG-typed payload whose bytes are not an image.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }} Playwright file payload.
 */
function createCorruptImageUpload() {
  return filePayload('corrupt-image.png', PNG_MIME_TYPE, Buffer.from('not-a-png\n', 'utf8'));
}

/**
 * Creates two valid PNG payloads for the application's one-file-at-a-time rejection path.
 *
 * @returns {{ name: string, mimeType: string, buffer: Buffer }[]} Playwright file payloads.
 */
function createMultiFileUpload() {
  return [createSmallValidUpload(), createAsymmetricOrientationUpload()];
}

/**
 * Decodes a PNG buffer, including downloaded exports, into top-left RGBA pixels.
 *
 * @param {Buffer | Uint8Array} buffer PNG bytes.
 * @returns {{ width: number, height: number, data: Buffer }} Decoded PNG dimensions and RGBA bytes.
 */
function decodePngBuffer(buffer) {
  const image = PNG.sync.read(Buffer.from(buffer));
  return { width: image.width, height: image.height, data: Buffer.from(image.data) };
}

export {
  createAsymmetricOrientationUpload,
  createTransparencyCompositionUpload,
  createHiddenRgbTransparentUpload,
  createMulticolorGradientUpload,
  createSmallValidUpload,
  createDirectionalProbeUpload,
  createSemiOpaqueTileSumUpload,
  createHalfMegapixelCompressibleUpload,
  createEightMegapixelCompressibleUpload,
  createOverEightMegapixelCompressibleUpload,
  createCorruptImageUpload,
  createMultiFileUpload,
  decodePngBuffer,
};
