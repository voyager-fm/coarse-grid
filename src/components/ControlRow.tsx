import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { ControlDefinition, RangeControlDefinition } from '@voyager-fm/coarse-grid-core';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ControlRowProps {
  definition: ControlDefinition;
  label: string;
  help: string;
  value: unknown;
  disabled: boolean;
  onPreview: (key: string, value: unknown) => void;
  onApply: (key: string, value: unknown) => void;
}

/**
 * Help affordance next to every control. A real button (44px target) whose
 * `aria-controls` points at the tooltip content's explicit `id` (`help-<key>`),
 * so a test can focus it and assert `#${aria-controls}` becomes visible.
 *
 * Radix Tooltip does not open on focus by default, and when opened via a
 * programmatic `.focus()` it mounts then immediately closes itself. So `open`
 * is fully controlled here: Radix's `onOpenChange` is a no-op (content follows
 * the `open` prop only), and ALL open/close is driven by native listeners on a
 * wrapper ref (the button lives inside it, so `focusin`/`focusout` bubble up):
 * focus/hover open, blur/leave close, click pins open, Escape / outside click
 * close — replicating script.js:365-394. The help button stays enabled even
 * when the control is disabled.
 */
function HelpTooltip({ label, tooltipId, help }: { label: string; tooltipId: string; help: string }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const pinnedRef = useRef(false);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const isTarget = (event: Event) => wrapper.contains(event.target as Node);
    const openTooltip = () => setOpen(true);
    const closeIfNotPinned = () => {
      if (!pinnedRef.current) setOpen(false);
    };
    const handleClick = (event: Event) => {
      if (!isTarget(event)) return;
      if (pinnedRef.current) {
        pinnedRef.current = false;
        setOpen(false);
      } else {
        pinnedRef.current = true;
        setOpen(true);
      }
    };
    const handlePointerLeave = (event: PointerEvent) => {
      if (!event.relatedTarget || !wrapper.contains(event.relatedTarget as Node)) closeIfNotPinned();
    };
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (wrapper.contains(event.target as Node)) return;
      if ((event.target as Element).closest?.('[data-slot="tooltip-content"]')) return;
      pinnedRef.current = false;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        pinnedRef.current = false;
        setOpen(false);
      }
    };
    wrapper.addEventListener('focusin', openTooltip);
    wrapper.addEventListener('focusout', closeIfNotPinned);
    wrapper.addEventListener('pointerenter', openTooltip);
    wrapper.addEventListener('pointerleave', handlePointerLeave);
    wrapper.addEventListener('click', handleClick);
    document.addEventListener('pointerdown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      wrapper.removeEventListener('focusin', openTooltip);
      wrapper.removeEventListener('focusout', closeIfNotPinned);
      wrapper.removeEventListener('pointerenter', openTooltip);
      wrapper.removeEventListener('pointerleave', handlePointerLeave);
      wrapper.removeEventListener('click', handleClick);
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <span ref={wrapperRef} className="inline-flex">
      <Tooltip open={open} onOpenChange={() => {}}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${label} help`}
            aria-controls={tooltipId}
            className="grid size-[var(--target-size)] shrink-0 place-items-center rounded-sm text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            ?
          </button>
        </TooltipTrigger>
        <TooltipContent id={tooltipId} side="top" align="start" className="max-w-[16rem]">
          {help}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

/** Decimal places implied by a positive step (1 -> 0, 0.25 -> 2, 0.0001 -> 4). */
function stepDecimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

const STEPPER_CLASS =
  'grid h-7 w-8 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-lg font-medium leading-none text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

const NUMBER_INPUT_CLASS =
  'h-7 w-full rounded-sm border border-border bg-background px-2 text-center text-sm tabular-nums text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

interface RangeFieldProps {
  definition: RangeControlDefinition;
  label: string;
  help: string;
  value: number;
  disabled: boolean;
  onPreview: (key: string, value: unknown) => void;
  onApply: (key: string, value: unknown) => void;
}

/**
 * One range row: the native slider keeps its exact gesture semantics (React
 * `onInput` -> live previewEdit, native `change` -> commit-once applyEdit) and
 * gains an adjacent numeric entry plus decrement/increment steppers. Typed
 * text stays transient until Enter/blur commits it once through the
 * normalizing editor; invalid or incomplete text reverts without touching
 * history. A stepper click nudges by exactly one definition step and commits
 * once; at either range end the nudge is a no-op so no redundant history
 * entry is created.
 */
function RangeField({ definition, label, help, value, disabled, onPreview, onApply }: RangeFieldProps) {
  const id = `control-${definition.key}`;
  const inputRef = useRef<HTMLInputElement>(null);
  // Transient numeric-entry text; null renders the normalized committed value.
  const [draft, setDraft] = useState<string | null>(null);
  const committedText = String(Number(value));

  // Range drag-end commit: wire the native `change` event (the only reliable
  // drag-end signal) through a ref listener, matching the EditorProbe pattern.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onCommit = () => onApply(definition.key, input.value);
    input.addEventListener('change', onCommit);
    return () => input.removeEventListener('change', onCommit);
  }, [definition.key, onApply]);

  const handleRangeInput = (event: FormEvent<HTMLInputElement>) => {
    onPreview(definition.key, event.currentTarget.value);
  };

  const commitDraft = () => {
    if (draft === null) return;
    setDraft(null);
    const text = draft.trim();
    if (text === '' || !Number.isFinite(Number(text))) return;
    onApply(definition.key, text);
  };

  const handleNumberKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Escape') {
      setDraft(null);
    }
  };

  const nudge = (direction: 1 | -1) => {
    const decimals = stepDecimals(definition.step);
    const next = Number((Number(value) + direction * definition.step).toFixed(decimals));
    const clamped = Math.min(definition.max, Math.max(definition.min, next));
    if (clamped === Number(value)) return;
    onApply(definition.key, String(clamped));
  };

  return (
    <div className="range-control space-y-1">
      <div className="control-label-row flex min-h-[var(--target-size)] items-center gap-2">
        <label htmlFor={id} className="flex-1 text-sm text-foreground">
          {label}
        </label>
        <HelpTooltip label={label} tooltipId={`help-${definition.key}`} help={help} />
      </div>
      <input
        ref={inputRef}
        id={id}
        type="range"
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={Number(value)}
        disabled={disabled}
        onInput={handleRangeInput}
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          id={`${id}-decrement`}
          aria-label={`${label} decrement`}
          disabled={disabled}
          onClick={() => nudge(-1)}
          className={STEPPER_CLASS}
        >
          −
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            id={`${id}-number`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${label} value`}
            value={draft ?? committedText}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleNumberKeyDown}
            onBlur={commitDraft}
            className={`${NUMBER_INPUT_CLASS}${definition.unit !== '' ? ' pr-7' : ''}`}
          />
          {definition.unit !== '' && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-sm text-muted-foreground"
            >
              {definition.unit}
            </span>
          )}
        </div>
        <button
          type="button"
          id={`${id}-increment`}
          aria-label={`${label} increment`}
          disabled={disabled}
          onClick={() => nudge(1)}
          className={STEPPER_CLASS}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * One expert control row: a native `<input>` (`range`/`checkbox`/`color`) with a
 * `<label for>` and a help tooltip, driven by the filter-editor state. Ranges
 * render through RangeField (slider + numeric entry + steppers); checkboxes and
 * colors keep their existing change paths.
 */
