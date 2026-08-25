import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import {
  createRasterFilter,
  GpuFilterError,
  getExportFilename,
  normalizeFilterParams,
} from '@voyager-labs/coarse-grid-core';

import type { PreviewStatus } from '@/components/PreviewWorkspace';
import type { RendererCallbacks } from '@/App';

/** Copied from script.js:141-146 — converts a #RRGGBB string to a 0..1 RGB array for setDisplay. */
export function hexToSrgbArray(hex: string): number[] {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

/**
 * English translations of the GPU renderer error codes (translated from the
 * Korean `GPU_MESSAGES` map in script.js:66-77). Used to surface renderer
 * failures as React state consumed by the shell / controls.
 */
export const GPU_MESSAGES: Record<string, string> = {
  'webgl2-unavailable': 'WebGL2 is unavailable. GPU processing cannot start in this browser.',
  'float-color-buffer-unavailable': 'This browser does not support EXT_color_buffer_float, required for GPU processing.',
  'float-framebuffer-incomplete': 'Could not initialize a floating-point framebuffer. Update your graphics driver and retry.',
  'gpu-size-limit': "This image size exceeds this browser's GPU rendering limits. Use a smaller image or lower export scale.",
  'framebuffer-incomplete': 'Could not create a GPU rendering buffer. Try another image.',
  'allocation-failed': 'Could not allocate GPU memory. Use a smaller image or lower export scale.',
  'context-lost': 'The GPU context was lost. GPU processing is unavailable until it recovers.',
  'context-restore-failed': 'Could not restore the GPU context. Reload the page and retry.',
  'renderer-destroyed': 'GPU processing ended because you left the page.',
  'export-cancelled': 'PNG export was cancelled.',
};

const GPU_FALLBACK_MESSAGE = 'A GPU processing error occurred. Try another image or settings.';

/** Maps a thrown value to a user-facing English message using its GpuFilterError.code. */
export function gpuErrorMessage(error: unknown): string {
  if (error instanceof GpuFilterError) {
    return GPU_MESSAGES[error.code] ?? GPU_FALLBACK_MESSAGE;
  }
  return GPU_FALLBACK_MESSAGE;
}

/** Input to the renderer's transactional source replacement. */
export interface SourcePixels {
  width: number;
  height: number;
  pixels: Uint8Array;
  params?: Record<string, unknown>;
  exportScale?: number;
}

/** Opaque GPU renderer capabilities (webgl limits, intersected extents). */
export interface RendererCapabilities {
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDims: number[];
  width: number;
  height: number;
}

/** Stable, renderer-backed API exposed to the rest of the app (source image + controls). */
export interface RendererHandle {
  /** Whether the GPU renderer initialized successfully (webgl2 + EXT_color_buffer_float). */
  initialized: boolean;
  /** Current GPU error message, or null when the renderer is healthy. */
  error: string | null;
  /** True while a single-flight PNG export is in progress (mirrors script.js `state.exportBusy`). */
  exportBusy: boolean;
  capabilities: RendererCapabilities | null;
  replaceSource: (input: SourcePixels) => { width: number; height: number };
  requestPreview: (params?: Record<string, unknown>, opts?: { immediate?: boolean }) => Promise<boolean>;
  setDisplay: (opts: { showOriginal?: boolean; previewBackground?: number[] }) => void;
  resizePreview: (targetWidth: number, targetHeight: number, params?: Record<string, unknown>) => boolean;
  exportRgba: (input: { width: number; height: number; params?: Record<string, unknown>; signal?: AbortSignal }) => Promise<{ width: number; height: number; pixels: Uint8Array }>;
  cancelExport: () => void;
  destroySource: () => void;
  /** Single-flight PNG export (snapshots pixels + params at start). */
  exportPng: (opts?: { scale?: number; previewBackground?: string }) => void;
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png-encoding-failed'))), 'image/png');
    } catch {
      reject(new Error('png-encoding-failed'));
    }
  });
}

