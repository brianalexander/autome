/**
 * Gate node — approval checkpoint. Manual (human approval), conditional
 * (JS expression), or auto (pass-through).
 */
import { TerminalError } from '../../engine/types.js';
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { safeEvalCondition } from '../../engine/safe-eval.js';

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown }> {
    const { ctx, stageId, config, orchestratorUrl, workflowContext } = execCtx;
    const gateType = (config.type as string) || 'auto';
    let gateData: unknown | undefined;

    if (gateType === 'manual') {
      ctx.setStatus('waiting_gate');

      // Broadcast gate-waiting status to WebSocket clients and schedule timeout if configured
      await fetch(`${orchestratorUrl}/api/internal/workflow-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: ctx.instanceId,
          stageId,
          status: 'waiting_gate',
          message: (config.message as string) || 'Waiting for approval',
          timeout_minutes: (config.timeout_minutes as number) ?? undefined,
          timeout_action: (config.timeout_action as string) ?? 'reject',
        }),
      }).catch(() => {});

      // Wait for approval via durable wait.
      // Accept both the legacy boolean shape (in-flight workflows) and the new object shape.
      const raw = await ctx.waitFor<{ approved: boolean; data?: unknown } | boolean>(`gate-${stageId}`);
      const result = typeof raw === 'boolean' ? { approved: raw } : raw;

      if (!result.approved) {
        throw new TerminalError(`Gate "${stageId}" was rejected`);
      }

      gateData = result.data;
      ctx.setStatus('running');
    } else if (gateType === 'conditional') {
      const condition = config.condition as string;
      const passed = safeEvalCondition(condition, { context: workflowContext });

      if (!passed) {
        throw new TerminalError(`Gate condition failed for "${stageId}": ${condition}`);
      }
    }
    // Auto gates just pass through

    return { output: gateData ?? { approved: true } };
  },
};

export const gateNodeSpec: NodeTypeSpec = {
  id: 'gate',
  name: 'Gate',
  category: 'step',
  description: 'Approval or conditional checkpoint',
  icon: 'shield-check',
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
      condition: { type: 'string', title: 'Condition', description: 'JS expression for conditional gates. Available variable: context (workflow context). Example: context.stages["review"].latest.approved === true', format: 'code' },
      message: { type: 'string', title: 'Message', description: 'Shown to the human reviewer (for manual gates)' },
      timeout_minutes: { type: 'number', title: 'Timeout (minutes)' },
      timeout_action: {
        type: 'string',
        title: 'Timeout Action',
        enum: ['approve', 'reject'],
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'JSON Schema describing the expected shape of edited gate data. Used for design-time documentation of downstream references.',
        format: 'json',
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
