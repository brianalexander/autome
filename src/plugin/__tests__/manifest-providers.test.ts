/**
 * Tests for the extended PluginManifest.providers field.
 *
 * Validates that:
 * - A manifest declaring `providers` causes the loader to load those provider files
 * - Loaded providers appear in the plugin's `providers` array
 * - applyPlugins() returns providers for downstream registration
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPlugins } from '../loader.js';
import { applyPlugins } from '../apply.js';
import { NodeTypeRegistry } from '../../nodes/registry.js';
import { OrchestratorDB } from '../../db/database.js';

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `autome-plugin-providers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** ESM module content for a minimal AcpProvider */
const PROVIDER_MODULE_CONTENT = `
const provider = {
  name: 'test-provider',
  displayName: 'Test Provider',
  supportsSessionResume: false,
  tracksMcpReadiness: false,
  getCommand() { return 'test-cmd'; },
  getSpawnArgs() { return []; },
  getSpawnEnv() { return {}; },
  discoverAgents() { return Promise.resolve([]); },
  getAgentSpec() { return Promise.resolve(null); },
  getLocalAgentDir() { return '/tmp'; },
  getGlobalAgentDir() { return '/tmp'; },
  handleVendorNotification() { return null; },
};
export default provider;
`;

describe('PluginManifest.providers — loader', () => {
  let tempPluginsDir: string;
  let pluginDir: string;
  let originalPluginsDir: string | undefined;

  beforeEach(async () => {
    tempPluginsDir = await makeTempDir();
    pluginDir = join(tempPluginsDir, 'test-plugin');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(join(pluginDir, 'providers'), { recursive: true });

    // Write the provider module
    await writeFile(join(pluginDir, 'providers', 'my-provider.mjs'), PROVIDER_MODULE_CONTENT);

    // Write the plugin manifest referencing the provider
    await writeFile(
      join(pluginDir, 'autome-plugin.json'),
      JSON.stringify({
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        providers: ['./providers/my-provider.mjs'],
      }),
    );

    // Override plugins dir via env variable so loadPlugins() uses our temp dir
    originalPluginsDir = process.env.AUTOME_PLUGINS_DIR;
    process.env.AUTOME_PLUGINS_DIR = tempPluginsDir;
  });

  afterEach(async () => {
    if (originalPluginsDir !== undefined) {
      process.env.AUTOME_PLUGINS_DIR = originalPluginsDir;
    } else {
      delete process.env.AUTOME_PLUGINS_DIR;
    }
    await rm(tempPluginsDir, { recursive: true, force: true });
  });

  it('loads providers declared in the manifest into plugin.providers', async () => {
    const result = await loadPlugins();
    expect(result.failures).toHaveLength(0);
    expect(result.loaded).toHaveLength(1);

    const plugin = result.loaded[0];
    expect(plugin.manifest.id).toBe('test-plugin');
    expect(plugin.providers).toHaveLength(1);
    expect(plugin.providers[0].name).toBe('test-provider');
    expect(plugin.providers[0].getCommand()).toBe('test-cmd');
  });

  it('applyPlugins() returns collected providers for caller to register', async () => {
    const result = await loadPlugins();
    const registry = new NodeTypeRegistry();
    const db = new OrchestratorDB(':memory:');

    const collectedProviders = await applyPlugins(result.loaded, registry, db);
    expect(collectedProviders).toHaveLength(1);
    expect(collectedProviders[0].name).toBe('test-provider');
  });

  it('plugin with no providers field has empty providers array', async () => {
    // Overwrite the manifest to have no providers
    await writeFile(
      join(pluginDir, 'autome-plugin.json'),
      JSON.stringify({
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
      }),
    );

    const result = await loadPlugins();
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0].providers).toEqual([]);
  });
});
