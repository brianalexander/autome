/**
 * Agent node — spawns an ACP agent session, sends a prompt, waits for
 * the agent to call workflow_signal with completion output.
 */
import * as restate from '@restatedev/restate-sdk';
import { buildAgentPrompt } from '../../engine/context-resolver.js';
import type { NodeTypeSpec, StepExecutor, StepExecutorContext, StageOutput } from '../types.js';
import type { AgentOverrides } from '../../types/workflow.js';
import type { WorkflowDefinition } from '../../schemas/pipeline.js';
import { stageIsInCycle } from '../../utils/graph.js';

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: StageOutput }> {
    const { ctx, stageId, config, definition, workflowContext, input, orchestratorUrl, iteration } = execCtx;

    // Find the full stage definition (needed by buildAgentPrompt)
    const stage = definition.stages.find((s) => s.id === stageId);

    // Build the prompt — uses edge prompt_template if available, otherwise stage context_template.
    // Also auto-injects output requirements from downstream edges.
    // For fan-in stages, mergedInputs contains all upstream outputs keyed by source stage ID.
    const prompt = buildAgentPrompt(stage!, workflowContext, iteration, {
      incomingEdge: input?.incomingEdge,
      sourceOutput: input?.sourceOutput,
      mergedInputs: input?.mergedInputs,
      definition,
    });

    // Resolve the effective ACP provider for this stage:
    // stage-level override > workflow-level default > (server uses its own default)
    const stageAcpProvider =
      (config.overrides as AgentOverrides | undefined)?.acpProvider || definition.acpProvider || undefined;

    // Spawn the agent via the orchestrator
    await ctx.run(`spawn-agent-${stageId}-iter-${iteration}`, async () => {
      const response = await fetch(`${orchestratorUrl}/api/internal/spawn-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: ctx.key,
          stageId,
          iteration,
          agentId: config.agentId || '',
          prompt,
          context: workflowContext,
          overrides: config.overrides ?? undefined,
          definitionId: definition.id,
          ...(stageAcpProvider ? { acpProvider: stageAcpProvider } : {}),
          ...(config.timeout_minutes != null ? { timeout_minutes: config.timeout_minutes } : {}),
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ error: 'Unknown error' }))) as { error?: string };
        throw new Error(`Failed to spawn agent: ${error.error || response.statusText}`);
      }

      return response.json();
    });

    // Wait for the agent to call workflow_signal with completed/failed
    const output = await ctx.promise<StageOutput>(`stage-complete-${stageId}`).get();

    // Kill the ACP process — but NOT if cycle_behavior is 'continue' and this stage is in a cycle.
    // For 'continue' mode, the session stays alive for re-entry; it will be cleaned up
    // when the cycle exits (max_iterations reached or no cycle edge taken).
    const cycleBehavior = (config.cycle_behavior as string) || 'fresh';
    const inCycle = stageIsInCycle(stageId, definition.edges);
    if (cycleBehavior !== 'continue' || !inCycle) {
      await ctx.run(`kill-agent-${stageId}-iter-${iteration}`, async () => {
        await fetch(`${orchestratorUrl}/api/internal/kill-agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId: ctx.key, stageId }),
        }).catch(() => {});
        return { killed: true };
      });
    }

    return { output };
  },
};

export const agentNodeSpec: NodeTypeSpec = {
  id: 'agent',
  name: 'Agent',
  category: 'step',
  description: 'AI agent that executes tasks via an ACP session',
  icon: 'bot',
  color: { bg: '#eff6ff', border: '#3b82f6', text: '#2563eb' },
  configSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', title: 'Agent', description: 'Agent ID (discovered from provider agent directory)' },
      max_iterations: {
        type: 'number',
        title: 'Max Iterations',
        description: 'Max re-executions in cycles (default: 5)',
      },
      max_turns: { type: 'number', title: 'Max Turns', description: 'Safety limit on agent conversation turns' },
      timeout_minutes: { type: 'number', title: 'Timeout (minutes)' },
      cycle_behavior: {
        type: 'string',
        title: 'Cycle Behavior',
        description: 'How this agent handles re-entry via cycle edges. "fresh" = new session each cycle. "continue" = resume prior session.',
        enum: ['fresh', 'continue'],
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: "JSON Schema (draft 7) defining the required structure of this agent's output. Injected into the agent prompt at runtime.",
      },
      overrides: {
        type: 'object',
        title: 'Overrides',
        properties: {
          model: { type: 'string', title: 'Model Override' },
          additional_prompt: { type: 'string', title: 'Additional Prompt', format: 'textarea' },
        },
      },
    },
    required: ['agentId', 'output_schema'],
  },
  defaultConfig: { agentId: '', max_iterations: 5 },
  executor,
  inEdgeSchema: {
    type: 'object',
    properties: {
      prompt_template: {
        type: 'string',
        title: 'Prompt Template',
        description: 'Jinja2 prompt template. Use {{ output.field }} to reference source output.',
        format: 'template',
      },
    },
    required: ['prompt_template'],
  },
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: {
        type: 'string',
        title: 'Condition',
        description: 'JS expression evaluated against output (e.g. output.approved === true). Empty = always taken.',
        format: 'code',
      },
    },
  },
};
