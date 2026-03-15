import { useAcpProviders, useActiveProvider } from '../../hooks/queries';

interface ProviderSelectProps {
  value?: string;
  onChange: (value: string | undefined) => void;
  /** Label for the empty/inherit option */
  emptyLabel?: string;
  className?: string;
  /** The workflow-level default provider, if set (used to label the inherit option for stage-level selects). */
  workflowProvider?: string;
  /** When true, shows a structured inherit section at the top of the dropdown. */
  showInheritOptions?: boolean;
}

export function ProviderSelect({
  value,
  onChange,
  emptyLabel = 'System default',
  className,
  workflowProvider,
  showInheritOptions = false,
}: ProviderSelectProps) {
  const { data: providers } = useAcpProviders();
  const { data: active } = useActiveProvider();

  // Build inherit option label
  let inheritLabel: string;
  if (showInheritOptions) {
    if (workflowProvider) {
      // Stage-level: workflow has a provider set
      const workflowProviderEntry = providers?.find((p) => p.name === workflowProvider);
      const workflowDisplayName = workflowProviderEntry?.displayName ?? workflowProvider;
      inheritLabel = `Workflow default (${workflowDisplayName})`;
    } else {
      // Stage-level: no workflow default, inherit system
      const systemDisplayName = active?.displayName ?? 'System default';
      inheritLabel = `System default (${systemDisplayName})`;
    }
  } else {
    // Workflow-level: inherit system
    const systemDisplayName = active?.displayName;
    inheritLabel = systemDisplayName ? `${emptyLabel} (${systemDisplayName})` : emptyLabel;
  }

  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className={`input-field${className ? ` ${className}` : ''}`}
    >
      <option value="">{inheritLabel}</option>
      {providers?.map((p) => (
        <option key={p.name} value={p.name}>
          {p.displayName}
          {p.source === 'plugin' ? ' (plugin)' : ''}
        </option>
      ))}
    </select>
  );
}
