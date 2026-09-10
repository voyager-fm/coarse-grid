import { useState, type KeyboardEvent } from 'react';

import { CONTROL_DEFINITIONS } from '@voyager-fm/coarse-grid-core';

import ControlRow from '@/components/ControlRow';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { UseFilterEditorResult } from '@/hooks/useFilterEditor';
import { CONTROL_COPY, GROUP_LABELS, type ControlGroup } from '@/lib/control-copy';

const GROUPS: ControlGroup[] = ['block', 'bloom', 'ribs', 'fringe'];

/**
 * The 15 Ribs controls split into two nested tab sections; every Ribs key is
 * assigned exactly once (5 geometry + 10 response), so the group's reset
 * button and `resetGroup` key-set derivation stay untouched.
 */
interface RibsSection {
  readonly id: string;
  readonly label: string;
  readonly keys: readonly string[];
}

const RIBS_SECTIONS: readonly RibsSection[] = [
  {
    id: 'geometry',
    label: 'Geometry',
    keys: ['ribAngle', 'ribPitch', 'ribLowLuminanceWidth', 'ribHighLuminanceWidth', 'ribEdgeSoftness'],
  },
  {
    id: 'response',
    label: 'Response',
    keys: [
      'ribLowLuminanceDarkness',
      'ribHighLuminanceDarkness',
      'ribLowLuminanceValueScale',
      'ribHighLuminanceValueScale',
      'ribLowLuminanceSaturationScale',
      'ribHighLuminanceSaturationScale',
      'luminanceLow',
      'luminanceHigh',
      'luminanceGamma',
      'ribsEnabled',
    ],
  },
];

/** Tab ids feed the deterministic `filter-tab-<id>` / `filter-panel-<id>` DOM ids. */
const RIBS_SECTION_IDS = RIBS_SECTIONS.map((section) => `ribs-${section.id}`);

const tabClassName = (active: boolean) =>
  `min-h-[var(--target-size)] rounded-md px-1 py-2 text-sm font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
    active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground'
  }`;

/** ArrowLeft/ArrowRight move the selection between tabs (wrapping), following the automatic-activation tabs pattern: focus follows the selection. */
function handleTablistKeyDown<T extends string>(ids: readonly T[], activeId: T, select: (next: T) => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = ids[(ids.indexOf(activeId) + offset + ids.length) % ids.length];
    select(next);
    document.getElementById(`filter-tab-${next}`)?.focus();
  };
}

interface ControlsPanelProps {
  /** The todo-7 filter-editor state that drives the controlled inputs. */
  editor: UseFilterEditorResult;
  /**
   * Master disable flag (computed by App/Harness as `!hasSource || exportBusy ||
   * contextLost` — mirrors setControlsEnabled in script.js:427-444). Applied to
   * every control input and every group-reset button.
   */
  disabled: boolean;
}

/**
 * Renders all 36 CONTROL_DEFINITIONS grouped into four `fieldset.filter-group`
 * fieldsets (Block / Bloom / Ribs / Fringe), each with an English `.group-reset`
 * button. Every definition renders one native input via ControlRow; the help
 * buttons stay enabled regardless of `disabled`.
 *
 * The four fieldsets sit behind a segmented top-level tab row (WAI-ARIA tabs,
 * ids `filter-tab-<group>` / `filter-panel-<group>`); the Ribs fieldset nests a
 * second tab row (`filter-tab-ribs-<section>` / `filter-panel-ribs-<section>`)
 * splitting its 15 controls into Geometry and Response. Every group and section
 * stays MOUNTED at all times and inactive ones are hidden only visually via the
 * HTML `hidden` attribute, so tests can keep driving their inputs via evaluate
 * dispatches and value assertions. Tab selection is local view state — resets
 * and preset application never change it.
 */
export default function ControlsPanel({ editor, disabled }: ControlsPanelProps) {
  const [activeGroup, setActiveGroup] = useState<ControlGroup>('block');
  const [activeRibsSection, setActiveRibsSection] = useState(RIBS_SECTION_IDS[0]);

  const renderRows = (belongs: (key: string) => boolean) =>
    CONTROL_DEFINITIONS.filter((definition) => belongs(definition.key)).map((definition) => {
      const [, label, help] = CONTROL_COPY[definition.key];
      return (
        <ControlRow
          key={definition.key}
          definition={definition}
          label={label}
          help={help}
          value={editor.params[definition.key]}
          disabled={disabled}
          onPreview={editor.previewEdit}
          onApply={editor.applyEdit}
        />
      );
    });

  return (
    <TooltipProvider>
      <div
        role="tablist"
        aria-label="Filter control groups"
        className="grid grid-cols-4 gap-1"
        onKeyDown={handleTablistKeyDown(GROUPS, activeGroup, setActiveGroup)}
      >
        {GROUPS.map((group) => (
          <button
            key={group}
            id={`filter-tab-${group}`}
            type="button"
            role="tab"
            aria-selected={group === activeGroup}
            aria-controls={`filter-panel-${group}`}
            tabIndex={group === activeGroup ? 0 : -1}
            onClick={() => setActiveGroup(group)}
            className={tabClassName(group === activeGroup)}
          >
            {GROUP_LABELS[group]}
          </button>
        ))}
      </div>
      {GROUPS.map((group) => (
        <fieldset
          key={group}
          id={`filter-panel-${group}`}
          role="tabpanel"
          aria-labelledby={`filter-tab-${group}`}
          hidden={group !== activeGroup}
          className="filter-group rounded-md border border-border p-4"
        >
          <legend className="px-2 text-sm font-semibold text-foreground">{GROUP_LABELS[group]}</legend>
          <div className="filter-group__body space-y-3">
            {group === 'ribs' ? (
              <>
                <div
                  role="tablist"
                  aria-label="Rib control sections"
                  className="grid grid-cols-2 gap-1"
                  onKeyDown={handleTablistKeyDown(RIBS_SECTION_IDS, activeRibsSection, setActiveRibsSection)}
                >
                  {RIBS_SECTIONS.map((section) => (
                    <button
                      key={section.id}
                      id={`filter-tab-ribs-${section.id}`}
                      type="button"
                      role="tab"
                      aria-selected={`ribs-${section.id}` === activeRibsSection}
                      aria-controls={`filter-panel-ribs-${section.id}`}
                      tabIndex={`ribs-${section.id}` === activeRibsSection ? 0 : -1}
                      onClick={() => setActiveRibsSection(`ribs-${section.id}`)}
                      className={tabClassName(`ribs-${section.id}` === activeRibsSection)}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>
                {RIBS_SECTIONS.map((section) => (
                  <div
                    key={section.id}
                    id={`filter-panel-ribs-${section.id}`}
                    role="tabpanel"
                    aria-labelledby={`filter-tab-ribs-${section.id}`}
                    hidden={`ribs-${section.id}` !== activeRibsSection}
                    className="space-y-3"
                  >
                    {renderRows((key) => section.keys.includes(key))}
                  </div>
                ))}
              </>
            ) : (
              renderRows((key) => CONTROL_COPY[key][0] === group)
            )}
            <button
              type="button"
              className="group-reset w-full rounded-sm border border-border bg-secondary px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => editor.resetGroup(group)}
              disabled={disabled}
            >
              Reset
            </button>
          </div>
        </fieldset>
      ))}
    </TooltipProvider>
  );
}
