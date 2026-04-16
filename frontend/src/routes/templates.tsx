import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Bookmark, Download, Upload, Copy, Trash2, FileJson, X } from 'lucide-react';
import { useTemplates } from '../hooks/queries';
import { templates as templatesApi, type NodeTemplateRecord, type StageDefinition } from '../lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, useMemo } from 'react';
import { StageConfigForm } from '../components/canvas/StageConfigForm';
import { ReadmeEditor } from '../components/canvas/ReadmeEditor';
import { resolveLucideIcon } from '../lib/iconResolver';

export const Route = createFileRoute('/templates')({
  component: TemplatesPage,
});

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SOURCE_COLORS: Record<string, string> = {
  local: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300',
  imported: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300',
};
function sourceClass(source: string): string {
  if (source.startsWith('plugin:')) {
    return 'bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-300';
  }
  return SOURCE_COLORS[source] ?? 'bg-surface-tertiary text-text-muted';
}

// ---------------------------------------------------------------------------
// Grid card
// ---------------------------------------------------------------------------

function TemplateCard({
  template,
  isSelected,
  onSelect,
  onRefresh,
}: {
  template: NodeTemplateRecord;
  isSelected: boolean;
  onSelect: () => void;
  onRefresh: () => void;
}) {
  const handleExport = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const data = await templatesApi.export(template.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `template-${template.name.toLowerCase().replace(/\s+/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDuplicate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await templatesApi.duplicate(template.id);
      toast.success(`Duplicated "${template.name}"`);
      onRefresh();
    } catch (err) {
      toast.error(`Duplicate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete template "${template.name}"? This cannot be undone.`)) return;
    try {
      await templatesApi.delete(template.id);
      toast.success('Template deleted');
      onRefresh();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const NodeIcon = template.icon ? resolveLucideIcon(template.icon) : null;

  return (
    <div
      onClick={onSelect}
      className={`group border rounded-xl bg-surface transition-all overflow-hidden cursor-pointer ${
        isSelected
          ? 'border-blue-400 ring-1 ring-blue-400/40'
          : 'border-border hover:border-border-subtle'
      }`}
    >
      <div className="p-4">
        <div className="flex items-start gap-2.5">
          <div className="flex-shrink-0 mt-0.5">
            {NodeIcon ? (
              <NodeIcon className="w-4 h-4 text-blue-400" strokeWidth={1.75} />
            ) : (
              <Bookmark className="w-4 h-4 text-blue-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary truncate">
              {template.name || <span className="text-text-tertiary italic">Untitled template</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="text-[10px] font-mono text-text-secondary bg-surface-secondary px-1.5 py-0.5 rounded truncate max-w-[160px]">
            {template.node_type}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${sourceClass(template.source)}`}>
            {template.source}
          </span>
          <span
            className="text-[10px] text-text-muted tabular-nums"
            title={new Date(template.updated_at).toLocaleString()}
          >
            {timeAgo(template.updated_at)}
          </span>
        </div>
      </div>

      <div className="px-4 py-2 border-t border-border/50 flex items-center gap-1">
        <button
          onClick={handleExport}
          className="text-text-muted hover:text-text-primary p-1 rounded hover:bg-surface-secondary transition-colors"
          title="Export as JSON"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleDuplicate}
          className="text-text-muted hover:text-text-primary p-1 rounded hover:bg-surface-secondary transition-colors"
          title="Duplicate"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <div className="flex-1" />
        <button
          onClick={handleDelete}
          className="text-text-muted hover:text-red-500 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-side config editor pane
// ---------------------------------------------------------------------------

function templateToStage(template: NodeTemplateRecord): StageDefinition {
  return {
    id: template.id,
    type: template.node_type,
    label: template.name,
    config: template.config,
  } as StageDefinition;
}

