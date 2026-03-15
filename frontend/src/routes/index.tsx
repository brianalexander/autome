import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkflows, useTriggerWorkflow, useDeleteWorkflow } from '../hooks/queries';
import { TriggerDialog } from '../components/TriggerDialog';
import { workflows as workflowsApi, isTriggerType, type BundlePreview, type ImportResult } from '../lib/api';

export const Route = createFileRoute('/')({
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { data: workflowList, isLoading, error } = useWorkflows();
  const triggerMutation = useTriggerWorkflow();
  const deleteMutation = useDeleteWorkflow();
  const navigate = useNavigate();
  const [triggerTarget, setTriggerTarget] = useState<{ id: string; name: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const queryClient = useQueryClient();

  if (isLoading) return <div className="p-6 text-text-secondary">Loading workflows...</div>;
  if (error) return <div className="p-6 text-red-600 dark:text-red-400">Error: {(error as Error).message}</div>;

  return (
    <div className="flex-1 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Workflows</h2>
        <div className="flex gap-2">
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

      {!workflowList?.data?.length ? (
        <div className="text-text-tertiary text-center py-12">No workflows yet. Create one to get started.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workflowList.data.map((workflow) => {
            const triggerStages = workflow.stages.filter((s) => isTriggerType(s.type));
            const triggerLabel =
              triggerStages.length > 0 ? triggerStages[0].type.replace('-trigger', '') : workflow.trigger.provider;
            const isWebhook = triggerStages.some((s) => s.type === 'webhook-trigger');
            const hasManualTrigger =
              triggerStages.some((s) => s.type === 'manual-trigger') || workflow.trigger.provider === 'manual';

            return (
              <div
                key={workflow.id}
                className="border border-border rounded-xl bg-surface p-5 shadow-sm hover:shadow-md hover:border-border-subtle transition-all flex flex-col"
              >
                {/* Header: name + active badge */}
                <div className="flex items-start justify-between mb-2">
                  <Link
                    to="/workflows/$workflowId"
                    params={{ workflowId: workflow.id }}
                    className="text-lg font-semibold hover:text-blue-600 dark:hover:text-blue-400 transition-colors leading-tight"
                  >
                    {workflow.name}
                  </Link>
                  <span
                    className={`ml-2 flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                      workflow.active
                        ? 'bg-status-success-muted text-green-600 dark:text-green-400'
                        : 'bg-surface-tertiary text-text-tertiary'
                    }`}
                  >
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-full ${workflow.active ? 'bg-green-400' : 'bg-text-muted'}`}
                    />
                    {workflow.active ? 'Active' : 'Inactive'}
                  </span>
                </div>

                {/* Description */}
                <p className="text-sm text-text-secondary mb-3 line-clamp-2 min-h-[1.25rem]">
                  {workflow.description || '\u00A0'}
                </p>

                {/* Stats */}
                <div className="flex flex-wrap gap-2 mb-4 text-xs">
                  <span className="px-2 py-1 rounded bg-surface-tertiary text-text-secondary">
                    {workflow.stages.length} stages
                  </span>
                  <span className="px-2 py-1 rounded bg-surface-tertiary text-text-secondary">
                    {workflow.edges.length} edges
                  </span>
                  <span
                    className={`px-2 py-1 rounded font-medium ${
                      isWebhook
                        ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                        : 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300'
                    }`}
                  >
                    {triggerLabel}
                  </span>
                </div>

                {/* Spacer to push actions to bottom */}
                <div className="flex-1" />

                {/* Actions */}
                <div className="flex gap-2 pt-3 border-t border-border">
                  {hasManualTrigger && (
                    <button
                      onClick={() => setTriggerTarget({ id: workflow.id, name: workflow.name })}
                      disabled={triggerMutation.isPending}
                      className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors"
                    >
                      Start
                    </button>
                  )}
                  <button
                    onClick={() => toast.info('Export coming soon')}
                    className="px-3 py-1.5 text-sm border border-border hover:bg-interactive text-text-secondary hover:text-text-primary rounded-lg transition-colors"
                  >
                    Export
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete this workflow?')) {
                        deleteMutation.mutate(workflow.id);
                      }
                    }}
                    className="px-3 py-1.5 text-sm border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg ml-auto transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TriggerDialog
        workflowName={triggerTarget?.name || ''}
        isOpen={!!triggerTarget}
        onClose={() => setTriggerTarget(null)}
        onTrigger={(payload) => {
          triggerMutation.mutate({ id: triggerTarget!.id, payload }, { onSuccess: () => setTriggerTarget(null) });
        }}
        isPending={triggerMutation.isPending}
      />

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
                <div className="text-sm font-medium">{preview.workflow.name}</div>
                {preview.workflow.description && (
                  <div className="text-xs text-text-secondary mt-0.5">{preview.workflow.description}</div>
                )}
                <div className="text-xs text-text-tertiary mt-1">
                  {preview.workflow.stageCount} stages, {preview.workflow.edgeCount} edges
                </div>
              </div>

              {Object.keys(preview.manifest.agents).length > 0 && (
                <div>
                  <div className="text-xs font-medium text-text-secondary mb-1">Bundled Agents</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.keys(preview.manifest.agents).map((name) => (
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

              {(preview.manifest.requirements.mcpServers.length > 0 ||
                preview.manifest.requirements.systemDependencies.length > 0) && (
                <div>
                  <div className="text-xs font-medium text-text-secondary mb-1">Requirements</div>
                  {preview.manifest.requirements.mcpServers.length > 0 && (
                    <div className="text-xs text-text-tertiary">
                      MCP Servers: {preview.manifest.requirements.mcpServers.join(', ')}
                    </div>
                  )}
                  {preview.manifest.requirements.systemDependencies.length > 0 && (
                    <div className="text-xs text-text-tertiary">
                      System: {preview.manifest.requirements.systemDependencies.join(', ')}
                    </div>
                  )}
                  {preview.manifest.requirements.secrets.length > 0 && (
                    <div className="text-xs text-text-tertiary">
                      Secrets: {preview.manifest.requirements.secrets.join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Import result */}
          {result && (
            <div className="space-y-3">
              <div className="text-sm text-green-600 dark:text-green-400 font-medium">Import successful</div>
              <div className="text-xs text-text-secondary">
                Imported {result.importedAgents.length} agent(s) and {result.extractedResources.length} resource(s).
              </div>
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
