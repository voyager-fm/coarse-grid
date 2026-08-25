/**
 * gpu-filter.ts — regl-based WebGL2 filter renderer
 *
 * Erasable-syntax-only TypeScript: types are stripped by Node's native type
 * stripping; there is no build step and no non-erasable syntax (no enum,
 * namespace, decorator, or parameter property).
 *
 * Typing notes (regl surface):
 * - Types come from regl@2.1.1's bundled dist/regl.d.ts (CommonJS `export =`);
 *   the default import resolves through the synthetic default implied by
 *   moduleResolution "bundler".
 * - regl's declarations omit `destroy()` on DrawCommand and on the Regl
 *   instance even though both expose it at runtime; destroy() therefore takes
 *   an unknown resource narrowed by isDestroyable().
 * - Closure state (regl/gl/commands/capabilities) is populated by initialize()
 *   before any caller can reach the helpers below; require*() guards make that
 *   invariant explicit to strict TS instead of using non-null assertions.
 *
 * @module gpu-filter
 */

import createREGL from 'regl';
import {
  computeBlockResolution,
  computeBlockSize,
  convertLogicalToTargetPixels,
  flipRowsInPlace,
  hexToLinearRgb,
  normalizeFilterParams,
  validateExportLimits,
  validateInputLimits,
} from './filter-params.ts';
import type { FilterParams } from './filter-params.ts';
import {
  DISPLAY_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  SOURCE_SHADER,
  POST_SHADER,
} from './gpu-shaders.ts';
import { BLOCK_REDUCTION_SHADER, TILE_SUM_SHADER } from './gpu-reduction-shaders.ts';

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = Object.freeze({ alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
const FULLSCREEN_TRIANGLE: number[][] = [[-1, -1], [3, -1], [-1, 3]];

/** Stable error codes raised by the GPU renderer. */
export type GpuErrorCode =
  | 'webgl2-unavailable'
  | 'float-color-buffer-unavailable'
  | 'float-framebuffer-incomplete'
  | 'gpu-size-limit'
  | 'framebuffer-incomplete'
  | 'allocation-failed'
  | 'context-lost'
  | 'context-restore-failed'
  | 'renderer-destroyed'
  | 'export-cancelled';

/** Error raised by the GPU renderer. `code` is stable for controller error handling. */
export class GpuFilterError extends Error {
  readonly code: GpuErrorCode;
  constructor(code: GpuErrorCode, message: string = code) { super(message); this.name = 'GpuFilterError'; this.code = code; }
}

function error(code: GpuErrorCode, cause: unknown): GpuFilterError {
  if (cause instanceof GpuFilterError) return cause;
  return new GpuFilterError(code, cause instanceof Error ? cause.message : undefined);
}

/**
 * Runtime narrowing for regl teardown: resources, draw commands, and the regl
 * instance all expose `destroy()` at runtime, but regl's bundled declarations
 * omit it on DrawCommand and Regl. The structural guard keeps destroy()
 * cast-free; every caller passes a live regl object. regl textures/FBOs are
 * callable functions with methods attached, so functions are accepted too.
 */
function isDestroyable(resource: unknown): resource is { destroy(): void } {
  if ((typeof resource !== 'object' && typeof resource !== 'function') || resource === null) return false;
  return 'destroy' in resource && typeof resource.destroy === 'function';
}

function destroy(resource: unknown): void { if (isDestroyable(resource)) resource.destroy(); }

/** Runtime narrowing for lib.dom's loosely-typed getParameter results. */
function isNumericSequence(value: unknown): value is readonly number[] {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

function isRgbaBytes(value: unknown): value is Uint8Array | Uint8ClampedArray { return value instanceof Uint8Array || value instanceof Uint8ClampedArray; }

/** Visible preview canvas plus optional lifecycle callbacks. */
export interface GpuFilterOptions {
  canvas: HTMLCanvasElement;
  onContextLost?: () => void;
  onContextRestored?: (error?: GpuFilterError) => void;
}

/** Frozen GPU capability snapshot captured at initialization/restore time. */
export interface GpuCapabilities {
  readonly maxTextureSize: number;
  readonly maxRenderbufferSize: number;
  readonly maxViewportDims: number[];
  readonly width: number;
  readonly height: number;
}

/** Top-left-origin RGBA8 source pixels plus optional params/export scale. */
export interface GpuFilterSourceInput {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
  params?: Record<string, unknown>;
  exportScale?: number;
}

/** Export request: target dimensions, optional params snapshot, optional abort signal. */
export interface GpuFilterExportInput {
  width: number;
  height: number;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Opaque top-left-origin RGBA8 export result. */
export interface GpuFilterExportResult {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Display compositing options (partial update). */
export interface GpuFilterDisplayOptions {
  showOriginal?: boolean;
  previewBackground?: number[];
}

/** Deterministic WebGL2 + EXT_color_buffer_float filter renderer handle. */
export interface GpuFilterRenderer {
  readonly capabilities: Readonly<GpuCapabilities>;
  setSource(input: GpuFilterSourceInput): { width: number; height: number };
  replaceSource(input: GpuFilterSourceInput): { width: number; height: number };
  requestPreview(params?: Record<string, unknown>, renderOptions?: { immediate?: boolean }): Promise<boolean>;
  renderPreview(params?: Record<string, unknown>, renderOptions?: { immediate?: boolean }): Promise<boolean>;
  resizePreview(targetWidth: number, targetHeight: number, params?: Record<string, unknown>): boolean;
  exportRgba(input: GpuFilterExportInput): Promise<GpuFilterExportResult>;
  cancelExport(): void;
  destroySource(): void;
  setDisplay(opts: GpuFilterDisplayOptions): void;
  destroy(): void;
}

/** Fully normalized parameter record produced by normalizeFilterParams. */
type NormalizedParams = FilterParams & Record<string, number | boolean | string>;

interface RenderTarget {
  texture: createREGL.Texture2D;
  framebuffer: createREGL.Framebuffer2D;
  width: number;
  height: number;
}

/** Block geometry computed by validate(). */
interface BlockGeometry {
  blockSize: number;
  blocks: { width: number; height: number };
}

/**
 * GPU surfaces for one render configuration. `blocks` holds the block-sum
 * render target; its width/height carry the block resolution.
 */
interface RenderBundle {
  width: number;
  height: number;
  blockSize: number;
  scene: RenderTarget;
  blocks: RenderTarget;
  post: RenderTarget;
  tileSum: RenderTarget | null;
  tileSumDirty: boolean;
}

/**
 * Superset of dynamic properties consumed via regl.prop(...) by the five
 * commands; each command reads only the keys its uniforms declare.
 */
interface CommandProps {
  framebuffer: createREGL.Framebuffer | null;
  viewport: createREGL.BoundingBox;
  sourceTexture: createREGL.Texture2D;
  resultTexture: createREGL.Texture2D;
  sceneTexture: createREGL.Texture2D;
  blocksTexture: createREGL.Texture2D;
  tileSumTexture: createREGL.Texture2D;
  sourceResolution: number[];
  sceneResolution: number[];
  blockResolution: number[];
  blockSize: number;
  blockPercent: number;
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
  negativeFringeTint: number[];
  positiveFringeTint: number[];
  rgbFringeEnabled: boolean;
  contrast: number;
  contrastEnabled: boolean;
  posterization: number;
  ribLowLuminanceValueScale: number;
  ribHighLuminanceValueScale: number;
  ribLowLuminanceSaturationScale: number;
  ribHighLuminanceSaturationScale: number;
  previewBackground: number[];
  showOriginal: boolean;
}

/**
 * regl bound to the CommandProps dynamic-prop contract. regl's own `prop` is
 * generic over Props and cannot infer it from the key alone, so re-declaring it
 * here (via Omit to keep every other member) lets `regl.prop('key')` type-check
 * without per-call type arguments; the draw-command call signature is re-added
 * because Omit/Pick drop an interface's call signatures.
 */
type BoundRegl = Omit<createREGL.Regl, 'prop'> & {
  <
    Uniforms extends {} = {},
    Attributes extends {} = {},
    Props extends {} = {},
    OwnContext extends {} = {},
    ParentContext extends createREGL.DefaultContext = createREGL.DefaultContext,
  >(drawConfig: createREGL.DrawConfig<Uniforms, Attributes, Props, OwnContext, ParentContext>): createREGL.DrawCommand<ParentContext & OwnContext, Props>;
  prop<Key extends keyof CommandProps>(name: Key): createREGL.DynamicVariable<CommandProps[Key]>;
};

type FilterCommand = createREGL.DrawCommand<createREGL.DefaultContext, CommandProps>;

interface GpuCommands {
  upload: FilterCommand;
  tileSum: FilterCommand;
  reduce: FilterCommand;
  post: FilterCommand;
  blit: FilterCommand;
}

/** Coalesced animation-frame preview job. */
interface PreviewJob {
  resolve(value: boolean): void;
  reject(cause: unknown): void;
  params?: Record<string, unknown>;
  token: number;
}

/** Retained source state (pixels survive context loss for rebuild). */
interface SourceRecord {
  width: number;
  height: number;
  pixels: Uint8Array;
  params: NormalizedParams;
  texture: createREGL.Texture2D | null;
  preview: RenderBundle | null;
  previewWidth: number;
  previewHeight: number;
}

/** Strict-TS narrowing: every command was assigned above or the try block rethrew. */
function requireCommand(command: FilterCommand | undefined): FilterCommand {
  if (!command) throw new GpuFilterError('renderer-destroyed');
  return command;
}

/**
 * Creates the deterministic WebGL2 + EXT_color_buffer_float filter renderer.
 * Initialisation requires a WebGL2 context, the EXT_color_buffer_float extension,
 * and a complete 1×1 RGBA32F texture-backed framebuffer probe.
 */
export function createGpuFilter(options: GpuFilterOptions): GpuFilterRenderer {
  if (!options?.canvas || typeof options.canvas.getContext !== 'function') throw new GpuFilterError('webgl2-unavailable');
  const canvas = options.canvas;
  let regl: BoundRegl | null = null; let gl: WebGL2RenderingContext | null = null; let commands: GpuCommands | null = null; let capabilities: Readonly<GpuCapabilities> | null = null;
  let source: SourceRecord | null = null; let destroyed = false; let contextLost = false;
  let generation = 0; let frame = 0; let pendingPreview: PreviewJob | null = null; let activeExport: AbortController | null = null;
  let displayOptions = { showOriginal: false, previewBackground: [1.0, 1.0, 1.0] };

  const assertAvailable = (): void => {
    if (destroyed) throw new GpuFilterError('renderer-destroyed');
    if (contextLost) throw new GpuFilterError('context-lost');
  };
  const isCurrent = (token: number): boolean => !destroyed && !contextLost && token === generation;

  // Strict-TS narrowing over closure state populated by initialize(); every
  // caller sits behind assertAvailable(), so these guards are unreachable in
  // practice — they replace non-null assertions, which erasable discipline forbids.
  const requireGl = (): WebGL2RenderingContext => {
    if (!gl) throw new GpuFilterError('renderer-destroyed');
    return gl;
  };
  const requireRegl = (): BoundRegl => {
    if (!regl) throw new GpuFilterError('renderer-destroyed');
    return regl;
  };
  const requireCapabilities = (): Readonly<GpuCapabilities> => {
    if (!capabilities) throw new GpuFilterError('renderer-destroyed');
    return capabilities;
  };

  function getCapabilities(context: WebGL2RenderingContext): Readonly<GpuCapabilities> {
    // MAX_VIEWPORT_DIMS is always an Int32Array and the sizes are always numbers
    // on a conforming WebGL2 implementation; the guards keep the snapshot honestly
    // typed without assertions while preserving initialize()'s fail-closed contract.
    const dims: unknown = context.getParameter(context.MAX_VIEWPORT_DIMS);
    if (!isNumericSequence(dims)) throw new GpuFilterError('webgl2-unavailable');
    const maxViewportDims = Array.from(dims);
    const textureSize: unknown = context.getParameter(context.MAX_TEXTURE_SIZE);
    if (typeof textureSize !== 'number') throw new GpuFilterError('webgl2-unavailable');
    const renderbufferSize: unknown = context.getParameter(context.MAX_RENDERBUFFER_SIZE);
    if (typeof renderbufferSize !== 'number') throw new GpuFilterError('webgl2-unavailable');
    return Object.freeze({ maxTextureSize: textureSize, maxRenderbufferSize: renderbufferSize, maxViewportDims, width: Math.min(textureSize, renderbufferSize, maxViewportDims[0]), height: Math.min(textureSize, renderbufferSize, maxViewportDims[1]) });
  }

  function checkFramebuffer(framebuffer: createREGL.Framebuffer2D): void {
    const current = requireGl();
    let status: GLenum | undefined;
    framebuffer.use(() => { status = current.checkFramebufferStatus(current.FRAMEBUFFER); });
    if (status !== current.FRAMEBUFFER_COMPLETE) throw new GpuFilterError('framebuffer-incomplete');
  }

  function makeTarget(width: number, height: number, filter: createREGL.TextureMagFilterType, type: createREGL.TextureDataType = 'uint8'): RenderTarget {
    let texture: createREGL.Texture2D | undefined; let framebuffer: createREGL.Framebuffer2D | undefined;
    try {
      texture = requireRegl().texture({ width, height, format: 'rgba', type, min: filter, mag: filter, wrap: 'clamp', mipmap: false, alignment: 1 });

      framebuffer = requireRegl().framebuffer({ color: texture, depth: false, stencil: false });
      checkFramebuffer(framebuffer);
      return { texture, framebuffer, width, height };
    } catch (cause) {
      destroy(framebuffer); destroy(texture);
      throw error(cause instanceof GpuFilterError ? cause.code : 'allocation-failed', cause);
    }
  }

  function destroyTarget(target: RenderTarget | null | undefined): void { if (target) { destroy(target.framebuffer); destroy(target.texture); } }
  function destroyBundle(bundle: RenderBundle | null | undefined): void { if (bundle) { destroyTarget(bundle.scene); destroyTarget(bundle.blocks); destroyTarget(bundle.post); destroyTarget(bundle.tileSum); } }

  function validate(width: number, height: number, params: NormalizedParams, exportTarget: boolean): BlockGeometry {
    const blockSize = computeBlockSize(width, height, params.blockPercent);
    const result = (exportTarget ? validateExportLimits : validateInputLimits)(width, height, blockSize, requireCapabilities());
    if (!result.valid) throw new GpuFilterError('gpu-size-limit');
    return { blockSize, blocks: result.blocks ?? computeBlockResolution(width, height, blockSize) };
  }

  function createSourceTexture(width: number, height: number, pixels: Uint8Array): createREGL.Texture2D {
    try {
      return requireRegl().texture({ data: pixels, width, height, format: 'rgba', type: 'uint8', min: 'linear', mag: 'linear', wrap: 'clamp', mipmap: false, alignment: 1, flipY: false, premultiplyAlpha: false, colorSpace: 'none' });
    } catch (cause) {
      throw error('allocation-failed', cause);
    }
  }

  function createBundle(width: number, height: number, params: NormalizedParams, exportTarget = false): RenderBundle {
    const geometry = validate(width, height, params, exportTarget);
    let scene: RenderTarget | undefined; let blocks: RenderTarget | undefined; let post: RenderTarget | undefined; let tileSum: RenderTarget | null = null;
    try {
      scene = makeTarget(width, height, 'linear', 'uint8');
      blocks = makeTarget(geometry.blocks.width, geometry.blocks.height, 'nearest', 'uint8');
      post = makeTarget(width, height, 'linear', 'uint8');
      if (geometry.blockSize > 16) {
        const tileW = Math.ceil(width / 16);
        const tileH = Math.ceil(height / 16);
        tileSum = makeTarget(tileW, tileH, 'nearest', 'uint8');
      }
      return { width, height, ...geometry, scene, blocks, post, tileSum, tileSumDirty: true };
    } catch (cause) {
      destroyTarget(scene); destroyTarget(blocks); destroyTarget(post); destroyTarget(tileSum);
      throw error(cause instanceof GpuFilterError ? cause.code : 'allocation-failed', cause);
    }
  }

  function updateBundleGeometry(bundle: RenderBundle, params: NormalizedParams, exportTarget = false): RenderBundle {
    const geometry = validate(bundle.width, bundle.height, params, exportTarget);
    if (bundle.blockSize === geometry.blockSize && bundle.blocks.width === geometry.blocks.width && bundle.blocks.height === geometry.blocks.height) {
      return bundle;
    }
    const nextBlocks = makeTarget(geometry.blocks.width, geometry.blocks.height, 'nearest', 'uint8');
    const previousBlocks = bundle.blocks;
    bundle.blocks = nextBlocks;
    bundle.blockSize = geometry.blockSize;
    destroyTarget(previousBlocks);
    bundle.tileSumDirty = true;
    const needsTileSum = geometry.blockSize > 16;
    const hasTileSum = !!bundle.tileSum;
    if (needsTileSum && !hasTileSum) {
      bundle.tileSum = makeTarget(Math.ceil(bundle.width / 16), Math.ceil(bundle.height / 16), 'nearest', 'uint8');
    } else if (!needsTileSum && hasTileSum) {
      destroyTarget(bundle.tileSum);
      bundle.tileSum = null;
    }
    return bundle;
  }

  function commonConfig(fragment: string): createREGL.DrawConfig<createREGL.Uniforms, createREGL.Attributes, CommandProps> {
    if (!regl) throw new GpuFilterError('renderer-destroyed');
    return {
      vert: FULLSCREEN_VERTEX_SHADER, frag: fragment, attributes: { position: FULLSCREEN_TRIANGLE }, count: 3,
      depth: { enable: false, mask: false }, stencil: { enable: false }, blend: { enable: false }, cull: { enable: false }, dither: false,
      framebuffer: regl.prop('framebuffer'), viewport: regl.prop('viewport'),
    };
  }

  function destroyCommands(): void {
    if (commands) for (const command of Object.values(commands)) destroy(command);
    commands = null;
  }

  function createCommands(): void {
    if (!regl) throw new GpuFilterError('renderer-destroyed');
    const next: Partial<GpuCommands> = {};
    try {
      next.upload = regl<createREGL.Uniforms, createREGL.Attributes, CommandProps>({ ...commonConfig(SOURCE_SHADER), uniforms: { sourceTexture: regl.prop('sourceTexture'), sourceResolution: regl.prop('sourceResolution') } });
      next.tileSum = regl<createREGL.Uniforms, createREGL.Attributes, CommandProps>({ ...commonConfig(TILE_SUM_SHADER), uniforms: { sceneTexture: regl.prop('sceneTexture'), sceneResolution: regl.prop('sceneResolution') } });
      next.reduce = regl<createREGL.Uniforms, createREGL.Attributes, CommandProps>({ ...commonConfig(BLOCK_REDUCTION_SHADER), uniforms: { sceneTexture: regl.prop('sceneTexture'), tileSumTexture: regl.prop('tileSumTexture'), sceneResolution: regl.prop('sceneResolution'), blockSize: regl.prop('blockSize') } });
      next.post = regl<createREGL.Uniforms, createREGL.Attributes, CommandProps>({ ...commonConfig(POST_SHADER), uniforms: {
        sceneTexture: regl.prop('sceneTexture'), blocksTexture: regl.prop('blocksTexture'), sceneResolution: regl.prop('sceneResolution'), blockResolution: regl.prop('blockResolution'), blockSize: regl.prop('blockSize'),
        bloom: regl.prop('bloom'), bloomEnabled: regl.prop('bloomEnabled'), bloomHighlightLow: regl.prop('bloomHighlightLow'), bloomHighlightHigh: regl.prop('bloomHighlightHigh'), ribAngle: regl.prop('ribAngle'), ribPitch: regl.prop('ribPitch'), ribLowLuminanceWidth: regl.prop('ribLowLuminanceWidth'), ribHighLuminanceWidth: regl.prop('ribHighLuminanceWidth'), ribLowLuminanceDarkness: regl.prop('ribLowLuminanceDarkness'), ribHighLuminanceDarkness: regl.prop('ribHighLuminanceDarkness'), ribLuminanceLow: regl.prop('luminanceLow'), ribLuminanceHigh: regl.prop('luminanceHigh'), ribLuminanceGamma: regl.prop('luminanceGamma'), ribEdgeSoftness: regl.prop('ribEdgeSoftness'), ribsEnabled: regl.prop('ribsEnabled'), fringeDistance: regl.prop('fringeDistance'), fringeProbeDistance: regl.prop('fringeProbeDistance'), fringeIntensity: regl.prop('fringeIntensity'), fringeTintMix: regl.prop('fringeTintMix'), fringeEdgeLow: regl.prop('fringeEdgeLow'), fringeEdgeHigh: regl.prop('fringeEdgeHigh'), fringeRibEdgeLow: regl.prop('fringeRibEdgeLow'), fringeRibEdgeHigh: regl.prop('fringeRibEdgeHigh'), fringeMinimumRibEdgeContribution: regl.prop('fringeMinimumRibEdgeContribution'), blockFringeGain: regl.prop('blockFringeGain'), negativeFringeTint: regl.prop('negativeFringeTint'), positiveFringeTint: regl.prop('positiveFringeTint'), rgbFringeEnabled: regl.prop('rgbFringeEnabled'),
        contrast: regl.prop('contrast'), contrastEnabled: regl.prop('contrastEnabled'), posterization: regl.prop('posterization'), ribLowLuminanceValueScale: regl.prop('ribLowLuminanceValueScale'), ribHighLuminanceValueScale: regl.prop('ribHighLuminanceValueScale'), ribLowLuminanceSaturationScale: regl.prop('ribLowLuminanceSaturationScale'), ribHighLuminanceSaturationScale: regl.prop('ribHighLuminanceSaturationScale'),
      } });
      next.blit = regl<createREGL.Uniforms, createREGL.Attributes, CommandProps>({ ...commonConfig(DISPLAY_SHADER), uniforms: { sourceTexture: regl.prop('sourceTexture'), resultTexture: regl.prop('resultTexture'), previewBackground: regl.prop('previewBackground'), showOriginal: regl.prop('showOriginal') } });
    } catch (cause) {
      for (const command of Object.values(next)) destroy(command);
      throw cause;
    }
    destroyCommands();
    commands = {
      upload: requireCommand(next.upload),
      tileSum: requireCommand(next.tileSum),
      reduce: requireCommand(next.reduce),
      post: requireCommand(next.post),
      blit: requireCommand(next.blit),
    };
  }

  function initialize(): void {
    gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    if (!gl) throw new GpuFilterError('webgl2-unavailable');
    try {
      const originalGetExtension = gl.getExtension.bind(gl);
      gl.getExtension = function (name) {
        if (name === 'OES_texture_float' || name === 'oes_texture_float') return {};

        return originalGetExtension(name);
      };

      regl = createREGL({ gl, optionalExtensions: ['OES_texture_float'] });
      capabilities = getCapabilities(gl);
      if (!gl.getExtension('EXT_color_buffer_float')) throw new GpuFilterError('float-color-buffer-unavailable');
      let probeTexture: WebGLTexture | null = null; let probeFbo: WebGLFramebuffer | null = null;
      try {
        probeTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, probeTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        probeFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probeTexture, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) throw new GpuFilterError('float-framebuffer-incomplete');
      } finally { if (probeFbo) gl.deleteFramebuffer(probeFbo); if (probeTexture) gl.deleteTexture(probeTexture); }
      createCommands();
    } catch (cause) { destroyCommands(); destroy(regl); regl = null; throw cause; }
  }

  function draw(bundle: RenderBundle, sourceTexture: createREGL.Texture2D, params: NormalizedParams, postTarget: RenderTarget = bundle.post): void {
    if (!regl || !commands) throw new GpuFilterError('renderer-destroyed');
    regl.poll();
    const sceneViewport = { x: 0, y: 0, width: bundle.width, height: bundle.height };
    commands.upload({ framebuffer: bundle.scene.framebuffer, viewport: sceneViewport, sourceTexture, sourceResolution: [bundle.width, bundle.height] });
    if (bundle.tileSum && bundle.tileSumDirty) {
      commands.tileSum({ framebuffer: bundle.tileSum.framebuffer, viewport: { x: 0, y: 0, width: bundle.tileSum.width, height: bundle.tileSum.height }, sceneTexture: bundle.scene.texture, sceneResolution: [bundle.width, bundle.height] });
      bundle.tileSumDirty = false;
    }
    commands.reduce({ framebuffer: bundle.blocks.framebuffer, viewport: { x: 0, y: 0, width: bundle.blocks.width, height: bundle.blocks.height }, sceneTexture: bundle.scene.texture, tileSumTexture: bundle.tileSum?.texture ?? bundle.scene.texture, sceneResolution: [bundle.width, bundle.height], blockSize: bundle.blockSize });
    // Convert logical-unit spatial params to target pixels before passing to shader.
    const pixelParams = convertLogicalToTargetPixels(params, bundle.width, bundle.height);
    commands.post({ framebuffer: postTarget.framebuffer, viewport: sceneViewport, sceneTexture: bundle.scene.texture, blocksTexture: bundle.blocks.texture, sceneResolution: [bundle.width, bundle.height], blockResolution: [bundle.blocks.width, bundle.blocks.height], blockSize: bundle.blockSize, ...pixelParams, negativeFringeTint: hexToLinearRgb(pixelParams.negativeFringeTint), positiveFringeTint: hexToLinearRgb(pixelParams.positiveFringeTint) });
  }

  /** Transactionally replaces the retained source. Pixels are copied so restoration is independent of callers. When `exportScale` is provided, the preview bundle is created at the export target dimensions instead of source dimensions. */
  function setSource(input: GpuFilterSourceInput): { width: number; height: number } {
    assertAvailable();
    const width = Number(input?.width); const height = Number(input?.height); const pixels = input?.pixels;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !isRgbaBytes(pixels) || pixels.length !== width * height * 4) throw new TypeError('source must contain top-left RGBA8 pixels');
    const params = normalizeFilterParams(input.params);
    validate(width, height, params, false);
    const exportScale = input.exportScale ?? 100;
    const targetW = Math.max(1, Math.round(width * exportScale / 100));
    const targetH = Math.max(1, Math.round(height * exportScale / 100));
    const bytes = new Uint8Array(pixels);
    let texture: createREGL.Texture2D | undefined; let pvW: number | undefined; let pvH: number | undefined;
    let preview: RenderBundle | undefined;
    try {
      texture = createSourceTexture(width, height, bytes);
      // Preview is a display surface — validate against input limits (16MP), not export limits.
      // This allows the preview to render at the export scale even when the target exceeds the
      // export limit (the scale will be disabled for export, but the user can still see the effect).
      pvW = targetW; pvH = targetH;
      preview = createBundle(pvW, pvH, params, false);
    } catch (cause) {
      destroy(texture);
      // Fallback: create preview at source dimensions (e.g., GPU limits exceeded at target scale).
      try {
        texture = createSourceTexture(width, height, bytes);
        pvW = width; pvH = height;
        preview = createBundle(pvW, pvH, params, false);
      } catch (fallbackCause) {
        destroy(texture); destroyBundle(preview);
        throw error(cause instanceof GpuFilterError ? cause.code : 'allocation-failed', cause);
      }
    }
    cancelPending();
    const previous = source; source = { width, height, pixels: bytes, params, texture, preview, previewWidth: pvW, previewHeight: pvH }; generation += 1;
    canvas.width = pvW;
    canvas.height = pvH;
    destroy(previous?.texture); destroyBundle(previous?.preview);
    return { width: pvW, height: pvH };
  }

  function renderNow(params?: Record<string, unknown>): boolean {
    assertAvailable();
    if (!source?.preview || !source.texture) return false;
    const normalized = normalizeFilterParams(params);
    const token = generation;
    // Ensure canvas dimensions match the preview bundle (may have been resized by resizePreview or export).
    canvas.width = source.preview.width;
    canvas.height = source.preview.height;
    updateBundleGeometry(source.preview, normalized);
    draw(source.preview, source.texture, normalized);
    if (!isCurrent(token)) return false;
    if (!commands) throw new GpuFilterError('renderer-destroyed');
    commands.blit({ framebuffer: null, viewport: { x: 0, y: 0, width: canvas.width, height: canvas.height }, sourceTexture: source.texture, resultTexture: source.preview.post.texture, previewBackground: displayOptions.previewBackground, showOriginal: displayOptions.showOriginal });
    source.params = normalized;
    return true;
  }

  /** Resizes the preview bundle to new target dimensions. Keeps the old bundle on failure. */
  function resizePreview(targetWidth: number, targetHeight: number, params?: Record<string, unknown>): boolean {
    assertAvailable();
    if (!source?.preview) return false;
    if (source.preview.width === targetWidth && source.preview.height === targetHeight) return true;
    cancelPreview();
    const normalized = normalizeFilterParams(params);
    try {
      const bundle = createBundle(targetWidth, targetHeight, normalized);
      const previous = source.preview;
      source.preview = bundle;
      destroyBundle(previous);
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      requireRegl().poll();
      renderNow(normalized);
      return true;
    } catch {
      // Keep old preview bundle on failure — error is reported to caller.
      return false;
    }
  }

  /** Schedules a coalesced preview; `immediate` bypasses the animation-frame queue. */
  function requestPreview(params?: Record<string, unknown>, renderOptions: { immediate?: boolean } = {}): Promise<boolean> {
    try { assertAvailable(); } catch (cause) { return Promise.reject(cause); }
    if (source) source.params = normalizeFilterParams(params);
    if (renderOptions.immediate) {
      cancelPreview();
      try { return Promise.resolve(renderNow(params)); } catch (cause) { return Promise.reject(cause); }
    }
    if (pendingPreview) pendingPreview.resolve(false);
    return new Promise((resolve, reject) => {
      const token = generation; pendingPreview = { resolve, reject, params, token };
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0; const job = pendingPreview; pendingPreview = null;
        if (!job) return;
        try { job.resolve(isCurrent(job.token) ? renderNow(job.params) : false); } catch (cause) { job.reject(cause); }
      });
    });
  }

  /** Renders an export target and returns top-left-origin opaque RGBA8 bytes. */
  function waitForFrame(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new GpuFilterError('export-cancelled')); return; }
      const frameId = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
      const abort = (): void => { cancelAnimationFrame(frameId); signal.removeEventListener('abort', abort); reject(new GpuFilterError('export-cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async function exportRgba(input: GpuFilterExportInput): Promise<GpuFilterExportResult> {
    assertAvailable();
    if (!source || !source.texture) throw new GpuFilterError('export-cancelled');
    if (activeExport) throw new GpuFilterError('export-cancelled');
    const width = Number(input?.width); const height = Number(input?.height); const params = normalizeFilterParams(input?.params ?? source.params);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new GpuFilterError('gpu-size-limit');
    validate(width, height, params, true);
    const token = generation; const controller = new AbortController(); activeExport = controller;
    const abort = (): void => controller.abort(); input?.signal?.addEventListener('abort', abort, { once: true });
    if (input?.signal?.aborted) controller.abort();
    let bundle: RenderBundle | undefined; let failure: GpuFilterError | undefined; let result: GpuFilterExportResult | undefined;
    cancelPreview();
    const preview = source.preview;
    source.preview = null;
    destroyBundle(preview);
    try {
      await waitForFrame(controller.signal);
      if (controller.signal.aborted || !isCurrent(token)) throw new GpuFilterError('export-cancelled');
      bundle = createBundle(width, height, params, true);
      draw(bundle, source.texture, params);
      if (controller.signal.aborted || !isCurrent(token)) throw new GpuFilterError('export-cancelled');
      const pixels = requireRegl().read({ framebuffer: bundle.post.framebuffer });
      flipRowsInPlace(pixels, width, height);
      if (controller.signal.aborted || !isCurrent(token)) throw new GpuFilterError('export-cancelled');
      result = { width, height, pixels };
    } catch (cause) {
      failure = error(cause instanceof GpuFilterError ? cause.code : 'allocation-failed', cause);
    } finally {
      input?.signal?.removeEventListener('abort', abort); destroyBundle(bundle);
      if (activeExport === controller) activeExport = null;
      if (isCurrent(token) && source && !source.preview) {
        try {
          const pw = source.previewWidth ?? source.width;
          const ph = source.previewHeight ?? source.height;
          source.preview = createBundle(pw, ph, source.params, true);
          canvas.width = pw;
          canvas.height = ph;
          renderNow(source.params);
        } catch (cause) {
          destroyBundle(source.preview); source.preview = null;
          if (!failure) failure = error(cause instanceof GpuFilterError ? cause.code : 'allocation-failed', cause);
        }
      }
    }
    if (failure) throw failure;
    if (!result) throw new GpuFilterError('export-cancelled');
    return result;
  }

  function setDisplay(opts: GpuFilterDisplayOptions): void {
    if (opts.showOriginal !== undefined) displayOptions.showOriginal = opts.showOriginal;
    if (opts.previewBackground !== undefined) displayOptions.previewBackground = opts.previewBackground;
  }
  function cancelExport(): void { if (activeExport) activeExport.abort(); }
  function cancelPreview(): void { if (frame) cancelAnimationFrame(frame); frame = 0; pendingPreview?.resolve(false); pendingPreview = null; }
  function destroySource(): void { cancelPending(); generation += 1; destroy(source?.texture); destroyBundle(source?.preview); source = null; }
  function cancelPending(): void { cancelPreview(); cancelExport(); }

  function onLost(event: Event): void { event.preventDefault(); contextLost = true; generation += 1; cancelPending(); destroyCommands(); destroy(regl); regl = null; commands = null; options.onContextLost?.(); }
  function onRestored(): void {
    if (destroyed) return;
    try {
      generation += 1;
      if (source) {
        source.texture = null; source.preview = null;
      }
      initialize();
      contextLost = false;
      if (source) {
        let texture: createREGL.Texture2D | undefined; let preview: RenderBundle | undefined;
        const pw = source.previewWidth ?? source.width;
        const ph = source.previewHeight ?? source.height;
        try {
          texture = createSourceTexture(source.width, source.height, source.pixels);
          preview = createBundle(pw, ph, source.params, true);
          canvas.width = pw;
          canvas.height = ph;
        } catch (cause) {
          destroy(texture); destroyBundle(preview);
          throw cause;
        }
        source.texture = texture; source.preview = preview; source.previewWidth = pw; source.previewHeight = ph; renderNow(source.params);
      }
      options.onContextRestored?.();
    } catch (cause) {
      contextLost = true;
      options.onContextRestored?.(new GpuFilterError('context-restore-failed', cause instanceof Error ? cause.message : undefined));
    }
  }

  try { initialize(); } catch (cause) { throw error('webgl2-unavailable', cause); }
  canvas.addEventListener('webglcontextlost', onLost, false); canvas.addEventListener('webglcontextrestored', onRestored, false);
  return Object.freeze({ get capabilities() { return requireCapabilities(); }, setSource, replaceSource: setSource, requestPreview, renderPreview: requestPreview, resizePreview, exportRgba, cancelExport, destroySource, setDisplay, destroy(): void {
    if (destroyed) return; destroyed = true; generation += 1; cancelPending(); canvas.removeEventListener('webglcontextlost', onLost, false); canvas.removeEventListener('webglcontextrestored', onRestored, false); destroy(source?.texture); destroyBundle(source?.preview); source = null; destroyCommands(); destroy(regl); regl = null;
  } });
}
