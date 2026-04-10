/**
 * Tests for bundle export/import modules.
 *
 * Strategy:
 * - Export: mock discoverAgents so we control what agents are "found" without
 *   touching the filesystem, then verify the bundle structure.
 * - Import: use the real exportWorkflow to produce an archive, then importWorkflow
 *   against an in-memory SQLite DB — a real round-trip test.
 * - Health: mock discoverAgents and commandExists to exercise every warning path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports that transitively use them
// ---------------------------------------------------------------------------

vi.mock('../../agents/discovery.js', () => ({
  discoverAgents: vi.fn(async () => []),
  setDefaultProvider: vi.fn(),
  resetDefaultProvider: vi.fn(),
}));

vi.mock('../../utils/shell.js', () => ({
  commandExists: vi.fn(async () => true),
}));

vi.mock('../../acp/provider/registry.js', () => ({
  listProviders: vi.fn(async () => []),
}));

import { discoverAgents } from '../../agents/discovery.js';
import { commandExists } from '../../utils/shell.js';

import { exportWorkflow } from '../export.js';
import { importWorkflow, previewBundle } from '../import.js';
import { checkWorkflowHealth } from '../health.js';
import { OrchestratorDB } from '../../db/database.js';
import type { WorkflowDefinition } from '../../types/workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-test-1',
    name: 'Test Workflow',
    description: 'A test workflow',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
    ...overrides,
  };
}

function makeAgentStage(agentId: string) {
  return {
    id: 'stage_a',
    type: 'agent',
    label: 'Agent A',
    config: { agentId },
  };
}

function makeDiscoveredAgent(name: string, spec: Record<string, unknown> = {}) {
  return {
    name,
    source: 'local' as const,
    path: join(tmpdir(), `${name}.json`),
    spec: { name, model: 'claude-sonnet-4', ...spec },
  };
}

// ---------------------------------------------------------------------------
// exportWorkflow
// ---------------------------------------------------------------------------

describe('exportWorkflow', () => {
  beforeEach(() => {
    vi.mocked(discoverAgents).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports a minimal workflow with no agent stages', async () => {
    const def = makeWorkflow();
    const { archivePath, bundle, warnings } = await exportWorkflow(def);

    expect(archivePath).toMatch(/\.autome$/);
    expect(warnings).toHaveLength(0);

    // Bundle structure
    expect(bundle.name).toBe('Test Workflow');
    expect(bundle.description).toBe('A test workflow');
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bundle.requiredAgents).toEqual([]);
    expect(bundle.workflow).toMatchObject({ name: 'Test Workflow' });

    await rm(archivePath, { force: true });
  });

  it('warns when a referenced agent is not installed locally', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([]);
    const def = makeWorkflow({ stages: [makeAgentStage('missing-agent')] });

    const { bundle, warnings } = await exportWorkflow(def);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe('missing_agent');
    expect(warnings[0].name).toBe('missing-agent');
    // The agent name is still included in requiredAgents even if not installed
    expect(bundle.requiredAgents).toContain('missing-agent');
  });

  it('includes the agent name in requiredAgents when discovered', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([
      makeDiscoveredAgent('my-agent'),
    ]);

    const def = makeWorkflow({ stages: [makeAgentStage('my-agent')] });
    const { bundle, warnings } = await exportWorkflow(def);

    expect(warnings).toHaveLength(0);
    expect(bundle.requiredAgents).toContain('my-agent');
  });

  it('slugifies the workflow name for the archive filename', async () => {
    const def = makeWorkflow({ name: 'My Fancy Workflow 2.0!' });
    const { archivePath } = await exportWorkflow(def);

    expect(archivePath).toMatch(/my-fancy-workflow-2-0\.autome$/);
    await rm(archivePath, { force: true });
  });

  it('deduplicates agents referenced multiple times across stages', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([
      makeDiscoveredAgent('shared-agent'),
    ]);

    const def = makeWorkflow({
      stages: [
        { id: 'stage_a', type: 'agent', config: { agentId: 'shared-agent' } },
        { id: 'stage_b', type: 'agent', config: { agentId: 'shared-agent' } },
      ],
    });

    const { bundle, archivePath } = await exportWorkflow(def);

    // Only one entry for shared-agent
    expect(bundle.requiredAgents).toEqual(['shared-agent']);
    await rm(archivePath, { force: true });
  });

  it('writes a valid JSON file to disk', async () => {
    const def = makeWorkflow({ stages: [makeAgentStage('my-agent')] });
    vi.mocked(discoverAgents).mockResolvedValue([makeDiscoveredAgent('my-agent')]);

    const { archivePath } = await exportWorkflow(def);

    const { readFile } = await import('fs/promises');
    const raw = await readFile(archivePath, 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.name).toBe('Test Workflow');
    expect(parsed.requiredAgents).toContain('my-agent');
    expect(parsed.workflow).toBeDefined();

    await rm(archivePath, { force: true });
  });
});

// ---------------------------------------------------------------------------
// previewBundle
// ---------------------------------------------------------------------------

describe('previewBundle', () => {
  it('returns bundle and workflow summary without importing', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([]);

    const def = makeWorkflow({
      stages: [makeAgentStage('some-agent')],
      edges: [{ id: 'e1', source: 'start', target: 'stage_a' }],
    });

    const { archivePath, bundle: exportedBundle } = await exportWorkflow(def);

    const preview = await previewBundle(archivePath);

    expect(preview.bundle.name).toBe(exportedBundle.name);
    expect(preview.bundle.requiredAgents).toEqual(exportedBundle.requiredAgents);
    expect(preview.workflow.name).toBe(def.name);
    expect(preview.workflow.stageCount).toBe(1);
    expect(preview.workflow.edgeCount).toBe(1);

    await rm(archivePath, { force: true });
  });

  it('throws a clear error on invalid JSON', async () => {
    const badPath = join(tmpdir(), 'bad-bundle.autome');
    await writeFile(badPath, 'not valid json', 'utf-8');

    await expect(previewBundle(badPath)).rejects.toThrow('Invalid bundle file');

    await rm(badPath, { force: true });
  });

  it('throws when workflow or name is missing', async () => {
    const badPath = join(tmpdir(), 'incomplete-bundle.autome');
    await writeFile(badPath, JSON.stringify({ name: 'No Workflow' }), 'utf-8');

    await expect(previewBundle(badPath)).rejects.toThrow('Invalid bundle');

    await rm(badPath, { force: true });
  });
});

// ---------------------------------------------------------------------------
// importWorkflow (round-trip)
// ---------------------------------------------------------------------------

describe('importWorkflow', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = new OrchestratorDB(':memory:');
    vi.mocked(discoverAgents).mockResolvedValue([]);
    vi.mocked(commandExists).mockResolvedValue(true);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('creates the workflow in the database', async () => {
    const def = makeWorkflow({ name: 'Import Me' });
    const { archivePath } = await exportWorkflow(def);

    const result = await importWorkflow(archivePath, db);

    expect(result.workflowId).toBeTruthy();
    expect(result.warnings).toHaveLength(0);

    const { data: workflows, total } = db.listWorkflows();
    expect(total).toBe(1);
    expect(workflows[0].name).toBe('Import Me');

    await rm(archivePath, { force: true });
  });

  it('round-trip: export → import produces equivalent workflow name and stages', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([makeDiscoveredAgent('existing-agent')]);

    const def = makeWorkflow({
      name: 'Round Trip',
      stages: [makeAgentStage('existing-agent')],
    });

    const { archivePath } = await exportWorkflow(def);
    const result = await importWorkflow(archivePath, db);

    const { data: workflows } = db.listWorkflows();
    const imported = workflows.find((w) => w.id === result.workflowId);
    expect(imported).toBeDefined();
    expect(imported!.name).toBe('Round Trip');
    expect(imported!.stages).toHaveLength(1);

    await rm(archivePath, { force: true });
  });

  it('assigns a new workflow ID on import (does not reuse the source ID)', async () => {
    const def = makeWorkflow({ id: 'original-id', name: 'ID Test' });
    const { archivePath } = await exportWorkflow(def);

    const result = await importWorkflow(archivePath, db);

    expect(result.workflowId).not.toBe('original-id');
    await rm(archivePath, { force: true });
  });

  it('throws when a required agent is missing and force is not set', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([]);

    const def = makeWorkflow({ stages: [makeAgentStage('missing-agent')] });
    const { archivePath } = await exportWorkflow(def);

    // Re-mock so the agent is discovered during export but not during import
    vi.mocked(discoverAgents).mockResolvedValue([]);

    // The bundle has missing-agent in requiredAgents (from export with warning)
    await expect(importWorkflow(archivePath, db)).rejects.toThrow('missing required agents');

    await rm(archivePath, { force: true });
  });

  it('succeeds with a warning when force=true and agents are missing', async () => {
    // Export with the agent "missing" so it ends up in requiredAgents
    vi.mocked(discoverAgents).mockResolvedValue([]);
    const def = makeWorkflow({ stages: [makeAgentStage('missing-agent')] });
    const { archivePath } = await exportWorkflow(def);

    const result = await importWorkflow(archivePath, db, { force: true });

    expect(result.workflowId).toBeTruthy();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe('missing_agent');
    expect(result.warnings[0].name).toBe('missing-agent');

    await rm(archivePath, { force: true });
  });

  it('throws a clear error on invalid JSON', async () => {
    const badPath = join(tmpdir(), 'bad-import.autome');
    await writeFile(badPath, 'not valid json', 'utf-8');

    await expect(importWorkflow(badPath, db)).rejects.toThrow('Invalid bundle file');

    await rm(badPath, { force: true });
  });
});

// ---------------------------------------------------------------------------
// checkWorkflowHealth
// ---------------------------------------------------------------------------

describe('checkWorkflowHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns healthy=true with no warnings for a workflow with no agent stages', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([]);
    const def = makeWorkflow();

    const result = await checkWorkflowHealth(def);

    expect(result.healthy).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('warns with missing_agent when agent stage references an unknown agent', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([]);
    const def = makeWorkflow({ stages: [makeAgentStage('nonexistent')] });

    const result = await checkWorkflowHealth(def);

    expect(result.healthy).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe('missing_agent');
    expect(result.warnings[0].severity).toBe('error');
    expect(result.warnings[0].agentId).toBe('nonexistent');
  });

  it('warns with missing_mcp_command when an MCP server command is not found', async () => {
    const agentSpec = {
      mcpServers: {
        git: { command: 'git-mcp', args: [] },
      },
    };
    vi.mocked(discoverAgents).mockResolvedValue([makeDiscoveredAgent('mcp-agent', agentSpec)]);
    vi.mocked(commandExists).mockImplementation(async (cmd) => cmd !== 'git-mcp');

    const def = makeWorkflow({ stages: [makeAgentStage('mcp-agent')] });
    const result = await checkWorkflowHealth(def);

    expect(result.healthy).toBe(false);
    const warning = result.warnings.find((w) => w.type === 'missing_mcp_command');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('error');
    expect(warning!.agentId).toBe('mcp-agent');
  });

  it('warns with missing_hook_command when a hook binary is not found', async () => {
    const agentSpec = {
      hooks: {
        postRun: [{ command: 'some-exotic-tool ./scripts/run.sh' }],
      },
    };
    vi.mocked(discoverAgents).mockResolvedValue([makeDiscoveredAgent('hook-agent', agentSpec)]);
    vi.mocked(commandExists).mockImplementation(async (cmd) => cmd !== 'some-exotic-tool');

    const def = makeWorkflow({ stages: [makeAgentStage('hook-agent')] });
    const result = await checkWorkflowHealth(def);

    expect(result.healthy).toBe(false);
    const warning = result.warnings.find((w) => w.type === 'missing_hook_command');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });

  it('warns about missing secret env vars with known secret key patterns', async () => {
    const agentSpec = {
      mcpServers: {
        myServer: {
          command: 'my-mcp-server',
          args: [],
          env: { MY_API_KEY: '${MY_API_KEY}' },
        },
      },
    };
    vi.mocked(discoverAgents).mockResolvedValue([makeDiscoveredAgent('secret-agent', agentSpec)]);
    vi.mocked(commandExists).mockResolvedValue(true);

    const saved = process.env.MY_API_KEY;
    delete process.env.MY_API_KEY;

    try {
      const def = makeWorkflow({ stages: [makeAgentStage('secret-agent')] });
      const result = await checkWorkflowHealth(def);

      const secretWarning = result.warnings.find((w) => w.type === 'missing_secret');
      expect(secretWarning).toBeDefined();
      expect(secretWarning!.severity).toBe('warning');
    } finally {
      if (saved !== undefined) process.env.MY_API_KEY = saved;
    }
  });

  it('does not warn about secrets that are already set', async () => {
    const agentSpec = {
      mcpServers: {
        myServer: {
          command: 'my-mcp-server',
          args: [],
          env: { MY_API_KEY: '${MY_API_KEY}' },
        },
      },
    };
    vi.mocked(discoverAgents).mockResolvedValue([makeDiscoveredAgent('set-secret-agent', agentSpec)]);
    vi.mocked(commandExists).mockResolvedValue(true);

    process.env.MY_API_KEY = 'already-set';
    try {
      const def = makeWorkflow({ stages: [makeAgentStage('set-secret-agent')] });
      const result = await checkWorkflowHealth(def);

      const secretWarning = result.warnings.find((w) => w.type === 'missing_secret');
      expect(secretWarning).toBeUndefined();
    } finally {
      delete process.env.MY_API_KEY;
    }
  });

  it('returns healthy=true when all commands exist and secrets are set', async () => {
    const agentSpec = {
      mcpServers: {
        git: { command: 'git', args: [] },
      },
      hooks: {
        postRun: [{ command: 'bash ./scripts/setup.sh' }],
      },
    };
    vi.mocked(discoverAgents).mockResolvedValue([makeDiscoveredAgent('healthy-agent', agentSpec)]);
    vi.mocked(commandExists).mockResolvedValue(true);

    const def = makeWorkflow({ stages: [makeAgentStage('healthy-agent')] });
    const result = await checkWorkflowHealth(def);

    expect(result.healthy).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