/**
 * Owns the GPU renderer lifecycle on the seam's single #preview-canvas ref.
 *
 * - Creates the GPU renderer once on mount (webgl2 + EXT_color_buffer_float init).
 * - Surfaces `initialized` / GPU `error` into React via `callbacks.onStatusChange`.
 * - Handles webglcontextlost / webglcontextrestored lifecycle.
 * - Exposes the renderer API + a single-flight export (script.js:578-615).
 * - Destroys the renderer on unmount.
 *
 * @param canvasRef The single canvasRef owned by App (shared with PreviewWorkspace).
 * @param callbacks The single RendererCallbacks object owned by App.
 */
export function useRenderer(canvasRef: RefObject<HTMLCanvasElement | null>, callbacks: RendererCallbacks): RendererHandle {
  const rendererRef = useRef<ReturnType<typeof createRasterFilter> | null>(null);
  const paramsRef = useRef<Record<string, unknown>>(normalizeFilterParams());
  const originalStemRef = useRef<string>('image');
  const exportScaleRef = useRef<number>(100);
  const exportBusyRef = useRef<boolean>(false);
  const sourceDimsRef = useRef<{ width: number; height: number } | null>(null);

  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  const report = useCallback(
    (patch: Partial<PreviewStatus>) => {
      callbacks.onStatusChange(patch);
    },
    [callbacks.onStatusChange],
  );

  const setDisplay = useCallback((opts: { showOriginal?: boolean; previewBackground?: number[] }) => {
    rendererRef.current?.setDisplay(opts);
  }, []);

  const requestPreview = useCallback(
    (params?: Record<string, unknown>, opts?: { immediate?: boolean }) => {
      const renderer = rendererRef.current;
      if (!renderer) return Promise.resolve(false);
      const normalized = normalizeFilterParams(params ?? paramsRef.current);
      // Always keep the renderer params in sync so a later export reflects the
      // latest edits, even one made while a previous export is in flight.
      paramsRef.current = normalized;
      // Suppress the actual preview render during an in-flight export (mirrors
      // script.js:659 `!state.exportBusy`), so a mid-export edit cannot enqueue
      // a competing rAF that would unbalance a held-export determinism test.
      if (exportBusyRef.current) return Promise.resolve(false);
      return renderer.requestPreview(normalized, opts);
    },
    [],
  );

  const replaceSource = useCallback(
    (input: SourcePixels) => {
      const renderer = rendererRef.current;
      if (!renderer) throw new GpuFilterError('webgl2-unavailable');
      const normalized = normalizeFilterParams(input.params ?? paramsRef.current);
      paramsRef.current = normalized;
      if (input.exportScale !== undefined) exportScaleRef.current = Number(input.exportScale);
      const result = renderer.replaceSource({ ...input, params: normalized });
      sourceDimsRef.current = { width: input.width, height: input.height };
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = result.width;
        canvas.height = result.height;
      }
      setError(null);
      report({ hasSource: true, error: null });
      return result;
    },
    [canvasRef, report],
  );

  const exportPng = useCallback(
    (opts?: { scale?: number; previewBackground?: string }) => {
      const renderer = rendererRef.current;
      const canvas = canvasRef.current;
      if (!renderer || !canvas) return;
      const exportScale = Number(opts?.scale ?? exportScaleRef.current);
      const params = normalizeFilterParams(paramsRef.current);
      const filename = getExportFilename(originalStemRef.current, exportScale);
      // Single-flight guard: only one export at a time.
      if (exportBusyRef.current) return;
      exportBusyRef.current = true;
      setExportBusy(true);
      const bg = opts?.previewBackground ?? '#FFFFFF';
      setDisplay({ previewBackground: hexToSrgbArray(bg) });
      let outputCanvas: HTMLCanvasElement | undefined;
      let blobUrl: string | undefined;
      let anchor: HTMLAnchorElement | undefined;
      const controller = new AbortController();
      (async () => {
        try {
          // Snapshot source dimensions + params at the start (script.js:587) so the
          // export is isolated from any UI changes in flight.
          const src = sourceDimsRef.current;
          const w = src?.width ?? canvas.width;
          const h = src?.height ?? canvas.height;
          const width = Math.max(1, Math.round((w * exportScale) / 100));
          const height = Math.max(1, Math.round((h * exportScale) / 100));
          const result = await renderer.exportRgba({ width, height, params, signal: controller.signal });
          outputCanvas = document.createElement('canvas');
          outputCanvas.width = result.width;
          outputCanvas.height = result.height;
          const pixels = new Uint8ClampedArray(result.pixels);
          outputCanvas.getContext('2d', { willReadFrequently: true })?.putImageData(new ImageData(pixels, result.width, result.height), 0, 0);
          const blob = await toPngBlob(outputCanvas);
          blobUrl = URL.createObjectURL(blob);
          anchor = document.createElement('a');
          anchor.href = blobUrl;
          anchor.download = filename;
          document.body.append(anchor);
          anchor.click();
          setError(null);
          report({ error: null });
          callbacks.onExportComplete?.(filename);
        } catch (err) {
          if (err instanceof Error && err.message === 'png-encoding-failed') {
            const message = 'Could not create the PNG. Check your browser memory and try a lower scale.';
            setError(message);
            report({ error: message });
          } else if (!(err instanceof GpuFilterError && err.code === 'export-cancelled')) {
            const message = gpuErrorMessage(err);
            setError(message);
            report({ error: message });
          }
        } finally {
          if (anchor) anchor.remove();
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          if (outputCanvas) outputCanvas.width = outputCanvas.height = 0;
          exportBusyRef.current = false;
          setExportBusy(false);
        }
      })();
    },
    [canvasRef, report, setDisplay],
  );

  // Create the renderer once on mount; destroy on unmount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      const message = 'Preview canvas is not available.';
      setInitialized(false);
      setError(message);
      report({ initialized: false, error: message });
      return;
    }
    let renderer: ReturnType<typeof createRasterFilter> | null = null;
    try {
      renderer = createRasterFilter({
        canvas,
        onContextLost: () => {
          setInitialized(false);
          setError(GPU_MESSAGES['context-lost']);
          report({ initialized: false, error: GPU_MESSAGES['context-lost'] });
        },
        onContextRestored: (restoreError) => {
          if (restoreError) {
            const message = gpuErrorMessage(restoreError);
            setInitialized(false);
            setError(message);
            report({ initialized: false, error: message });
            return;
          }
          setInitialized(true);
          setError(null);
          report({ initialized: true, error: null });
          if (rendererRef.current) {
            void requestPreview(undefined, { immediate: true });
          }
        },
      });
      rendererRef.current = renderer;
      setInitialized(true);
      setError(null);
      report({ initialized: true, error: null });
    } catch (err) {
      const message = gpuErrorMessage(err);
      setInitialized(false);
      setError(message);
      report({ initialized: false, error: message });
    }
    const teardown = () => {
      renderer?.destroy();
      rendererRef.current = null;
    };
    // Release GPU resources when the page is hidden/closed (mirrors script.js:807-815),
    // so WebGL textures, framebuffers, and buffers are deleted on pagehide teardown.
    window.addEventListener('pagehide', teardown, { once: true });
    return () => {
      window.removeEventListener('pagehide', teardown);
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, report]);

  return useMemo<RendererHandle>(
    () => ({
      initialized,
      error,
      exportBusy,
      capabilities: rendererRef.current?.capabilities ?? null,
      replaceSource,
      requestPreview,
      setDisplay,
      resizePreview: (targetWidth, targetHeight, params) => rendererRef.current?.resizePreview(targetWidth, targetHeight, normalizeFilterParams(params ?? paramsRef.current)) ?? false,
      exportRgba: (input) => {
        const renderer = rendererRef.current;
        if (!renderer) return Promise.reject(new GpuFilterError('renderer-destroyed'));
        return renderer.exportRgba({ ...input, params: normalizeFilterParams(input.params ?? paramsRef.current) });
      },
      cancelExport: () => rendererRef.current?.cancelExport(),
      destroySource: () => rendererRef.current?.destroySource(),
      exportPng,
    }),
    [initialized, error, exportBusy, replaceSource, requestPreview, setDisplay, exportPng],
  );
}
