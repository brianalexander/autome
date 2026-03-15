export function SectionHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] text-text-tertiary uppercase tracking-wider font-medium ${className}`}>{children}</div>
  );
}
