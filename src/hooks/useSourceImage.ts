import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { GpuFilterError, normalizeFilterParams, sanitizeStem } from '@voyager-fm/coarse-grid-core';

import type { PreviewStatus } from '@/components/PreviewWorkspace';
import { gpuErrorMessage, type RendererHandle } from '@/hooks/useRenderer';

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB
const MAX_INPUT_PIXELS = 16_000_000; // 16 MP
const MAX_INPUT_AXIS = 8192;

// Module-level canvas reused for orientation-correct decode + pixel extraction.
// (Canvas2D usage is allowed in the decode path; the GPU boundary rule forbids
// WebGL context acquisition here.)
const sourceCanvas = document.createElement('canvas');

/** Validates a file's size + MIME type. Returns an English message or '' when valid. */
export function validateFile(file: File): string {
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_FILE_BYTES) return 'The image exceeds 25 MiB.';
  if (!ACCEPTED_TYPES.has(file.type)) return 'Unsupported file type. Use a PNG, JPEG, or WebP file.';
  return '';
}

/**
 * Decodes an image file into an HTMLImageElement / ImageBitmap with EXIF
 * orientation applied (createImageBitmap with `imageOrientation: 'from-image'`,
 * falling back to an <img> element). Pixels are later extracted onto the shared
 * module-level `sourceCanvas`.
 */
async function decodeWithImageElement(file: File): Promise<{ image: HTMLImageElement | ImageBitmap; objectUrl?: string }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bitmap };
    } catch {
      // Fall through to <img> decode.
    }
  }
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.src = objectUrl;
  try {
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('image-decode-failed')); });
    return { image, objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

/** Decode result containing top-left RGBA8 pixels in a fresh buffer. */
interface DecodedPixels {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Extracts orientation-correct top-left RGBA8 pixels via the module-level sourceCanvas. */
function extractPixels(image: HTMLImageElement | ImageBitmap): DecodedPixels {
  const width = image.width;
  const height = image.height;
  if (width > MAX_INPUT_AXIS || height > MAX_INPUT_AXIS) throw new RangeError('axis');
  if (width * height > MAX_INPUT_PIXELS) throw new RangeError('pixels');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('image-decode-failed');
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return { width, height, pixels: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength) };
}

export interface UseSourceImageOptions {
  /** Renderer handle from useRenderer — supplies replaceSource / requestPreview / initialized. */
  renderer: RendererHandle;
  /** Push a partial PreviewStatus patch up into App. */
  onStatusChange: (patch: Partial<PreviewStatus>) => void;
}

export interface UseSourceImageResult {
  /** Human-readable English metadata for #source-meta (e.g. "name · 2×2 · 0 KiB"), or null. */
  sourceMeta: string | null;
  /** Decoded source width, or null before a successful upload. */
  sourceWidth: number | null;
  /** Decoded source height, or null before a successful upload. */
  sourceHeight: number | null;
  /** Whether a drag is currently over the drop target. */
  isDragging: boolean;
  /** Monotonic counter; UploadSection toggles the shake class when it changes. */
  shakeKey: number;
  /** Handles a FileList from #file-input change or a drop event. */
  handleFiles: (files: FileList | null) => void;
  handleDragOver: (event: DragEvent) => void;
  handleDragEnter: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
  handleDrop: (event: DragEvent) => void;
}

/**
 * Owns the source-image upload flow: validation (25 MiB / 16 MP / 8192-axis),
 * orientation-correct decode, decode-token cancellation, drag-and-drop on the
 * #drop-target, and pushing the decoded pixels into the renderer. The prior
 * source is retained when a new upload fails.
 */
export function useSourceImage({ renderer, onStatusChange }: UseSourceImageOptions): UseSourceImageResult {
  const [sourceMeta, setSourceMeta] = useState<string | null>(null);
  const [sourceWidth, setSourceWidth] = useState<number | null>(null);
  const [sourceHeight, setSourceHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const decodeTokenRef = useRef(0);
  const dragDepthRef = useRef(0);

  const triggerShake = useCallback(() => {
    setShakeKey((key) => key + 1);
  }, []);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      // Reject multiple files at once.
      if (files.length > 1) {
        const message = 'Only one image can be selected at a time.';
        onStatusChange({ error: message });
        triggerShake();
        return;
      }
      const file = files[0];
      const fileError = validateFile(file);
      if (fileError) {
        onStatusChange({ error: fileError });
        triggerShake();
        return;
      }
      if (!renderer.initialized) {
        const message = 'GPU processing is not available yet.';
        onStatusChange({ error: message });
        triggerShake();
        return;
      }
      const token = ++decodeTokenRef.current;
      const objectUrls: string[] = [];
      (async () => {
        let bitmap: ImageBitmap | null = null;
        try {
          const { image, objectUrl } = await decodeWithImageElement(file);
          if (objectUrl) objectUrls.push(objectUrl);
          if (image instanceof ImageBitmap) bitmap = image;
          if (token !== decodeTokenRef.current) return;
          const { width, height, pixels } = extractPixels(image);
          if (token !== decodeTokenRef.current) return;
          const params = normalizeFilterParams();
          renderer.replaceSource({ width, height, pixels, params, exportScale: 100 });
          if (token !== decodeTokenRef.current) return;
          const stem = sanitizeStem(file.name);
          setSourceMeta(`${file.name} · ${width}×${height} · ${Math.ceil(file.size / 1024)} KiB`);
          setSourceWidth(width);
          setSourceHeight(height);
          void renderer.requestPreview(params, { immediate: true });
          onStatusChange({ hasSource: true, error: null });
          void stem;
        } catch (error) {
          if (token !== decodeTokenRef.current) return;
          let message: string;
          if (error instanceof RangeError) {
            message = error.message === 'axis' ? 'One side of the image exceeds 8192 px.' : 'The image exceeds 16 million pixels.';
          } else if (error instanceof GpuFilterError) {
            message = gpuErrorMessage(error);
          } else {
            message = 'Could not read the image. It may be corrupt or an unsupported format.';
          }
          // Retain the prior source — only the error message changes.
          onStatusChange({ error: message });
          triggerShake();
        } finally {
          bitmap?.close();
          for (const url of objectUrls) URL.revokeObjectURL(url);
          sourceCanvas.width = sourceCanvas.height = 0;
        }
      })();
    },
    [renderer, onStatusChange, triggerShake],
  );

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
  }, []);

  const handleDragEnter = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);
      handleFiles(event.dataTransfer.files);
    },
    [handleFiles],
  );

  return {
    sourceMeta,
    sourceWidth,
    sourceHeight,
    isDragging,
    shakeKey,
    handleFiles,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
  };
}
