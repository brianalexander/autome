/**
 * Gate node — approval checkpoint. Manual (human approval), conditional
 * (JS expression), or auto (pass-through).
 */
import * as restate from '@restatedev/restate-sdk';
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { safeEvalCondition } from '../../engine/safe-eval.js';

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown }> {
    const { ctx, stageId, config, orchestratorUrl, workflowContext } = execCtx;
    const gateType = (config.type as string) || 'auto';

    if (gateType === 'manual') {
      ctx.set('status', 'waiting_gate');

      // Broadcast gate-waiting status to WebSocket clients and schedule timeout if configured
      await ctx.run(`broadcast-gate-${stageId}`, async () => {
        await fetch(`${orchestratorUrl}/api/internal/workflow-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceId: ctx.key,
            stageId,
            status: 'waiting_gate',
            message: (config.message as string) || 'Waiting for approval',
            timeout_minutes: (config.timeout_minutes as number) ?? undefined,
            timeout_action: (config.timeout_action as string) ?? 'reject',
          }),
        }).catch(() => {});
        return { waiting: true };
      });

      // Wait for approval via durable promise
      const approved = await ctx.promise<boolean>(`gate-${stageId}`).get();

      if (!approved) {
        throw new restate.TerminalError(`Gate "${stageId}" was rejected`);
      }

      ctx.set('status', 'running');
    } else if (gateType === 'conditional') {
      const condition = config.condition as string;
      const passed = await ctx.run(`eval-gate-${stageId}`, () => {
        return safeEvalCondition(condition, { context: workflowContext });
      });

      if (!passed) {
        throw new restate.TerminalError(`Gate condition failed for "${stageId}": ${condition}`);
      }
    }
    // Auto gates just pass through

    return { output: { approved: true } };
  },
};

export const gateNodeSpec: NodeTypeSpec = {
  id: 'gate',
  name: 'Gate',
  category: 'step',
  description: 'Approval or conditional checkpoint',
  icon: '🚧',
  color: { bg: '#fff1f2', border: '#f43f5e', text: '#e11d48' },
  configSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        title: 'Gate Type',
        enum: ['manual', 'conditional', 'auto'],
        default: 'manual',
      },
      condition: { type: 'string', title: 'Condition', description: 'JS expression (for conditional gates)' },
      message: { type: 'string', title: 'Message', description: 'Shown to the human reviewer (for manual gates)' },
      timeout_minutes: { type: 'number', title: 'Timeout (minutes)' },
      timeout_action: {
        type: 'string',
        title: 'Timeout Action',
        enum: ['approve', 'reject'],
      },
    },
  },
  defaultConfig: { type: 'manual' },
  executor,
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: {
        type: 'string',
        title: 'Condition',
        description: 'JS expression. Empty = always taken.',
        format: 'code',
      },
    },
  },
};
