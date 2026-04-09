/**
 * Tests for bundle export/import/health modules.
 *
 * Strategy:
 * - Export: mock discoverAgents so we control what agents are "found" without
 *   touching the filesystem, then verify the manifest structure and archive.
 * - Import: use the real exportWorkflow to produce an archive, then importWorkflow
 *   against an in-memory SQLite DB — a real round-trip test.
 * - Health: mock discoverAgents and commandExists to exercise every warning path.
 * - Pure helpers (classifyPathOrigin, stripRootAnchor) tested directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
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
import { listProviders } from '../../acp/provider/registry.js';

import { exportWorkflow } from '../export.js';
import { importWorkflow, previewBundle } from '../import.js';
import { checkWorkflowHealth } from '../health.js';
import { classifyPathOrigin, stripRootAnchor, BUNDLE_FORMAT_VERSION } from '../types.js';
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

function makeDiscoveredAgent(name: string, spec: Record<string, unknown> = {}, dir: string = '/tmp') {
  return {
    name,
    source: 'local' as const,
    path: join(dir, `${name}.json`),
    spec: { name, model: 'claude-sonnet-4', ...spec },
  };
}

// ---------------------------------------------------------------------------
// classifyPathOrigin (pure)
// ---------------------------------------------------------------------------

describe('classifyPathOrigin', () => {
  it('classifies home-relative URIs as "home"', () => {
    expect(classifyPathOrigin('file://~/docs/file.md')).toBe('home');
    expect(classifyPathOrigin('skill://~/skill.md')).toBe('home');
  });

  it('classifies absolute URIs as "abs"', () => {
    expect(classifyPathOrigin('file:///etc/config.json')).toBe('abs');
    expect(classifyPathOrigin('skill:///opt/skill.md')).toBe('abs');
  });

  it('classifies relative URIs as "rel"', () => {
    expect(classifyPathOrigin('file://./docs/a.md')).toBe('rel');
    expect(classifyPathOrigin('file://docs/a.md')).toBe('rel');
    expect(classifyPathOrigin('skill://skills/do-thing.md')).toBe('rel');
  });
});

// ---------------------------------------------------------------------------
// stripRootAnchor (pure)
// ---------------------------------------------------------------------------

describe('stripRootAnchor', () => {
  it('strips ~/  prefix', () => {
    expect(stripRootAnchor('~/docs/a.md')).toBe('docs/a.md');
  });

  it('strips ./  prefix', () => {
    expect(stripRootAnchor('./docs/a.md')).toBe('docs/a.md');
  });

  it('strips leading / for absolute paths', () => {
    expect(stripRootAnchor('/etc/config.json')).toBe('etc/config.json');
  });

  it('leaves bare relative paths unchanged', () => {
    expect(stripRootAnchor('docs/a.md')).toBe('docs/a.md');
  });
});

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
    const { archivePath, manifest, warnings } = await exportWorkflow(def);

    expect(archivePath).toMatch(/\.autome$/);
    expect(warnings).toHaveLength(0);

    // Manifest structure
    expect(manifest.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(manifest.name).toBe('Test Workflow');
    expect(manifest.description).toBe('A test workflow');
    expect(manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.agents).toEqual({});
    expect(manifest.requirements.mcpServers).toEqual([]);
    expect(manifest.requirements.systemDependencies).toEqual([]);
    expect(manifest.requirements.secrets).toEqual([]);

    // Clean up
    await rm(archivePath, { force: true });
  });

  it('warns and skips an agent stage whose agent is not discovered', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([]);
    const def = makeWorkflow({ stages: [makeAgentStage('missing-agent')] });

    const { manifest, warnings } = await exportWorkflow(def);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe('missing_agent');
    expect(warnings[0].agentId).toBe('missing-agent');
    expect(manifest.agents).not.toHaveProperty('missing-agent');
  });

  it('includes a discovered agent in the manifest', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'autome-export-test-'));
    try {
      // Write the agent spec to disk so the export code can copy it
      const agentSpec = { name: 'my-agent', model: 'claude-sonnet-4' };
      const agentPath = join(tempDir, 'my-agent.json');
      await writeFile(agentPath, JSON.stringify(agentSpec), 'utf-8');

      vi.mocked(discoverAgents).mockResolvedValue([
        makeDiscoveredAgent('my-agent', {}, tempDir),
      ]);

      const def = makeWorkflow({ stages: [makeAgentStage('my-agent')] });
      const { manifest, warnings, archivePath } = await exportWorkflow(def, { workingDir: tempDir });

      expect(warnings).toHaveLength(0);
      expect(manifest.agents).toHaveProperty('my-agent');
      expect(manifest.agents['my-agent'].spec).toBe('agents/my-agent.json');

      await rm(archivePath, { force: true });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('collects MCP server commands and secrets from agent spec', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'autome-export-mcp-'));
    try {
      const agentSpec = {
        name: 'mcp-agent',
        model: 'claude-sonnet-4',
        mcpServers: {
          git: { command: 'git-mcp', args: [], env: { GIT_TOKEN: 'secret123' } },
        },
      };
      await writeFile(join(tempDir, 'mcp-agent.json'), JSON.stringify(agentSpec), 'utf-8');

      vi.mocked(discoverAgents).mockResolvedValue([
        makeDiscoveredAgent('mcp-agent', agentSpec, tempDir),
      ]);

      const def = makeWorkflow({ stages: [makeAgentStage('mcp-agent')] });
      const { manifest, archivePath } = await exportWorkflow(def, { workingDir: tempDir });

      expect(manifest.requirements.mcpServers).toContain('git-mcp');
      expect(manifest.requirements.secrets).toContain('GIT_TOKEN');

      await rm(archivePath, { force: true });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('slugifies the workflow name for the archive filename', async () => {
    const def = makeWorkflow({ name: 'My Fancy Workflow 2.0!' });
    const { archivePath } = await exportWorkflow(def);

    expect(archivePath).toMatch(/my-fancy-workflow-2-0\.autome$/);
    await rm(archivePath, { force: true });
  });

  it('deduplicates agents referenced multiple times across stages', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'autome-dedup-'));
    try {
      const agentSpec = { name: 'shared-agent', model: 'claude-sonnet-4' };
      await writeFile(join(tempDir, 'shared-agent.json'), JSON.stringify(agentSpec), 'utf-8');

      vi.mocked(discoverAgents).mockResolvedValue([
        makeDiscoveredAgent('shared-agent', {}, tempDir),
      ]);

      const def = makeWorkflow({
        stages: [
          { id: 'stage_a', type: 'agent', config: { agentId: 'shared-agent' } },
          { id: 'stage_b', type: 'agent', config: { agentId: 'shared-agent' } },
        ],
      });

      const { manifest, archivePath } = await exportWorkflow(def, { workingDir: tempDir });

      // Only one entry for shared-agent
      expect(Object.keys(manifest.agents)).toHaveLength(1);
      await rm(archivePath, { force: true });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// previewBundle
// ---------------------------------------------------------------------------

describe('previewBundle', () => {
  it('returns manifest and workflow summary without importing', async () => {
    vi.mocked(discoverAgents).mockResolvedValue([]);

    const def = makeWorkflow({
      stages: [makeAgentStage('some-agent')],
      edges: [{ id: 'e1', source: 'start', target: 'stage_a' }],
    });

    const { archivePath, manifest: exportedManifest } = await exportWorkflow(def);

    const preview = await previewBundle(archivePath);

    expect(preview.manifest.name).toBe(exportedManifest.name);
    expect(preview.manifest.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(preview.workflow.name).toBe(def.name);
    expect(preview.workflow.stageCount).toBe(1);
    expect(preview.workflow.edgeCount).toBe(1);

    await rm(archivePath, { force: true });
  });
});

// ---------------------------------------------------------------------------
// importWorkflow (round-trip)
// ---------------------------------------------------------------------------

describe('importWorkflow', () => {
  let db: OrchestratorDB;
  let bundlesDir: string;

  beforeEach(async () => {
    db = new OrchestratorDB(':memory:');
    bundlesDir = await mkdtemp(join(tmpdir(), 'autome-bundles-'));
    vi.mocked(discoverAgents).mockResolvedValue([]);
    vi.mocked(commandExists).mockResolvedValue(true);
    vi.mocked(listProviders).mockResolvedValue([]);
  });

  afterEach(async () => {
    db.close();
    await rm(bundlesDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('extracts workflow definition and creates it in the database', async () => {
    const def = makeWorkflow({ name: 'Import Me' });
    const { archivePath } = await exportWorkflow(def);

    const result = await importWorkflow(archivePath, db, { bundlesDir });

    expect(result.workflowId).toBeTruthy();
    expect(result.importedAgents).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);

    const { data: workflows, total } = db.listWorkflows();
    expect(total).toBe(1);
    expect(workflows[0].name).toBe('Import Me');

    await rm(archivePath, { force: true });
  });

  it('round-trip: export → import produces equivalent workflow name and stages', async () => {
    const def = makeWorkflow({
      name: 'Round Trip',
      stages: [makeAgentStage('missing-agent')],
    });

    const { archivePath } = await exportWorkflow(def);
    const result = await importWorkflow(archivePath, db, { bundlesDir });

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

    const result = await importWorkflow(archivePath, db, { bundlesDir });

    expect(result.workflowId).not.toBe('original-id');
    await rm(archivePath, { force: true });
  });

  it('throws when the archive is missing bundle.json', async () => {
    // Create a tar.gz without bundle.json
    const fakeArchive = join(tmpdir(), 'bad-bundle.autome');
    const stagingDir = await mkdtemp(join(tmpdir(), 'bad-staging-'));
    try {
      await writeFile(join(stagingDir, 'workflow.json'), '{}', 'utf-8');
      const tar = await import('tar');
      await tar.create({ gzip: true, file: fakeArchive, cwd: stagingDir }, ['.']);

      await expect(importWorkflow(fakeArchive, db, { bundlesDir })).rejects.toThrow(
        'missing bundle.json manifest',
      );
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(fakeArchive, { force: true });
    }
  });

  it('throws when the bundle format version is too new', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'future-staging-'));
    const fakeArchive = join(tmpdir(), 'future-bundle.autome');
    try {
      const manifest = {
        formatVersion: BUNDLE_FORMAT_VERSION + 999,
        name: 'Future',
        exportedAt: new Date().toISOString(),
        agents: {},
        requirements: { mcpServers: [], systemDependencies: [], secrets: [] },
      };
      await writeFile(join(stagingDir, 'bundle.json'), JSON.stringify(manifest), 'utf-8');
      await writeFile(
        join(stagingDir, 'workflow.json'),
        JSON.stringify(makeWorkflow()),
        'utf-8',
      );
      const tar = await import('tar');
      await tar.create({ gzip: true, file: fakeArchive, cwd: stagingDir }, ['.']);

      await expect(importWorkflow(fakeArchive, db, { bundlesDir })).rejects.toThrow(
        'newer than supported version',
      );
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(fakeArchive, { force: true });
    }
  });

  it('warns about missing system dependencies', async () => {
    vi.mocked(commandExists).mockImplementation(async (cmd) => cmd !== 'bash');

    const stagingDir = await mkdtemp(join(tmpdir(), 'dep-staging-'));
    const fakeArchive = join(tmpdir(), 'dep-bundle.autome');
    try {
      const manifest = {
        formatVersion: BUNDLE_FORMAT_VERSION,
        name: 'Dep Test',
        exportedAt: new Date().toISOString(),
        agents: {},
        requirements: {
          mcpServers: [],
          systemDependencies: ['bash'],
          secrets: [],
        },
      };
      await writeFile(join(stagingDir, 'bundle.json'), JSON.stringify(manifest), 'utf-8');
      await writeFile(
        join(stagingDir, 'workflow.json'),
        JSON.stringify(makeWorkflow()),
        'utf-8',
      );
      const tar = await import('tar');
      await tar.create({ gzip: true, file: fakeArchive, cwd: stagingDir }, ['.']);

      const result = await importWorkflow(fakeArchive, db, { bundlesDir });

      expect(result.warnings.some((w) => w.type === 'missing_dependency')).toBe(true);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(fakeArchive, { force: true });
    }
  });

  it('warns about missing MCP server commands', async () => {
    vi.mocked(commandExists).mockImplementation(async (cmd) => cmd !== 'git-mcp');

    const stagingDir = await mkdtemp(join(tmpdir(), 'mcp-staging-'));
    const fakeArchive = join(tmpdir(), 'mcp-bundle.autome');
    try {
      const manifest = {
        formatVersion: BUNDLE_FORMAT_VERSION,
        name: 'MCP Test',
        exportedAt: new Date().toISOString(),
        agents: {},
        requirements: {
          mcpServers: ['git-mcp'],
          systemDependencies: [],
          secrets: [],
        },
      };
      await writeFile(join(stagingDir, 'bundle.json'), JSON.stringify(manifest), 'utf-8');
      await writeFile(
        join(stagingDir, 'workflow.json'),
        JSON.stringify(makeWorkflow()),
        'utf-8',
      );
      const tar = await import('tar');
      await tar.create({ gzip: true, file: fakeArchive, cwd: stagingDir }, ['.']);

      const result = await importWorkflow(fakeArchive, db, { bundlesDir });

      expect(result.warnings.some((w) => w.type === 'missing_mcp_server')).toBe(true);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(fakeArchive, { force: true });
    }
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
      name: 'mcp-agent',
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
      name: 'hook-agent',
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
      name: 'secret-agent',
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

    // Ensure the env var is not set
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
      name: 'set-secret-agent',
      mcpServers: {
        myServer: {
          command: 'my-mcp-server',
          args: [],
          env: { MY_API_KEY: '${MY_API_KEY}' },
        },
      },
    };
    vi.mocked(discoverAgents).mockResolvedValue([
      makeDiscoveredAgent('set-secret-agent', agentSpec),
    ]);
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
      name: 'healthy-agent',
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
