export function MetadataRow({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: React.ReactNode;
  monospace?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-sm text-text-primary${monospace ? ' font-mono' : ''}`}>
        {value || <span className="text-text-muted">-</span>}
      </div>
    </div>
  );
}
