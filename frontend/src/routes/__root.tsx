import { createRootRoute, Outlet, Link, useNavigate } from '@tanstack/react-router';
import { Toaster, toast } from 'sonner';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { Sun, Moon, Monitor, ChevronsUpDown, Bell } from 'lucide-react';
import { useActiveProvider, useAcpProviders, useSetSystemProvider, useApprovals } from '../hooks/queries';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { useWebSocket } from '../hooks/useWebSocket';
import { useQueryClient } from '@tanstack/react-query';

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-text-muted mb-4">404</h1>
        <p className="text-text-secondary mb-6">Page not found</p>
        <Link to="/" className="text-blue-500 hover:text-blue-400 underline">
          ← Back to workflows
        </Link>
      </div>
    </div>
  );
}

function ProviderSelector() {
  const { data: active } = useActiveProvider();
  const { data: providers } = useAcpProviders();
  const { mutate: setProvider } = useSetSystemProvider();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeDropdown = useCallback(() => setOpen(false), []);
  useClickOutside(containerRef, closeDropdown);

  if (!active) return null;

  const isUnconfigured = active.source === 'unconfigured';

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`px-2.5 py-1 rounded-lg text-xs transition-colors flex items-center gap-1 cursor-pointer border ${
          isUnconfigured
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-400 animate-pulse'
            : 'border-border bg-surface text-text-secondary hover:text-text-primary hover:border-text-muted'
        }`}
      >
        {isUnconfigured ? 'Set up ACP' : active.displayName || 'Provider'}
        <ChevronsUpDown size={10} className="opacity-40" />
      </button>
      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-1 rounded-lg shadow-lg z-50 min-w-[180px] border border-border bg-surface overflow-hidden">
          {providers?.map((p) => (
            <button
              key={p.name}
              onClick={() => {
                setProvider(p.name);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                p.name === active.name
                  ? 'bg-surface-tertiary text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
              }`}
            >
              {p.displayName}
              {p.name === active.name && <span className="float-right text-blue-400">✓</span>}
              {p.source === 'plugin' && <span className="text-text-muted ml-1">(plugin)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalBadge() {
  const { data: pendingApprovals } = useApprovals();
  const count = pendingApprovals?.length ?? 0;

  if (count === 0) return null;

  return (
    <Link
      to="/approvals"
      className="relative p-1.5 text-amber-500 hover:text-amber-400 transition-colors"
      title={`${count} pending approval${count !== 1 ? 's' : ''}`}
    >
      <Bell size={16} className="animate-pulse" />
      <span className="absolute -top-0.5 -right-0.5 bg-amber-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
        {count > 9 ? '9+' : count}
      </span>
    </Link>
  );
}

function ThemeToggle() {
  const { mode, setMode } = useTheme();

  const options: { value: ThemeMode; icon: React.ReactNode }[] = [
    { value: 'light', icon: <Sun size={14} /> },
    { value: 'dark', icon: <Moon size={14} /> },
    { value: 'system', icon: <Monitor size={14} /> },
  ];

  return (
    <div className="flex items-center bg-surface-tertiary rounded-lg p-0.5 gap-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setMode(opt.value)}
          className={`px-2 py-1 rounded-md transition-colors ${
            mode === opt.value
              ? 'bg-surface text-text-primary shadow-sm'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
          title={opt.value.charAt(0).toUpperCase() + opt.value.slice(1)}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}

function RootLayout() {
  const { on } = useWebSocket();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Listen for gate_waiting events and show toast notifications
  useEffect(() => {
    const unsub = on('instance:stage_status', (data: unknown) => {
      const d = data as { instanceId?: string; stageId?: string; status?: string; message?: string };
      if (d.status === 'waiting_gate') {
        // Invalidate approvals cache
        queryClient.invalidateQueries({ queryKey: ['approvals'] });
        // Show toast with link
        toast.info(
          d.message || `Gate "${d.stageId}" is waiting for approval`,
          {
            action: {
              label: 'Review',
              onClick: () => navigate({ to: '/approvals' }),
            },
            duration: 10000,
          }
        );
      }
    });
    return unsub;
  }, [on, queryClient]);

  return (
    <div className="h-screen bg-surface text-text-primary flex flex-col overflow-hidden">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-6">
          <h1 className="text-lg font-semibold">
            <Link to="/" className="hover:opacity-80">
              auto<span className="bg-gradient-to-r from-orange-400 to-red-500 bg-clip-text text-transparent">me</span>
            </Link>
          </h1>
          <nav className="flex gap-4 text-sm">
            <Link
              to="/"
              className="text-text-secondary hover:text-text-primary [&.active]:text-text-primary [&.active]:font-medium transition-colors"
            >
              Workflows
            </Link>
            <Link
              to="/instances"
              className="text-text-secondary hover:text-text-primary [&.active]:text-text-primary [&.active]:font-medium transition-colors"
            >
              Instances
            </Link>
            <Link
              to="/approvals"
              className="text-text-secondary hover:text-text-primary [&.active]:text-text-primary [&.active]:font-medium transition-colors"
            >
              Approvals
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <ApprovalBadge />
          <ProviderSelector />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 flex min-h-0 overflow-hidden bg-surface-secondary">
        <Outlet />
      </main>
      <Toaster position="bottom-right" richColors theme="system" />
    </div>
  );
}
