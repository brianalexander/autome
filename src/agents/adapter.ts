import { readFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { AcpProvider, CanonicalAgentSpec } from '../acp/provider/types.js';
import { fromPackage, PROJECT_ROOT } from '../paths.js';

/**
 * Read a canonical agent definition from agents/<name>/
 */
export async function readCanonicalAgent(agentName: string): Promise<{ spec: CanonicalAgentSpec; prompt: string }> {
  const baseDir = fromPackage('agents', agentName);
  const specContent = await readFile(join(baseDir, 'agent.json'), 'utf-8');
  const spec = JSON.parse(specContent) as CanonicalAgentSpec;

  let prompt = '';
  const promptPath = join(baseDir, 'prompt.md');
  if (existsSync(promptPath)) {
    prompt = await readFile(promptPath, 'utf-8');
  }

  return { spec, prompt };
}

/**
 * List all canonical agent names
 */
export async function listCanonicalAgents(): Promise<string[]> {
  const agentsDir = fromPackage('agents');
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Generate provider-native agent configs for all canonical agents.
 * Delegates format/structure entirely to the provider's writeAgentFile method.
 */
export async function generateAgentConfigs(provider: AcpProvider): Promise<{ generated: string[]; errors: string[] }> {
  if (!provider.writeAgentFile) {
    return { generated: [], errors: ['Provider does not support writing agent files'] };
  }

  const agentNames = await listCanonicalAgents();
  const targetDir = provider.getLocalAgentDir(PROJECT_ROOT);
  await mkdir(targetDir, { recursive: true });

  const generated: string[] = [];
  const errors: string[] = [];

  for (const name of agentNames) {
    try {
      const { spec, prompt } = await readCanonicalAgent(name);
      const fileName = await provider.writeAgentFile(targetDir, name, spec, prompt);
      generated.push(`${name} → ${fileName}`);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { generated, errors };
}
