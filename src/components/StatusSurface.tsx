import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface StatusSurfaceHandle {
  /** Set the persistent `#status` text (and optional `error` kind). */
  showStatus: (message: string, kind?: '' | 'error') => void;
  /** Show a transient `#toast` (role=alert) that auto-hides after 4s. */
  showToast: (message: string) => void;
}

interface StatusSurfaceProps {
  /** Current GPU error (already translated via useRenderer GPU_MESSAGES), or null. A transition to non-null shows the toast. */
  error: string | null;
}

const TOAST_MS = 4000;

/**
 * Status surface: a persistent `#status` (role=status, aria-live=polite) plus a
 * transient `#toast` (role=alert). GPU errors (from the `error` prop) and export
 * completion (via the exposed ref handle) surface English messages here,
 * mirroring script.js setStatus/showToast.
 */
const StatusSurface = forwardRef<StatusSurfaceHandle, StatusSurfaceProps>(function StatusSurface({ error }, ref) {
  const [statusText, setStatusText] = useState('');
  const [statusKind, setStatusKind] = useState<'' | 'error'>('');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const prevError = useRef<string | null>(error);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  };

  const showStatus = (message: string, kind: '' | 'error' = '') => {
    setStatusText(message);
    setStatusKind(kind);
  };

  useImperativeHandle(ref, () => ({ showStatus, showToast }));

  // GPU error transition → toast (role=alert), mirroring showGpuError + showToast.
  // A recovery (error clears, e.g. context restored) clears the persistent status.
  useEffect(() => {
    if (error && error !== prevError.current) {
      showToast(error);
      setStatusText(error);
      setStatusKind('error');
    } else if (!error && prevError.current) {
      setStatusText('');
      setStatusKind('');
    }
    prevError.current = error;
  }, [error]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  return (
    <div className="status-surface space-y-2">
      <div
        id="status"
        role="status"
        aria-live="polite"
        data-status={statusKind || undefined}
        className="text-sm text-foreground"
      >
        {statusText}
      </div>
      <div id="toast" role="alert" className="text-sm text-destructive" hidden={!toast}>
        {toast ?? ''}
      </div>
    </div>
  );
});

export default StatusSurface;
