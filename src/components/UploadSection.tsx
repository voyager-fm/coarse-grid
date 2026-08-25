import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { cn } from '@/lib/utils';

export interface UploadSectionProps {
  sourceMeta: string | null;
  isDragging: boolean;
  /** Monotonic counter; each increment plays the drop-target shake animation. */
  shakeKey: number;
  handleFiles: (files: FileList | null) => void;
  handleDragOver: (event: DragEvent) => void;
  handleDragEnter: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
  handleDrop: (event: DragEvent) => void;
}

/**
 * Source-image upload surface: one #drop-target dropzone button (click, drag,
 * keyboard) plus the hidden #file-input and the #source-meta line. Markup +
 * styling only — all upload/decode logic lives in useSourceImage.
 */
export default function UploadSection({
  sourceMeta,
  isDragging,
  shakeKey,
  handleFiles,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
}: UploadSectionProps) {
  const [shaking, setShaking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Play the drop-shake animation whenever useSourceImage triggers a shake.
  useEffect(() => {
    if (shakeKey === 0) return;
    setShaking(true);
    const timer = window.setTimeout(() => setShaking(false), 400);
    return () => window.clearTimeout(timer);
  }, [shakeKey]);

  return (
    <section aria-label="Upload a source image" className="grid gap-3">
      <button
        type="button"
        id="drop-target"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'grid cursor-pointer gap-2 rounded-md border border-dashed border-border bg-background p-4 text-left',
          'transition-colors hover:border-primary',
          'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          isDragging && 'border-primary bg-accent-soft',
          shaking && 'drop-target-shake',
        )}
      >
        <span className="text-sm font-semibold text-foreground">Source image</span>
        <span className="text-sm text-muted-foreground">
          PNG, JPEG, or WebP — up to 25 MiB. One file at a time.
        </span>
        <span className="justify-self-start rounded-sm border border-border bg-secondary px-3 py-1.5 text-sm font-medium shadow-xs">
          Select or drop an image
        </span>
      </button>

      <input
        ref={fileInputRef}
        id="file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <p id="source-meta" className="min-h-5 text-sm text-muted-foreground">
        {sourceMeta ?? ''}
      </p>
    </section>
  );
}