export default function ControlRow({ definition, label, help, value, disabled, onPreview, onApply }: ControlRowProps) {
  const id = `control-${definition.key}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const isRange = definition.type === 'range';

  // Color commit: React 19's onChange on `<input type="color">` does not fire on
  // a programmatic `change` event, so commit via a NATIVE `change` listener (the
  // vanilla color path), matching how the range handles its drag-end commit.
  useEffect(() => {
    if (isRange || definition.type !== 'color') return;
    const input = inputRef.current;
    if (!input) return;
    const onCommit = () => onApply(definition.key, input.value);
    input.addEventListener('change', onCommit);
    return () => input.removeEventListener('change', onCommit);
  }, [isRange, definition.type, definition.key, onApply]);

  const handleToggleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onApply(definition.key, event.target.checked);
  };

  if (isRange) {
    return (
      <RangeField
        definition={definition}
        label={label}
        help={help}
        value={Number(value)}
        disabled={disabled}
        onPreview={onPreview}
        onApply={onApply}
      />
    );
  }

  if (definition.type === 'color') {
    return (
      <div className="form-control">
        <div className="control-label-row flex min-h-[var(--target-size)] items-center gap-2">
          <label htmlFor={id} className="flex-1 text-sm text-foreground">
            {label}
          </label>
          <HelpTooltip label={label} tooltipId={`help-${definition.key}`} help={help} />
        </div>
        <input
          ref={inputRef}
          id={id}
          type="color"
          value={String(value)}
          disabled={disabled}
          className="h-[var(--target-size)] w-[var(--target-size)] cursor-pointer disabled:cursor-not-allowed"
        />
      </div>
    );
  }

  // boolean toggle
  return (
    <div className="toggle-control flex min-h-[var(--target-size)] items-center gap-2">
      <input
        id={id}
        type="checkbox"
        checked={Boolean(value)}
        disabled={disabled}
        onChange={handleToggleChange}
        className="size-5 shrink-0 cursor-pointer accent-[var(--primary)] disabled:cursor-not-allowed"
      />
      <label htmlFor={id} className="flex-1 text-sm text-foreground">
        {label}
      </label>
      <HelpTooltip label={label} tooltipId={`help-${definition.key}`} help={help} />
    </div>
  );
}
