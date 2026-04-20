import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useRef, useCallback, useMemo } from 'react';
import { Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkflows, useTriggerWorkflow, useDeleteWorkflow, useActivateWorkflow, useDeactivateWorkflow, useNodeTypes } from '../hooks/queries';
import { TriggerDialog } from '../components/TriggerDialog';
import { PromptTriggerDialog } from '../components/PromptTriggerDialog';
import { workflows as workflowsApi, isTriggerType, type BundlePreview, type ImportResult } from '../lib/api';
import { stripMarkdown } from '../lib/format';

export const Route = createFileRoute('/')({
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { data: workflowList, isLoading, error } = useWorkflows();
  const { data: nodeTypeList } = useNodeTypes();
  const triggerMutation = useTriggerWorkflow();
  const deleteMutation = useDeleteWorkflow();
  const activateMutation = useActivateWorkflow();
  const deactivateMutation = useDeactivateWorkflow();
  const navigate = useNavigate();
  const [triggerTarget, setTriggerTarget] = useState<{ id: string; name: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Build an id→info lookup map for O(1) access in the render loop below
  const nodeTypeMap = useMemo(() => {
    const map: Record<string, { hasLifecycle?: boolean }> = {};
    for (const nt of nodeTypeList ?? []) {
      map[nt.id] = nt;
    }
    return map;
  }, [nodeTypeList]);

  const triggerType = useMemo(() => {
    if (!triggerTarget) return undefined;
    const wf = workflowList?.data?.find((w) => w.id === triggerTarget.id);
    return wf?.stages.find((s) => isTriggerType(s.type))?.type;
  }, [triggerTarget, workflowList]);

  const triggerSchema = useMemo(() => {
    if (!triggerTarget) return undefined;
    const wf = workflowList?.data?.find((w) => w.id === triggerTarget.id);
    const triggerStage = wf?.stages.find((s) => isTriggerType(s.type));
    return (triggerStage?.config as Record<string, unknown>)?.output_schema as Record<string, unknown> | undefined;
  }, [triggerTarget, workflowList]);
  const queryClient = useQueryClient();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-text-muted text-sm">Loading workflows...</span>
      </div>
    );
  }
  if (error) return <div className="p-6 text-red-600 dark:text-red-400">Error: {(error as Error).message}</div>;

  if (!workflowList?.data?.length) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Boxes className="w-12 h-12 text-text-muted/30 mx-auto mb-3" />
          <p className="text-text-secondary text-sm">No workflows yet</p>
          <p className="text-text-muted text-xs mt-1">Create a workflow to automate your tasks</p>
          <div className="flex justify-center gap-2 mt-4">
            <button
              onClick={() => setImportOpen(true)}
              className="px-4 py-2 text-sm border border-border hover:bg-interactive text-text-secondary hover:text-text-primary rounded-lg transition-colors"
            >
              Import
            </button>
            <button
              onClick={() => navigate({ to: '/workflows/new' })}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              + New Workflow
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto relative">
      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workflowList.data.map((workflow) => {
            const triggerStages = workflow.stages.filter((s) => isTriggerType(s.type));
            const triggerLabel =
              triggerStages.length > 0 ? triggerStages[0].type.replace('-trigger', '') : workflow.trigger.provider;
            const isWebhook = triggerStages.some((s) => s.type === 'webhook-trigger');
            const hasManualTrigger =
              triggerStages.some((s) => s.type === 'manual-trigger' || s.type === 'prompt-trigger') ||
              workflow.trigger.provider === 'manual' ||
              workflow.trigger.provider === 'prompt';
            // Use registry metadata when loaded; fall back to false (don't flash the button on)
            const needsActivation = nodeTypeList
              ? triggerStages.some((s) => nodeTypeMap[s.type]?.hasLifecycle === true)
              : false;

            return (
              <div
                key={workflow.id}
                className="group border border-border rounded-xl bg-surface hover:border-border-subtle transition-all overflow-hidden"
              >
                {/* Top section — clickable */}
                <Link
                  to="/workflows/$workflowId"
                  params={{ workflowId: workflow.id }}
                  className="block p-4 pb-3"
                >
                  <h3 className="text-sm font-semibold text-text-primary group-hover:text-blue-500 transition-colors leading-tight mb-1.5">
                    {workflow.name}
                  </h3>
                  {workflow.description && (
                    <p className="text-xs text-text-tertiary line-clamp-2 mb-2">
                      {stripMarkdown(workflow.description)}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-[10px] text-text-muted">
                    <span>{workflow.stages.length} stages</span>
                    <span>·</span>
                    <span className="capitalize">{triggerLabel}</span>
                  </div>
                </Link>

                {/* Bottom bar — actions, only visible on hover */}
                <div className="px-4 py-2 border-t border-border/50 flex items-center gap-2">
                  {/* Activate/deactivate toggle — only for trigger types that need activation */}
                  {needsActivation && (
                    <button
                      onClick={() => workflow.active
                        ? deactivateMutation.mutate(workflow.id)
                        : activateMutation.mutate(workflow.id)
                      }
                      className={`text-[11px] px-2 py-0.5 rounded-md transition-colors ${
                        workflow.active
                          ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'
                          : 'text-text-tertiary hover:bg-surface-secondary hover:text-text-secondary'
                      }`}
                    >
                      {workflow.active ? 'Active' : 'Activate'}
                    </button>
                  )}

                  {hasManualTrigger && (
                    <button
                      onClick={() => setTriggerTarget({ id: workflow.id, name: workflow.name })}
                      disabled={triggerMutation.isPending}
                      className="text-[11px] text-text-tertiary hover:text-blue-500 px-2 py-0.5 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    >
                      Run
                    </button>
                  )}

                  <button
                    onClick={async () => {
                      try {
                        const cloned = await workflowsApi.clone(workflow.id);
                        queryClient.invalidateQueries({ queryKey: ['workflows'] });
                        navigate({ to: '/workflows/$workflowId', params: { workflowId: cloned.id } });
                      } catch (err) {
                        toast.error(`Clone failed: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }}
                    className="text-[11px] text-text-tertiary hover:text-text-secondary px-2 py-0.5 rounded-md hover:bg-surface-secondary transition-colors"
                  >
                    Clone
                  </button>

                  <div className="flex-1" />

                  <button
                    onClick={() => {
                      if (confirm('Delete this workflow?')) deleteMutation.mutate(workflow.id);
                    }}
                    className="text-[11px] text-text-muted hover:text-red-500 px-2 py-0.5 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Floating action buttons */}
      <div className="absolute bottom-6 right-6 flex items-center gap-2">
        <button
          onClick={() => setImportOpen(true)}
          className="px-4 py-2 text-sm border border-border bg-surface shadow-lg hover:bg-interactive text-text-secondary hover:text-text-primary rounded-lg transition-colors"
        >
          Import
        </button>
        <button
          onClick={() => navigate({ to: '/workflows/new' })}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white shadow-lg rounded-lg disabled:opacity-50 transition-colors"
        >
          + New Workflow
        </button>
      </div>

      {triggerType === 'prompt-trigger' ? (
        <PromptTriggerDialog
          workflowName={triggerTarget?.name || ''}
          isOpen={!!triggerTarget}
          onClose={() => setTriggerTarget(null)}
          onTrigger={(payload) => {
            triggerMutation.mutate({ id: triggerTarget!.id, payload }, { onSuccess: () => setTriggerTarget(null) });
          }}
          isPending={triggerMutation.isPending}
        />
      ) : (
        <TriggerDialog
          workflowName={triggerTarget?.name || ''}
          isOpen={!!triggerTarget}
          onClose={() => setTriggerTarget(null)}
          onTrigger={(payload) => {
            triggerMutation.mutate({ id: triggerTarget!.id, payload }, { onSuccess: () => setTriggerTarget(null) });
          }}
          isPending={triggerMutation.isPending}
          outputSchema={triggerSchema}
        />
      )}

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(workflowId) => {
            setImportOpen(false);
            queryClient.invalidateQueries({ queryKey: ['workflows'] });
            navigate({ to: '/workflows/$workflowId', params: { workflowId } });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import Dialog
// ---------------------------------------------------------------------------

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (workflowId: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = useCallback(async (file: File) => {
    setSelectedFile(file);
    setError(null);
    setLoading(true);
    try {
      const p = await workflowsApi.previewBundle(file);
      setPreview(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!selectedFile) return;
    setImporting(true);
    setError(null);
    try {
      const r = await workflowsApi.importBundle(selectedFile);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [selectedFile]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface rounded-xl border border-border shadow-xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex justify-between items-center">
          <h3 className="font-semibold">Import Workflow</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary text-sm">
            {'\u2715'}
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* File picker */}
          {!result && (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".autome"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFileSelect(f);
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full px-4 py-8 border-2 border-dashed border-border-subtle rounded-lg text-text-secondary hover:border-blue-400 hover:text-blue-500 transition-colors text-sm"
              >
                {selectedFile ? selectedFile.name : 'Click to select a .autome file'}
              </button>
            </div>
          )}

          {loading && <div className="text-sm text-text-secondary">Loading bundle preview...</div>}
          {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded">{error}</div>}

          {/* Preview */}
          {preview && !result && (
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium">{preview.bundle.name}</div>
                {preview.bundle.description && (
                  <div className="text-xs text-text-secondary mt-0.5">{stripMarkdown(preview.bundle.description)}</div>
                )}
                <div className="text-xs text-text-tertiary mt-1">
                  {preview.workflow.stageCount} stages, {preview.workflow.edgeCount} edges
                </div>
              </div>

              {preview.bundle.requiredAgents.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-text-secondary mb-1">Required Agents</div>
                  <div className="flex flex-wrap gap-1">
                    {preview.bundle.requiredAgents.map((name) => (
                      <span
                        key={name}
                        className="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-2 py-0.5 rounded"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* Import result */}
          {result && (
            <div className="space-y-3">
              <div className="text-sm text-green-600 dark:text-green-400 font-medium">Import successful</div>
              {result.warnings.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-orange-600 dark:text-orange-400">Warnings</div>
                  {result.warnings.map((w, i) => (
                    <div
                      key={i}
                      className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded"
                    >
                      {w.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border flex justify-end gap-2">
          {result ? (
            <button
              onClick={() => onImported(result.workflowId)}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg"
            >
              Open Workflow
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm border border-border rounded-lg text-text-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={!preview || importing}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50"
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
