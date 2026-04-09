/**
 * ValidationPanel — sidebar panel showing live validation results and health issues
 * for the current draft workflow.
 */
import { useState } from 'react';
import { CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useWorkflowValidation, useWorkflowHealth } from '../../hooks/queries';

interface CodeDiagnostic {
  message: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
}

interface WorkflowValidationResult {
  valid: boolean;
  summary: string;
  errors: string[];
  warnings: string[];
  stages: Record<string, { config: string[]; code: CodeDiagnostic[] }>;
  edges: Record<string, { errors: string[]; condition: CodeDiagnostic[] }>;
}

interface ValidationPanelProps {
  workflowId: string;
}

function CollapsibleSection({
  title,
  count,
  colorClass,
  defaultOpen = true,
  children,
}: {
  title: string;
  count: number;
  colorClass: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (count === 0) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-4 py-2 hover:bg-[var(--color-interactive)] transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] flex-shrink-0" />
        )}
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${colorClass}`}>
          {title}
        </span>
        <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full ${colorClass} bg-current/10`}>
          {count}
        </span>
      </button>
      {open && <div className="px-3 pb-1 space-y-1.5">{children}</div>}
    </div>
  );
}

function IssueCard({
  message,
  severity,
  detail,
}: {
  message: string;
  severity: 'error' | 'warning';
  detail?: string;
}) {
  const isError = severity === 'error';
  return (
    <div
      className={`flex gap-2 items-start px-2.5 py-2 rounded-lg border ${
        isError
          ? 'border-red-500/20 bg-red-500/5'
          : 'border-yellow-500/20 bg-yellow-500/5'
      }`}
    >
      {isError ? (
        <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
      ) : (
        <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0 mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        <div className={`text-xs ${isError ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
          {message}
        </div>
        {detail && (
          <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">{detail}</div>
        )}
      </div>
    </div>
  );
}

export function ValidationPanel({ workflowId }: ValidationPanelProps) {
  const { data: validation, isLoading: validationLoading } = useWorkflowValidation(workflowId);
  const { data: health, isLoading: healthLoading } = useWorkflowHealth(workflowId);

  const isLoading = validationLoading || healthLoading;

  const v = validation as WorkflowValidationResult | undefined;

  // Collect all issues for summary
  const errorCount =
    (v?.errors.length ?? 0) +
    Object.values(v?.stages ?? {}).reduce((acc, s) => acc + s.config.length + s.code.filter((c) => c.severity === 'error').length, 0) +
    Object.values(v?.edges ?? {}).reduce((acc, e) => acc + e.errors.length + e.condition.filter((c) => c.severity === 'error').length, 0) +
    (health?.warnings.filter((w) => w.severity === 'error').length ?? 0);

  const warningCount =
    (v?.warnings.length ?? 0) +
    Object.values(v?.stages ?? {}).reduce((acc, s) => acc + s.code.filter((c) => c.severity === 'warning').length, 0) +
    Object.values(v?.edges ?? {}).reduce((acc, e) => acc + e.condition.filter((c) => c.severity === 'warning').length, 0) +
    (health?.warnings.filter((w) => w.severity === 'warning').length ?? 0);

  const totalIssues = errorCount + warningCount;
  const hasIssues = totalIssues > 0;

  // Stage-level issues grouped
  const stageErrors: Array<{ stageId: string; message: string; detail?: string }> = [];
  const stageWarnings: Array<{ stageId: string; message: string; detail?: string }> = [];
  if (v?.stages) {
    for (const [stageId, stageDiag] of Object.entries(v.stages)) {
      for (const msg of stageDiag.config) {
        stageErrors.push({ stageId, message: msg });
      }
      for (const diag of stageDiag.code) {
        const detail = diag.line != null ? `Line ${diag.line}${diag.column != null ? `, col ${diag.column}` : ''}` : undefined;
        if (diag.severity === 'error') {
          stageErrors.push({ stageId, message: diag.message, detail });
        } else {
          stageWarnings.push({ stageId, message: diag.message, detail });
        }
      }
    }
  }

  const edgeErrors: Array<{ edgeId: string; message: string; detail?: string }> = [];
  const edgeWarnings: Array<{ edgeId: string; message: string; detail?: string }> = [];
  if (v?.edges) {
    for (const [edgeId, edgeDiag] of Object.entries(v.edges)) {
      for (const msg of edgeDiag.errors) {
        edgeErrors.push({ edgeId, message: msg });
      }
      for (const diag of edgeDiag.condition) {
        const detail = diag.line != null ? `Line ${diag.line}${diag.column != null ? `, col ${diag.column}` : ''}` : undefined;
        if (diag.severity === 'error') {
          edgeErrors.push({ edgeId, message: diag.message, detail });
        } else {
          edgeWarnings.push({ edgeId, message: diag.message, detail });
        }
      }
    }
  }

  const healthErrors = health?.warnings.filter((w) => w.severity === 'error') ?? [];
  const healthWarnings = health?.warnings.filter((w) => w.severity === 'warning') ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Issues</h2>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-tertiary)]">
          Checking...
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Issues</h2>
        {hasIssues && (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/15 text-red-500">
            {totalIssues}
          </span>
        )}
      </div>

      {/* Summary bar */}
      <div className={`px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 ${
        hasIssues ? '' : 'text-emerald-500'
      }`}>
        {!hasIssues ? (
          <>
            <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">No issues found</span>
          </>
        ) : (
          <span className="text-xs text-[var(--color-text-secondary)]">
            {errorCount > 0 && (
              <span className="text-red-500 font-medium">{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
            )}
            {errorCount > 0 && warningCount > 0 && <span className="mx-1 text-[var(--color-text-tertiary)]">,</span>}
            {warningCount > 0 && (
              <span className="text-yellow-500 font-medium">{warningCount} warning{warningCount !== 1 ? 's' : ''}</span>
            )}
          </span>
        )}
      </div>

      {/* Graph-level errors */}
      <CollapsibleSection title="Errors" count={(v?.errors.length ?? 0) + stageErrors.length + edgeErrors.length + healthErrors.length} colorClass="text-red-500">
        {v?.errors.map((msg, i) => (
          <IssueCard key={`ge-${i}`} message={msg} severity="error" />
        ))}
        {stageErrors.map((item, i) => (
          <IssueCard key={`se-${i}`} message={item.message} severity="error" detail={`Stage: ${item.stageId}${item.detail ? ` · ${item.detail}` : ''}`} />
        ))}
        {edgeErrors.map((item, i) => (
          <IssueCard key={`ee-${i}`} message={item.message} severity="error" detail={`Edge: ${item.edgeId}${item.detail ? ` · ${item.detail}` : ''}`} />
        ))}
        {healthErrors.map((w, i) => (
          <IssueCard key={`he-${i}`} message={w.message} severity="error" detail={w.agentId ? `Agent: ${w.agentId}` : undefined} />
        ))}
      </CollapsibleSection>

      {/* Warnings */}
      <CollapsibleSection title="Warnings" count={(v?.warnings.length ?? 0) + stageWarnings.length + edgeWarnings.length + healthWarnings.length} colorClass="text-yellow-500">
        {v?.warnings.map((msg, i) => (
          <IssueCard key={`gw-${i}`} message={msg} severity="warning" />
        ))}
        {stageWarnings.map((item, i) => (
          <IssueCard key={`sw-${i}`} message={item.message} severity="warning" detail={`Stage: ${item.stageId}${item.detail ? ` · ${item.detail}` : ''}`} />
        ))}
        {edgeWarnings.map((item, i) => (
          <IssueCard key={`ew-${i}`} message={item.message} severity="warning" detail={`Edge: ${item.edgeId}${item.detail ? ` · ${item.detail}` : ''}`} />
        ))}
        {healthWarnings.map((w, i) => (
          <IssueCard key={`hw-${i}`} message={w.message} severity="warning" detail={w.agentId ? `Agent: ${w.agentId}` : undefined} />
        ))}
      </CollapsibleSection>
    </div>
  );
}

/**
 * Returns the total issue count for a workflow (errors + warnings) from
 * validation data. Used to drive the badge in IconSidebar.
 */
export function computeValidationBadgeCount(validation: WorkflowValidationResult | undefined): number {
  if (!validation) return 0;
  const graphErrors = validation.errors.length;
  const graphWarnings = validation.warnings.length;
  const stageIssues = Object.values(validation.stages).reduce(
    (acc, s) => acc + s.config.length + s.code.length,
    0,
  );
  const edgeIssues = Object.values(validation.edges).reduce(
    (acc, e) => acc + e.errors.length + e.condition.length,
    0,
  );
  return graphErrors + graphWarnings + stageIssues + edgeIssues;
}
