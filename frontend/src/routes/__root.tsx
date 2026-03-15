import { createRootRoute, Outlet, Link } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { Sun, Moon, Monitor, ChevronsUpDown } from 'lucide-react';
import { useActiveProvider, useAcpProviders, useSetSystemProvider } from '../hooks/queries';
import { useState, useRef, useCallback } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';

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
        <a href="/" className="text-blue-500 hover:text-blue-400 underline">
          ← Back to workflows
        </a>
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
          </nav>
        </div>
        <div className="flex items-center gap-2">
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
