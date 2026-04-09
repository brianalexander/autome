import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// We mock 'os' to control homedir() for the global agents path.
// The mock must be hoisted before the module under test is imported.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => actual.homedir()),
  };
});

import { homedir } from 'os';
import { discoverAgents, getAgentSpec } from '../discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAgentFile(dir: string, filename: string, spec: object): Promise<void> {
  await writeFile(join(dir, filename), JSON.stringify(spec), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discoverAgents', () => {
  let tempRoot: string;
  let localDir: string;
  let globalDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'autome-agents-test-'));
    localDir = join(tempRoot, 'local', '.kiro', 'agents');
    globalDir = join(tempRoot, 'global', '.kiro', 'agents');
    await mkdir(localDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });

    // Point homedir() at our temp global dir's parent
    vi.mocked(homedir).mockReturnValue(join(tempRoot, 'global'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('discovers agents from a local directory', async () => {
    await createAgentFile(localDir, 'my-agent.json', {
      name: 'my-agent',
      description: 'A test agent',
      model: 'claude-sonnet-4',
    });

    const agents = await discoverAgents(join(tempRoot, 'local'));

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('my-agent');
    expect(agents[0].source).toBe('local');
    expect(agents[0].spec.description).toBe('A test agent');
    expect(agents[0].spec.model).toBe('claude-sonnet-4');
  });

  it('discovers agents from a global directory', async () => {
    await createAgentFile(globalDir, 'global-agent.json', {
      name: 'global-agent',
      description: 'A global agent',
    });

    // workingDir has no local agents dir
    const agents = await discoverAgents(join(tempRoot, 'local'));

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('global-agent');
    expect(agents[0].source).toBe('global');
  });

  it('local agents take precedence over global agents with the same name', async () => {
    await createAgentFile(localDir, 'shared.json', {
      name: 'shared',
      description: 'Local version',
    });
    await createAgentFile(globalDir, 'shared.json', {
      name: 'shared',
      description: 'Global version',
    });

    const agents = await discoverAgents(join(tempRoot, 'local'));

    const shared = agents.filter((a) => a.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].source).toBe('local');
    expect(shared[0].spec.description).toBe('Local version');
  });

  it('handles missing local directory gracefully', async () => {
    // No local agents dir created; globalDir has one agent
    await createAgentFile(globalDir, 'only-global.json', { name: 'only-global' });

    const noLocalDir = join(tempRoot, 'nonexistent-workspace');
    const agents = await discoverAgents(noLocalDir);

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('only-global');
  });

  it('handles missing global directory gracefully', async () => {
    // Point homedir at a path with no .kiro/agents subdir
    vi.mocked(homedir).mockReturnValue(join(tempRoot, 'no-such-home'));

    await createAgentFile(localDir, 'local-only.json', { name: 'local-only' });

    const agents = await discoverAgents(join(tempRoot, 'local'));
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('local-only');
  });

  it('handles both directories missing gracefully (returns empty array)', async () => {
    vi.mocked(homedir).mockReturnValue(join(tempRoot, 'no-such-home'));

    const agents = await discoverAgents(join(tempRoot, 'also-no-such'));
    expect(agents).toEqual([]);
  });

  it('skips malformed JSON files with a warning and continues', async () => {
    await writeFile(join(localDir, 'bad.json'), 'not valid json', 'utf-8');
    await createAgentFile(localDir, 'good.json', { name: 'good-agent' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agents = await discoverAgents(join(tempRoot, 'local'));

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('good-agent');
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('skips non-JSON files in the agent directory', async () => {
    await writeFile(join(localDir, 'readme.md'), '# ignore me', 'utf-8');
    await createAgentFile(localDir, 'real-agent.json', { name: 'real-agent' });

    const agents = await discoverAgents(join(tempRoot, 'local'));
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('real-agent');
  });

  it('skips agent files with no name field (schema requires name)', async () => {
    // KiroAgentSpecSchema requires name — files without it are skipped with a warning
    await writeFile(join(localDir, 'no-name.json'), JSON.stringify({ description: 'No name field' }), 'utf-8');
    await createAgentFile(localDir, 'has-name.json', { name: 'has-name' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agents = await discoverAgents(join(tempRoot, 'local'));
    warnSpy.mockRestore();

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('has-name');
  });
});

// ---------------------------------------------------------------------------
// getAgentSpec
// ---------------------------------------------------------------------------

describe('getAgentSpec', () => {
  let tempRoot: string;
  let localDir: string;
  let globalDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'autome-agents-test-'));
    localDir = join(tempRoot, 'local', '.kiro', 'agents');
    globalDir = join(tempRoot, 'global', '.kiro', 'agents');
    await mkdir(localDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });
    vi.mocked(homedir).mockReturnValue(join(tempRoot, 'global'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns a specific agent by name', async () => {
    await createAgentFile(localDir, 'target.json', {
      name: 'target',
      model: 'claude-opus-4',
    });
    await createAgentFile(localDir, 'other.json', { name: 'other' });

    const agent = await getAgentSpec('target', join(tempRoot, 'local'));

    expect(agent).not.toBeNull();
    expect(agent!.name).toBe('target');
    expect(agent!.spec.model).toBe('claude-opus-4');
  });

  it('returns null for an unknown agent name', async () => {
    await createAgentFile(localDir, 'existing.json', { name: 'existing' });

    const agent = await getAgentSpec('does-not-exist', join(tempRoot, 'local'));
    expect(agent).toBeNull();
  });

  it('returns the local agent when a global agent with the same name exists', async () => {
    await createAgentFile(localDir, 'overlap.json', {
      name: 'overlap',
      description: 'local',
    });
    await createAgentFile(globalDir, 'overlap.json', {
      name: 'overlap',
      description: 'global',
    });

    const agent = await getAgentSpec('overlap', join(tempRoot, 'local'));
    expect(agent!.source).toBe('local');
    expect(agent!.spec.description).toBe('local');
  });
});