function TemplateConfigPane({
  template,
  onClose,
}: {
  template: NodeTemplateRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [stageDraft, setStageDraft] = useState<StageDefinition>(() => templateToStage(template));
  const [nameDraft, setNameDraft] = useState(template.name);
  const [descriptionDraft, setDescriptionDraft] = useState(template.description ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset drafts when switching templates
  const templateIdRef = useRef(template.id);
  if (templateIdRef.current !== template.id) {
    templateIdRef.current = template.id;
    setStageDraft(templateToStage(template));
    setNameDraft(template.name);
    setDescriptionDraft(template.description ?? '');
    setDirty(false);
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await templatesApi.update(template.id, {
        name: nameDraft.trim() || template.name,
        description: descriptionDraft.trim() || undefined,
        config: stageDraft.config as Record<string, unknown>,
      });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setDirty(false);
      toast.success('Template saved');
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setStageDraft(templateToStage(template));
    setNameDraft(template.name);
    setDescriptionDraft(template.description ?? '');
    setDirty(false);
  };

  return (
    <div className="flex-shrink-0 w-[480px] border-l border-border bg-surface flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div className="min-w-0">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Template</div>
          <div className="text-[10px] font-mono text-text-muted">{template.node_type}</div>
        </div>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary p-1 flex-shrink-0"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wider mb-1 block">Name</label>
          <input
            value={nameDraft}
            onChange={(e) => {
              setNameDraft(e.target.value);
              setDirty(true);
            }}
            className="w-full text-sm text-text-primary bg-surface-secondary border border-border rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
          />
        </div>

        {/* Description (README-style) */}
        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wider mb-1 block">Description</label>
          <ReadmeEditor
            value={descriptionDraft}
            onChange={(val) => {
              setDescriptionDraft(val ?? '');
              setDirty(true);
            }}
          />
        </div>

        {/* Type-specific config form */}
        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wider mb-1 block">Config</label>
          <StageConfigForm
            stage={stageDraft}
            onChange={(updated) => {
              setStageDraft(updated);
              setDirty(true);
            }}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border flex items-center justify-end gap-2 flex-shrink-0">
        <button
          onClick={handleReset}
          disabled={!dirty || saving}
          className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Reset
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function TemplatesPage() {
  const queryClient = useQueryClient();
  const { data: templateList, isLoading, error } = useTemplates();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['templates'] });

  const selectedTemplate = useMemo(
    () => templateList?.find((t) => t.id === selectedId) ?? null,
    [templateList, selectedId],
  );

  // Clear selection if the selected template was deleted
  if (selectedId && templateList && !selectedTemplate) {
    setSelectedId(null);
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const items = Array.isArray(json) ? json : [json];
      const imported = await templatesApi.import(items);
      toast.success(`Imported ${imported.length} template${imported.length !== 1 ? 's' : ''}`);
      refresh();
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-text-muted text-sm">Loading templates...</span>
      </div>
    );
  }
  if (error) {
    return <div className="p-6 text-red-600 dark:text-red-400">Error: {(error as Error).message}</div>;
  }

  const list = templateList ?? [];

  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* Main content area */}
      <div className="flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center py-16">
              <FileJson className="w-10 h-10 text-text-muted/30 mx-auto mb-3" />
              <p className="text-text-secondary text-sm">No templates yet</p>
              <p className="text-text-muted text-xs mt-1">
                Save a stage as a template from the config panel, or import a JSON file.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {list.map((tmpl) => (
                <TemplateCard
                  key={tmpl.id}
                  template={tmpl}
                  isSelected={tmpl.id === selectedId}
                  onSelect={() => setSelectedId(tmpl.id === selectedId ? null : tmpl.id)}
                  onRefresh={refresh}
                />
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Floating import button — positioned outside the scrollable area so it stays visible */}
      <div className="absolute bottom-6 left-0 right-0 pointer-events-none flex items-center justify-end pr-6" style={selectedTemplate ? { right: 480 } : undefined}>
        <input
          ref={importInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleImport}
        />
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={importing}
          className="pointer-events-auto flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg border border-border bg-surface shadow-lg text-text-secondary hover:text-text-primary hover:border-border-subtle transition-colors disabled:opacity-50"
        >
          <Upload className="w-3.5 h-3.5" />
          {importing ? 'Importing...' : 'Import JSON'}
        </button>
      </div>

      {/* Right-side config editor */}
      {selectedTemplate && (
        <TemplateConfigPane
          key={selectedTemplate.id}
          template={selectedTemplate}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
