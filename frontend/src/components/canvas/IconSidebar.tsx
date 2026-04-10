import { Bot, Puzzle, AlertTriangle, History, Settings } from 'lucide-react';

type SidebarTab = 'author' | 'nodes' | 'issues' | 'versions' | 'settings' | null;

interface IconSidebarProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  badges?: Partial<Record<NonNullable<SidebarTab>, number>>;
}

const TABS = [
  { id: 'author' as const, icon: Bot, label: 'AI Author', shortcut: '1' },
  { id: 'nodes' as const, icon: Puzzle, label: 'Add Nodes', shortcut: '2' },
  { id: 'issues' as const, icon: AlertTriangle, label: 'Issues', shortcut: '3' },
  { id: 'versions' as const, icon: History, label: 'Versions', shortcut: '4' },
  { id: 'settings' as const, icon: Settings, label: 'Settings', shortcut: '5' },
] as const;

export function IconSidebar({ activeTab, onTabChange, badges }: IconSidebarProps) {
  return (
    <div className="flex flex-col items-center w-12 bg-[var(--color-surface)] border-r border-[var(--color-border)] py-2 gap-1 flex-shrink-0">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        const badgeCount = badges?.[tab.id] ?? 0;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(isActive ? null : tab.id)}
            className={`
              relative w-9 h-9 rounded-lg flex items-center justify-center
              transition-all duration-150 ease-out
              ${isActive
                ? 'bg-[var(--color-accent)] text-white shadow-sm'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)]'
              }
            `}
            title={`${tab.label} (${tab.shortcut})`}
          >
            <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} />
            {badgeCount > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[14px] h-3.5 flex items-center justify-center text-[9px] font-bold bg-red-500 text-white rounded-full px-0.5 leading-none">
                {badgeCount > 99 ? '99+' : badgeCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type { SidebarTab };
