import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  discoverCustomNodes,
  discoverCustomNodesCached,
  resetCustomNodeCache,
} from '../loader.js';
import type { CustomNodeManifest } from '../loader.js';

// Helper: create a unique temp directory for each test
async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `autome-custom-nodes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('discoverCustomNodes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    resetCustomNodeCache();
  });

  it('returns empty array when directories do not exist', async () => {
    const nonExistent = join(tmpdir(), 'autome-no-such-dir-ever');
    const result = await discoverCustomNodes([nonExistent]);
    expect(result).toEqual([]);
  });

  it('returns empty array for an empty directory', async () => {
    const result = await discoverCustomNodes([tempDir]);
    expect(result).toEqual([]);
  });

  it('loads a valid JSON manifest as a step node', async () => {
    const manifest: CustomNodeManifest = {
      id: 'my-custom-step',
      name: 'My Custom Step',
      category: 'step',
      description: 'Does something custom',
      icon: '🔧',
      color: { bg: '#fff', border: '#ccc', text: '#333' },
    };
    await writeFile(join(tempDir, 'my-custom-step.json'), JSON.stringify(manifest));

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(1);
    const spec = result[0];
    expect(spec.id).toBe('my-custom-step');
    expect(spec.name).toBe('My Custom Step');
    expect(spec.category).toBe('step');
    expect(spec.description).toBe('Does something custom');
    expect(spec.icon).toBe('🔧');
    expect(spec.executor.type).toBe('step');
  });

  it('loads a valid JSON manifest as a trigger node', async () => {
    const manifest: CustomNodeManifest = {
      id: 'my-custom-trigger',
      name: 'My Custom Trigger',
      category: 'trigger',
      description: 'Starts things',
    };
    await writeFile(join(tempDir, 'my-custom-trigger.json'), JSON.stringify(manifest));

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(1);
    expect(result[0].executor.type).toBe('trigger');
  });

  it('uses default icon and color when not specified in JSON manifest', async () => {
    const manifest: CustomNodeManifest = {
      id: 'minimal-node',
      name: 'Minimal',
      category: 'step',
      description: 'Minimal spec',
    };
    await writeFile(join(tempDir, 'minimal-node.json'), JSON.stringify(manifest));

    const result = await discoverCustomNodes([tempDir]);
    expect(result[0].icon).toBe('🧩');
    expect(result[0].color).toEqual({ bg: '#f3f4f6', border: '#9ca3af', text: '#6b7280' });
  });

  it('JSON step executor passes through sourceOutput', async () => {
    const manifest: CustomNodeManifest = {
      id: 'passthrough-node',
      name: 'Passthrough',
      category: 'step',
      description: 'Returns its input',
    };
    await writeFile(join(tempDir, 'passthrough.json'), JSON.stringify(manifest));

    const result = await discoverCustomNodes([tempDir]);
    const spec = result[0];
    if (spec.executor.type !== 'step') throw new Error('Expected step executor');

    const output = await spec.executor.execute({
      // Minimal context — only input is needed for the passthrough
      ctx: {} as never,
      stageId: 'test-stage',
      config: {},
      definition: {} as never,
      workflowContext: {} as never,
      orchestratorUrl: 'http://localhost',
      iteration: 0,
      input: { sourceOutput: { value: 42 } },
    });
    expect(output).toEqual({ output: { value: 42 } });
  });

  it('JSON step executor returns empty object when input is absent', async () => {
    const manifest: CustomNodeManifest = {
      id: 'no-input-node',
      name: 'No Input',
      category: 'step',
      description: '',
    };
    await writeFile(join(tempDir, 'no-input.json'), JSON.stringify(manifest));

    const result = await discoverCustomNodes([tempDir]);
    const spec = result[0];
    if (spec.executor.type !== 'step') throw new Error('Expected step executor');

    const output = await spec.executor.execute({
      ctx: {} as never,
      stageId: 's',
      config: {},
      definition: {} as never,
      workflowContext: {} as never,
      orchestratorUrl: '',
      iteration: 0,
      input: undefined,
    });
    expect(output).toEqual({ output: {} });
  });

  it('skips JSON spec missing required id field', async () => {
    const bad = { name: 'No ID', category: 'step', description: '' };
    await writeFile(join(tempDir, 'bad.json'), JSON.stringify(bad));

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(0);
  });

  it('skips JSON spec missing required name field', async () => {
    const bad = { id: 'no-name', category: 'step', description: '' };
    await writeFile(join(tempDir, 'bad.json'), JSON.stringify(bad));

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(0);
  });

  it('skips JSON spec missing required category field', async () => {
    const bad = { id: 'no-category', name: 'No Category', description: '' };
    await writeFile(join(tempDir, 'bad.json'), JSON.stringify(bad));

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(0);
  });

  it('skips files with unrecognised extensions', async () => {
    await writeFile(join(tempDir, 'node.yaml'), 'id: yaml-node\n');
    await writeFile(join(tempDir, 'node.txt'), 'id: txt-node');

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(0);
  });

  it('skips malformed JSON files without crashing', async () => {
    await writeFile(join(tempDir, 'broken.json'), '{ not valid json ;;;');

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(0);
  });

  it('loads multiple JSON specs from the same directory', async () => {
    for (const id of ['alpha', 'beta', 'gamma']) {
      const manifest: CustomNodeManifest = { id, name: id, category: 'step', description: '' };
      await writeFile(join(tempDir, `${id}.json`), JSON.stringify(manifest));
    }

    const result = await discoverCustomNodes([tempDir]);
    expect(result).toHaveLength(3);
    const ids = result.map((s) => s.id).sort();
    expect(ids).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('loads specs from multiple directories', async () => {
    const dir2 = await makeTempDir();
    try {
      const m1: CustomNodeManifest = { id: 'node-a', name: 'A', category: 'step', description: '' };
      const m2: CustomNodeManifest = { id: 'node-b', name: 'B', category: 'trigger', description: '' };
      await writeFile(join(tempDir, 'node-a.json'), JSON.stringify(m1));
      await writeFile(join(dir2, 'node-b.json'), JSON.stringify(m2));

      const result = await discoverCustomNodes([tempDir, dir2]);
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.id).sort()).toEqual(['node-a', 'node-b']);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});

describe('discoverCustomNodesCached', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    resetCustomNodeCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    resetCustomNodeCache();
  });

  it('returns same array instance on repeated calls (cache hit)', async () => {
    const first = await discoverCustomNodesCached();
    const second = await discoverCustomNodesCached();
    expect(first).toBe(second);
  });

  it('resetCustomNodeCache clears the cache so next call re-discovers', async () => {
    const before = await discoverCustomNodesCached();
    resetCustomNodeCache();

    // Write a new spec file between the two calls
    const manifest: CustomNodeManifest = { id: 'after-reset', name: 'After Reset', category: 'step', description: '' };
    await writeFile(join(tempDir, 'after-reset.json'), JSON.stringify(manifest));

    // discoverCustomNodesCached uses default CUSTOM_NODE_DIRS, which won't include tempDir.
    // We just verify that after reset the cache is fresh (a new array is returned).
    const after = await discoverCustomNodesCached();
    expect(after).not.toBe(before);
  });
});
