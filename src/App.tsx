import { useCallback, useEffect, useRef, useState } from 'react';

import AppShell, { applyThemeClass, readStoredTheme, writeStoredTheme, type Theme } from '@/components/AppShell';
import ControlsPanel from '@/components/ControlsPanel';
import ExportPanel from '@/components/ExportPanel';
import PresetsPanel from '@/components/PresetsPanel';
import PreviewWorkspace, { type PreviewStatus } from '@/components/PreviewWorkspace';
import StatusSurface, { type StatusSurfaceHandle } from '@/components/StatusSurface';
import UploadSection from '@/components/UploadSection';
import { useFilterEditor } from '@/hooks/useFilterEditor';
import { GPU_MESSAGES, hexToSrgbArray, useRenderer } from '@/hooks/useRenderer';
import { useSourceImage } from '@/hooks/useSourceImage';

/**
 * ===== SEAM CONTRACT (todos 6-9) =====
 *
 * App owns EXACTLY ONE canvasRef and ONE status/callbacks object. They are the
 * single shared seam the renderer (useRenderer) and the UI consume:
 *
 *  - `canvasRef` is passed INTO PreviewWorkspace as a prop (it renders
 *    `<canvas id="preview-canvas" ref={canvasRef}>`) AND into
 *    `useRenderer(canvasRef, callbacks)`. Both operate on the SAME element, so
 *    React mount → effects → renderer-initialization cannot diverge.
 *
 *  - `callbacks` is the object useRenderer receives to push state up into
 *    React (`onStatusChange`) and to report a finished PNG export
 *    (`onExportComplete`). Todos 6-9 call these to drive the UI.
 *
 *  - `status` is React state mirroring the renderer lifecycle for the UI only.
 */
export interface RendererCallbacks {
  /** Push a (possibly partial) status snapshot from the renderer / workspace into React. */
  onStatusChange: (status: Partial<PreviewStatus>) => void;
  /** Report a successfully exported PNG so the status surface can show its filename. */
  onExportComplete?: (filename: string) => void;
}

const INITIAL_STATUS: PreviewStatus = {
  initialized: false,
  error: null,
  hasSource: false,
  showingOriginal: false,
};

export default function App() {
  // Single canvas ref — the seam shared with PreviewWorkspace and useRenderer.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<StatusSurfaceHandle>(null);

  const [status, setStatus] = useState<PreviewStatus>(INITIAL_STATUS);
  const [previewBackground, setPreviewBackground] = useState('#FFFFFF');
  const [theme, setTheme] = useState<Theme>(() => {
    const t = readStoredTheme();
    applyThemeClass(t);
    return t;
  });

  const callbacks: RendererCallbacks = {
    onStatusChange: useCallback((next: Partial<PreviewStatus>) => {
      setStatus((prev) => ({ ...prev, ...next }));
    }, []),
    onExportComplete: useCallback((filename: string) => {
      statusRef.current?.showStatus(`${filename} exported.`);
    }, []),
  };

  // The renderer owns the GPU lifecycle on the seam's single canvasRef.
  const renderer = useRenderer(canvasRef, callbacks);

  // The source-image hook feeds decoded pixels into the renderer and updates status.
  const source = useSourceImage({ renderer, onStatusChange: callbacks.onStatusChange });

  // Filter editor state (todo 7). Pushes edited params into the renderer.
  const editor = useFilterEditor({
    onPreview: (params) => {
      void renderer.requestPreview(params);
    },
  });
  const { resetBaseline } = editor;

  // A new successful source upload resets the filter history to a fresh
  // baseline (wires useSourceImage success → useFilterEditor.resetBaseline).
  const prevHasSourceRef = useRef(status.hasSource);
  useEffect(() => {
    if (status.hasSource && !prevHasSourceRef.current) {
      resetBaseline();
    }
    prevHasSourceRef.current = status.hasSource;
  }, [status.hasSource, resetBaseline]);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      applyThemeClass(next);
      writeStoredTheme(next);
      return next;
    });
  };

  // Wire the export button: show busy status, then hand off to the single-flight
  // renderer export. Completion surfaces via StatusSurface/toast (onExportComplete).
  const handleExport = (scale: number) => {
    statusRef.current?.showStatus('Creating PNG on the GPU…');
    renderer.exportPng({ scale, previewBackground });
  };

  const handleToggleCompare = useCallback(() => {
    const showingOriginal = !status.showingOriginal;
    callbacks.onStatusChange({ showingOriginal });
    renderer.setDisplay({ showOriginal: showingOriginal });
    void renderer.requestPreview();
  }, [callbacks.onStatusChange, renderer, status.showingOriginal]);

  const handlePreviewBackgroundChange = useCallback(
    (hex: string) => {
      setPreviewBackground(hex);
      renderer.setDisplay({ previewBackground: hexToSrgbArray(hex) });
      void renderer.requestPreview();
    },
    [renderer],
  );

  // Master control-disable flag, mirroring setControlsEnabled (script.js:427-444):
  // controls are disabled without a source, during an export, or while the GPU
  // context is lost.
  const contextLost = status.error === GPU_MESSAGES['context-lost'];
  const controlsDisabled = !status.hasSource || renderer.exportBusy || contextLost;

  const sourceDims = status.hasSource && source.sourceWidth !== null && source.sourceHeight !== null
    ? { width: source.sourceWidth, height: source.sourceHeight }
    : null;

  return (
    <AppShell theme={theme} onToggleTheme={toggleTheme}>
      <div className="grid gap-6 md:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)] md:items-start">
        <aside
          id="controls"
          className="grid min-w-0 gap-4 md:sticky md:top-4 md:max-h-[calc(100vh-2rem)] md:overflow-y-auto md:overscroll-contain"
        >
          <PresetsPanel editor={editor} disabled={controlsDisabled} />
          <ControlsPanel editor={editor} disabled={controlsDisabled} />
          <StatusSurface ref={statusRef} error={status.error} />
        </aside>

        <div className="grid min-w-0 content-start gap-6">
          <UploadSection
            sourceMeta={source.sourceMeta}
            isDragging={source.isDragging}
            shakeKey={source.shakeKey}
            handleFiles={source.handleFiles}
            handleDragOver={source.handleDragOver}
            handleDragEnter={source.handleDragEnter}
            handleDragLeave={source.handleDragLeave}
            handleDrop={source.handleDrop}
          />
          <PreviewWorkspace
            canvasRef={canvasRef}
            status={status}
            previewBackground={previewBackground}
            onToggleCompare={handleToggleCompare}
            onPreviewBackgroundChange={handlePreviewBackgroundChange}
          />
          <ExportPanel
            sourceDims={sourceDims}
            capabilities={renderer.capabilities}
            blockPercent={Number(editor.params.blockPercent)}
            disabled={controlsDisabled}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onExport={handleExport}
            onUndo={editor.undo}
            onRedo={editor.redo}
            onReset={editor.resetControls}
          />
        </div>
      </div>
    </AppShell>
  );
}
