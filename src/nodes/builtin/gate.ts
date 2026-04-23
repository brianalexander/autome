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
    const { ctx, stageId, config, orchestratorUrl, workflowContext, input } = execCtx;
    const gateType = (config.type as string) || 'auto';

    // Pass upstream input through to the output so downstream stages can reference
    // {{ output.input.FIELD }} instead of reaching back via stages.<upstream>.latest.FIELD
    const passthrough = input?.sourceOutput ?? input?.mergedInputs ?? null;

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
      const raw = await ctx.waitFor<{ approved: boolean } | boolean>(`gate-${stageId}`);
      const result = typeof raw === 'boolean' ? { approved: raw } : raw;

      if (!result.approved) {
        throw new TerminalError(`Gate "${stageId}" was rejected`);
      }

      ctx.setStatus('running');
      return { output: { approved: true, input: passthrough } };
    } else if (gateType === 'conditional') {
      const condition = config.condition as string;
      // Narrowed sandbox: `input` is the edge-delivered upstream output, `trigger` is the workflow trigger payload.
      // No raw `context` or `stages.*` exposure in user-authored expressions.
      const gateInput = input?.sourceOutput ?? input?.mergedInputs ?? null;
      const passed = safeEvalCondition(condition, { input: gateInput, trigger: workflowContext.trigger });

      if (!passed) {
        throw new TerminalError(`Gate condition failed for "${stageId}": ${condition}`);
      }

      return { output: { approved: true, input: passthrough } };
    }

    // Auto gates just pass through
    return { output: { approved: true, input: passthrough } };
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
        'x-enum-labels': ['Manual (human approval)', 'Conditional (JS expression)', 'Auto (always passes)'],
      },
      condition: {
        type: 'string',
        title: 'Condition',
        description: 'JS expression for conditional gates. Available variables: input (edge-delivered upstream output), trigger (workflow trigger payload). Example: input.approved === true',
        format: 'code',
        'x-show-if': { field: 'type', equals: 'conditional' },
      },
      message: {
        type: 'string',
        title: 'Message',
        format: 'template',
        description: "Shown to the human reviewer (for manual gates). Supports Nunjucks templates — reference the trigger payload via {{ trigger.FIELD }} or the upstream stage's output via {{ input.FIELD }}.",
      },
      timeout_minutes: {
        type: 'number',
        title: 'Timeout (minutes)',
        description: 'How long to wait for approval. Empty = no timeout; wait indefinitely.',
        'x-placeholder': '∞',
      },
      timeout_action: {
        type: 'string',
        title: 'Timeout Action',
        enum: ['approve', 'reject'],
        'x-enum-labels': ['Auto-approve on timeout', 'Reject on timeout'],
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'Fixed by the runtime.',
        format: 'json',
        readOnly: true,
      },
    },
  },
  configCards: [
    {
      kind: 'preview-template',
      field: 'message',
      title: 'Message Preview',
      description: 'Live preview using mock trigger + upstream outputs.',
    },
  ],
  defaultConfig: {
    type: 'manual',
    output_schema: {
      type: 'object',
      properties: {
        approved: { type: 'boolean', description: 'True if the gate was approved (or auto/conditional passed).' },
        input: { 'x-passthrough': 'input', description: 'Passthrough of the upstream stage output — reference downstream as {{ output.input.FIELD }}.' },
      },
      required: ['approved', 'input'],
    },
  },
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
