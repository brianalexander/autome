import { Bot, Puzzle, Settings } from 'lucide-react';

type SidebarTab = 'author' | 'nodes' | 'settings' | null;

interface IconSidebarProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
}

const TABS = [
  { id: 'author' as const, icon: Bot, label: 'AI Author', shortcut: '⌘1' },
  { id: 'nodes' as const, icon: Puzzle, label: 'Add Nodes', shortcut: '⌘2' },
  { id: 'settings' as const, icon: Settings, label: 'Settings', shortcut: '⌘3' },
] as const;

export function IconSidebar({ activeTab, onTabChange }: IconSidebarProps) {
  return (
    <div className="flex flex-col items-center w-12 bg-[var(--color-surface)] border-r border-[var(--color-border)] py-2 gap-1 flex-shrink-0">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(isActive ? null : tab.id)}
            className={`
              w-9 h-9 rounded-lg flex items-center justify-center
              transition-all duration-150 ease-out
              ${isActive
                ? 'bg-[var(--color-accent)] text-white shadow-sm'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)]'
              }
            `}
            title={`${tab.label} (${tab.shortcut})`}
          >
            <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}

export type { SidebarTab };
