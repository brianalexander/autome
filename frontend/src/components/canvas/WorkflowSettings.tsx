/**
 * WorkflowSettings — sidebar panel for workflow actions and status.
 * Renders inside the left sidebar's "Settings" tab.
 * Version history has been moved to VersionsPanel (Versions tab).
 */
import { ProviderSelect } from '../ui/ProviderSelect';
import type { WorkflowDefinition } from '../../lib/api';

interface WorkflowSettingsProps {
  isNew: boolean;
  definition: WorkflowDefinition;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  onExport?: () => void;
  healthIndicator?: React.ReactNode;
}

export function WorkflowSettings({
  isNew,
  definition,
  onDefinitionChange,
  onExport,
  healthIndicator,
}: WorkflowSettingsProps) {
  const autoTestEnabled = !!(definition as unknown as { authoring?: { auto_test?: boolean } }).authoring?.auto_test;

  function toggleAutoTest() {
    const current = (definition as unknown as { authoring?: { auto_test?: boolean } }).authoring ?? {};
    onDefinitionChange?.({
      ...definition,
      authoring: { ...current, auto_test: !autoTestEnabled },
    } as WorkflowDefinition);
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Workflow status */}
      {!isNew && healthIndicator && (
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">
            Status
          </div>
          {healthIndicator}
        </div>
      )}

      {/* ACP Provider — workflow default */}
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">
          ACP Provider
        </div>
        <ProviderSelect
          value={definition.acpProvider}
          onChange={(val) =>
            onDefinitionChange?.({ ...definition, acpProvider: val })
          }
          emptyLabel="System default"
        />
        <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1.5">
          Default provider for all agent stages in this workflow. Individual stages can override
          this in their config panel.
        </p>
      </div>

      {/* AI Author settings */}
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">
          AI Author
        </div>
        <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
          <div>
            <div className="text-sm text-[var(--color-text-primary)]">Autonomous testing</div>
            <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">
              AI Author will automatically run test instances after making changes.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={autoTestEnabled}
            onClick={onDefinitionChange ? toggleAutoTest : undefined}
            disabled={!onDefinitionChange}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
              autoTestEnabled ? 'bg-blue-600' : 'bg-[var(--color-surface-tertiary)]'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                autoTestEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </label>
      </div>

      {/* Actions */}
      {!isNew && onExport && (
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">
            Actions
          </div>
          <button
            onClick={onExport}
            className="w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)] transition-colors"
          >
            <span className="text-base">📦</span>
            Export workflow bundle
          </button>
        </div>
      )}

      {/* New workflow placeholder */}
      {isNew && (
        <div className="px-4 py-8 text-center">
          <div className="text-sm text-[var(--color-text-tertiary)]">
            Save the workflow to access all settings.
          </div>
        </div>
      )}
    </div>
  );
}
