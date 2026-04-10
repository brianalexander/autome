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
