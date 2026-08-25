import { useEffect, useRef, type RefObject } from 'react';

import { cn } from '@/lib/utils';

export interface PreviewStatus {
  /** Whether the GPU renderer has been initialized (todo 6). */
  initialized: boolean;
  /** A non-null value disables the workspace and shows the empty state. */
  error: string | null;
  /** Whether a source image has been loaded (todos 6-9). */
  hasSource: boolean;
  /** Whether the compare toggle currently shows the original image. */
  showingOriginal: boolean;
}

export const EMPTY_STATE_DEFAULT = 'Select or drop an image to begin.';

interface PreviewWorkspaceProps {
  /** The single canvas ref owned by App and shared with useRenderer (todo 6). */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Presentational status used to drive the empty state / disabled controls. */
  status: PreviewStatus;
  /** Controlled preview background hex (#RRGGBB); owned by App beside the renderer seam. */
  previewBackground: string;
  /** Toggle original/result comparison; App routes it through renderer.setDisplay + requestPreview. */
  onToggleCompare: () => void;
  /** Commit a new preview background hex; App routes it through renderer.setDisplay + requestPreview. */
  onPreviewBackgroundChange: (hex: string) => void;
}

/**
 * Preview workspace: owns markup + styling ONLY. The GPU lifecycle for the
 * same <canvas> lives in useRenderer (todo 6), which consumes the identical
 * canvasRef. Because both receive the same ref, React mount → effects →
 * renderer-initialization order cannot diverge. Display controls are pure
 * callbacks — App owns the display state and routes it through the renderer's
 * setDisplay seam, keeping it out of filter params/history.
 */
export default function PreviewWorkspace({
  canvasRef,
  status,
  previewBackground,
  onToggleCompare,
  onPreviewBackgroundChange,
}: PreviewWorkspaceProps) {
  const canPreview = status.initialized && status.hasSource;
  const backgroundRef = useRef<HTMLInputElement>(null);

  // Background commit: React 19's onChange on `<input type="color">` does not
  // fire on a programmatic `change` event, so commit via a NATIVE `change`
  // listener, matching the ControlRow color path.
  useEffect(() => {
    const input = backgroundRef.current;
    if (!input) return;
    const onCommit = () => onPreviewBackgroundChange(input.value);
    input.addEventListener('change', onCommit);
    return () => input.removeEventListener('change', onCommit);
  }, [onPreviewBackgroundChange]);

  return (
    <div id="workspace" className="min-w-0">
      <figure
        className={cn(
          'grid content-start gap-3 rounded-md border border-border bg-card p-5',
          'min-w-0',
        )}
      >
        <h2 className="text-lg font-bold text-foreground">Output preview</h2>

        <canvas
          id="preview-canvas"
          ref={canvasRef}
          aria-label="GPU-filtered image preview composited over an opaque background"
          className="block h-auto max-w-full w-full min-h-[15rem] border border-border bg-preview-surface"
        >
          This browser does not support the preview canvas.
        </canvas>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            id="compare-btn"
            disabled={!canPreview}
            onClick={onToggleCompare}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:border-input dark:bg-input/30 dark:hover:bg-input/50"
          >
            {status.showingOriginal ? 'Show result' : 'Show original'}
          </button>

          <label className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <span>Background</span>
            <input
              ref={backgroundRef}
              type="color"
              id="preview-background"
              value={previewBackground}
              disabled={!canPreview}
              className="h-11 min-h-11 w-11 cursor-pointer border border-border rounded p-1 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        </div>

        {(status.error !== null || !status.hasSource) && (
          <figcaption id="empty-state" className="text-sm text-muted-foreground">
            {status.error ?? EMPTY_STATE_DEFAULT}
          </figcaption>
        )}
      </figure>
    </div>
  );
}
