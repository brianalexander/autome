import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';
import { KeyRound, Trash2, RotateCcw, Plus, X, Eye, EyeOff } from 'lucide-react';
import { useSecrets } from '../hooks/queries';
import { secrets as secretsApi, type SecretRecord } from '../lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Add / Rotate dialog
// ---------------------------------------------------------------------------

function SecretDialog({
  mode,
  secret,
  onClose,
  onSaved,
}: {
  mode: 'add' | 'rotate';
  secret?: SecretRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(secret?.name ?? '');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState(secret?.description ?? '');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  const nameError = name && !SECRET_NAME_RE.test(name)
    ? 'Must match /^[A-Z][A-Z0-9_]*$/ (uppercase letters, digits, underscores)'
    : null;

  const canSubmit = (mode === 'add' ? name.trim() && !nameError : true) && value.trim() && !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      if (mode === 'add') {
        await secretsApi.create({ name: name.trim(), value: value.trim(), description: description.trim() || undefined });
        toast.success(`Secret "${name}" created`);
      } else {
        await secretsApi.update(secret!.name, { value: value.trim(), description: description.trim() || undefined });
        toast.success(`Secret "${secret!.name}" rotated`);
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-xl w-full max-w-md mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">
            {mode === 'add' ? 'Add Secret' : `Rotate "${secret?.name}"`}
          </h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {mode === 'add' && (
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wider mb-1 block">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                autoComplete="off"
                spellCheck={false}
                placeholder="JIRA_TOKEN"
                className="w-full text-sm font-mono text-text-primary bg-surface-secondary border border-border rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
              />
              {nameError && (
                <p className="text-xs text-red-500 mt-1">{nameError}</p>
              )}
              <p className="text-[10px] text-text-muted mt-1">
                Uppercase letters, digits, and underscores. Must start with a letter.
              </p>
            </div>
          )}

          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wider mb-1 block">
              Value
            </label>
            <div className="relative">
              <input
                type={showValue ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="new-password"
                placeholder="Paste secret value..."
                className="w-full text-sm font-mono text-text-primary bg-surface-secondary border border-border rounded px-2 py-1.5 pr-8 focus:outline-none focus:border-blue-400"
              />
              <button
                type="button"
                onClick={() => setShowValue((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
              >
                {showValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wider mb-1 block">
              Description (optional)
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this secret is used for"
              className="w-full text-sm text-text-primary bg-surface-secondary border border-border rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs text-text-secondary hover:text-text-primary rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : mode === 'add' ? 'Add Secret' : 'Rotate Secret'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secrets tab
// ---------------------------------------------------------------------------

function SecretsTab() {
  const queryClient = useQueryClient();
  const { data: secretList, isLoading, error } = useSecrets();
  const [dialogMode, setDialogMode] = useState<'add' | 'rotate' | null>(null);
  const [rotatingSecret, setRotatingSecret] = useState<SecretRecord | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['secrets'] });

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete secret "${name}"? This cannot be undone. Any code using this secret will fail.`)) return;
    try {
      await secretsApi.delete(name);
      toast.success(`Secret "${name}" deleted`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const openRotate = (secret: SecretRecord) => {
    setRotatingSecret(secret);
    setDialogMode('rotate');
  };

  const closeDialog = () => {
    setDialogMode(null);
    setRotatingSecret(null);
  };

  if (isLoading) {
    return <div className="p-6 text-text-muted text-sm">Loading secrets...</div>;
  }
  if (error) {
    return <div className="p-6 text-red-500 text-sm">Error: {(error as Error).message}</div>;
  }

  const list = secretList ?? [];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Secrets</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Encrypted key/value store. Reference in code nodes via{' '}
              <code className="font-mono bg-surface-secondary px-1 rounded">context.secrets.NAME</code>{' '}
              or in templates via{' '}
              <code className="font-mono bg-surface-secondary px-1 rounded">{'{{ secret(\'NAME\') }}'}</code>.
            </p>
          </div>
          <button
            onClick={() => setDialogMode('add')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Secret
          </button>
        </div>

        {list.length === 0 ? (
          <div className="border border-dashed border-border rounded-xl p-12 text-center">
            <KeyRound className="w-8 h-8 text-text-muted/30 mx-auto mb-3" />
            <p className="text-text-secondary text-sm">No secrets yet</p>
            <p className="text-text-muted text-xs mt-1">
              Add API keys and tokens to reference them safely in workflow code.
            </p>
          </div>
        ) : (
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left text-[10px] uppercase tracking-wider text-text-muted px-4 py-2">Name</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-text-muted px-4 py-2">Description</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-text-muted px-4 py-2">Created</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-text-muted px-4 py-2">Last Used</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {list.map((secret, i) => (
                  <tr
                    key={secret.id}
                    className={`${i > 0 ? 'border-t border-border' : ''} hover:bg-surface-secondary/50 transition-colors`}
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-text-primary bg-surface-secondary px-1.5 py-0.5 rounded">
                        {secret.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-secondary max-w-[200px] truncate">
                      {secret.description ?? <span className="text-text-muted italic">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted tabular-nums" title={secret.created_at}>
                      {timeAgo(secret.created_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted tabular-nums" title={secret.last_used_at ?? ''}>
                      {timeAgo(secret.last_used_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => openRotate(secret)}
                          className="p-1 text-text-muted hover:text-text-primary rounded hover:bg-surface-tertiary transition-colors"
                          title="Rotate (update value)"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(secret.name)}
                          className="p-1 text-text-muted hover:text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialogMode && (
        <SecretDialog
          mode={dialogMode}
          secret={rotatingSecret ?? undefined}
          onClose={closeDialog}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function SettingsPage() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-3 flex-shrink-0">
        <h1 className="text-sm font-semibold text-text-primary">Settings</h1>
      </div>
      <SecretsTab />
    </div>
  );
}
