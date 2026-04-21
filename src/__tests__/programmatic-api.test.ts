/**
 * Programmatic API test — verifies that node types, plugins, and providers
 * passed to startServer() via the `options` argument appear in the relevant
 * GET endpoints alongside built-in entries.
 *
 * Uses a real startServer() call with an in-memory configuration to avoid
 * filesystem side effects.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NodeTypeSpec, StepExecutor } from '../nodes/types.js';
import type { AcpProvider } from '../acp/provider/types.js';
import { definePlugin } from '../plugin/index.js';

// Mock websocket broadcast so the server starts without WS infrastructure
vi.mock('../api/websocket.js', () => ({
  broadcast: vi.fn(),
  websocketPlugin: async (app: FastifyInstance) => {
    // minimal no-op plugin
  },
}));

// The server imports agent pool internally — avoid actually spawning ACP processes
vi.mock('../acp/pool.js', () => ({
  AgentPool: class {
    terminateAll() { return Promise.resolve(); }
  },
}));

// Mock crash recovery (does DB queries we don't need)
vi.mock('../recovery.js', () => ({
  runCrashRecovery: vi.fn().mockResolvedValue(undefined),
}));

// Mock agent config generation
vi.mock('../agents/adapter.js', () => ({
  generateAgentConfigs: vi.fn().mockResolvedValue({ generated: [], errors: [] }),
}));

// Mock test-run janitor
vi.mock('../workflow/test-run-janitor.js', () => ({
  cleanupOrphanTests: vi.fn(),
}));

// Mock test-run listener
vi.mock('../workflow/test-run-listener.js', () => ({
  startTestRunListener: vi.fn().mockReturnValue(() => {}),
}));

function mockStepSpec(id: string): NodeTypeSpec {
  const executor: StepExecutor = {
    type: 'step',
    async execute() {
      return { output: {} };
    },
  };
  return {
    id,
    name: `Mock ${id}`,
    category: 'step',
    description: `A mock node type for testing (${id})`,
    icon: 'box',
    color: { bg: '#fff', border: '#000', text: '#000' },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    executor,
  };
}

describe('startServer() programmatic registrations', () => {
  let app: FastifyInstance;
  const PORT = 0; // OS-assigned free port

  beforeAll(async () => {
    const { startServer } = await import('../server-start.js');
    const { loadConfig } = await import('../config/loader.js');

    const config = await loadConfig({
      port: PORT,
      host: '127.0.0.1',
      dataDir: '/tmp/autome-programmatic-test',
      mode: 'dev',
    });

    const mockSpec = mockStepSpec('mock-programmatic-node');

    const mockPlugin = definePlugin(
      {
        id: 'mock-plugin',
        name: 'Mock Plugin',
        version: '0.0.1',
      },
      {
        nodeTypes: [mockStepSpec('mock-plugin-node')],
      },
    );

    app = await startServer(config, {
      nodeTypes: [mockSpec],
      plugins: [mockPlugin],
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/node-types includes built-in types', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/node-types' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string }>;
    const ids = body.map((t: { id: string }) => t.id);
    expect(ids).toContain('agent');
    expect(ids).toContain('manual-trigger');
  });

  it('GET /api/node-types includes programmatic node types passed via options.nodeTypes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/node-types' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string }>;
    const ids = body.map((t: { id: string }) => t.id);
    expect(ids).toContain('mock-programmatic-node');
  });

  it('GET /api/node-types includes node types from programmatic plugins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/node-types' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string }>;
    const ids = body.map((t: { id: string }) => t.id);
    expect(ids).toContain('mock-plugin-node');
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal stub that satisfies the AcpProvider interface.
// Only name/displayName matter for the listing endpoint; all other methods
// are no-ops that will never be called during these tests.
// ---------------------------------------------------------------------------
function mockAcpProvider(name: string, displayName: string): AcpProvider {
  return {
    name,
    displayName,
    supportsSessionResume: false,
    tracksMcpReadiness: false,
    getCommand: () => name,
    getSpawnArgs: () => [],
    getSpawnEnv: () => ({}),
    discoverAgents: async () => [],
    getAgentSpec: async () => null,
    getLocalAgentDir: (dir) => dir,
    getGlobalAgentDir: () => '',
    handleVendorNotification: () => null,
  };
}

describe('startServer() programmatic provider registrations', () => {
  let app: FastifyInstance;
  const PORT = 0; // OS-assigned free port

  beforeAll(async () => {
    const { startServer } = await import('../server-start.js');
    const { loadConfig } = await import('../config/loader.js');

    const config = await loadConfig({
      port: PORT,
      host: '127.0.0.1',
      dataDir: '/tmp/autome-programmatic-providers-test',
      mode: 'dev',
    });

    app = await startServer(config, {
      providers: [
        mockAcpProvider('my-custom-provider', 'My Custom Provider'),
        // Override a built-in to verify custom wins on collision.
        mockAcpProvider('kiro', 'Kiro (overridden)'),
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/acp-providers includes built-in providers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/acp-providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ name: string; displayName: string; source: string }>;
    const names = body.map((p) => p.name);
    // opencode and claude-code are not overridden — they must appear as builtins.
    expect(names).toContain('opencode');
    expect(names).toContain('claude-code');
    const opencode = body.find((p) => p.name === 'opencode')!;
    expect(opencode.source).toBe('builtin');
  });

  it('GET /api/acp-providers includes programmatic providers passed via options.providers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/acp-providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ name: string; displayName: string; source: string }>;
    const custom = body.find((p) => p.name === 'my-custom-provider');
    expect(custom).toBeDefined();
    expect(custom!.displayName).toBe('My Custom Provider');
    expect(custom!.source).toBe('custom');
  });

  it('GET /api/acp-providers — custom provider overrides built-in with same name', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/acp-providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ name: string; displayName: string; source: string }>;
    // 'kiro' should appear exactly once (the custom override, not the built-in).
    const kiroEntries = body.filter((p) => p.name === 'kiro');
    expect(kiroEntries).toHaveLength(1);
    expect(kiroEntries[0].source).toBe('custom');
    expect(kiroEntries[0].displayName).toBe('Kiro (overridden)');
  });
});
