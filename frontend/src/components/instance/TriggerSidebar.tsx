import { SidebarShell } from '../ui/SidebarShell';
import { MetadataRow } from '../ui/MetadataRow';
import type { WorkflowDefinition } from '../../lib/api';

export function TriggerSidebar({
  trigger,
  triggerEvent,
  workflowId,
  onClose,
}: {
  trigger?: Record<string, unknown> | WorkflowDefinition['trigger'];
  triggerEvent?: { id: string; timestamp: string; provider?: string; payload?: unknown; metadata?: Record<string, unknown> };
  workflowId?: string;
  onClose: () => void;
}) {
  const isWebhook = trigger?.provider === 'webhook';
  const webhookUrl = workflowId ? `${window.location.origin}/api/webhooks/${workflowId}` : null;

  return (
    <SidebarShell
      title={isWebhook ? 'Webhook Trigger' : 'Trigger'}
      statusBadge="completed"
      onClose={onClose}
      onCopyConfig={() => navigator.clipboard.writeText(JSON.stringify({ trigger, triggerEvent }, null, 2))}
    >
      {trigger && (
        <>
          <MetadataRow label="Provider" value={String((trigger as Record<string, unknown>).provider || 'manual')} />
          {isWebhook && webhookUrl && (
            <div>
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Webhook URL</div>
              <div className="flex items-center gap-2">
                <code className="text-xs text-violet-600 dark:text-violet-300 bg-surface-secondary rounded px-2 py-1.5 flex-1 overflow-x-auto font-mono">
                  {webhookUrl}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(webhookUrl)}
                  className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-1 bg-surface-tertiary rounded flex-shrink-0"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
          {isWebhook && (trigger as Record<string, Record<string, unknown>>)?.webhook?.secret && (
            <MetadataRow
              label="Secret"
              value={
                <span className="text-xs text-text-tertiary font-mono">
                  {'*'.repeat(8)} (set via x-webhook-secret header)
                </span>
              }
            />
          )}
          {trigger.filter && (
            <MetadataRow
              label="Filter"
              value={
                <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto mt-1">
                  {JSON.stringify(trigger.filter, null, 2)}
                </pre>
              }
            />
          )}
        </>
      )}
      {triggerEvent && (
        <>
          <MetadataRow label="Event ID" value={<span className="font-mono text-xs">{triggerEvent.id}</span>} />
          <MetadataRow label="Timestamp" value={new Date(triggerEvent.timestamp).toLocaleString()} />
          {triggerEvent.provider === 'webhook' && triggerEvent.metadata?.source_ip && (
            <MetadataRow label="Source IP" value={String(triggerEvent.metadata.source_ip)} />
          )}
          <div>
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Payload</div>
            <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">
              {typeof triggerEvent.payload === 'string'
                ? triggerEvent.payload
                : JSON.stringify(triggerEvent.payload, null, 2)}
            </pre>
          </div>
        </>
      )}
    </SidebarShell>
  );
}
