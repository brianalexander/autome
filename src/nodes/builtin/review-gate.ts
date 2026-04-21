/**
 * Review Gate node — human-in-the-loop review checkpoint with three possible
 * decisions: approve, request revision, or reject. The "revise" decision is
 * intended to loop back to upstream stages via a conditional edge.
 */
import { TerminalError } from '../../engine/types.js';
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';

interface ReviewDecision {
  decision: 'approved' | 'revised' | 'rejected';
  notes?: string;
  data?: unknown;
}

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: ReviewDecision }> {
    const { ctx, stageId, config, orchestratorUrl } = execCtx;
    ctx.setStatus('waiting_gate');

    await fetch(`${orchestratorUrl}/api/internal/workflow-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: ctx.instanceId,
        stageId,
        status: 'waiting_gate',
        message: (config.message as string) || 'Waiting for review',
        gateKind: 'review',
        timeout_minutes: (config.timeout_minutes as number) ?? undefined,
        timeout_action: (config.timeout_action as string) ?? 'rejected',
      }),
    }).catch(() => {});

    const result = await ctx.waitFor<ReviewDecision>(`gate-${stageId}`);

    if (result.decision === 'rejected') {
      throw new TerminalError(
        `Review "${stageId}" rejected${result.notes ? `: ${result.notes}` : ''}`,
      );
    }

    ctx.setStatus('running');
    return { output: result };
  },
};

export const reviewGateNodeSpec: NodeTypeSpec = {
  id: 'review-gate',
  name: 'Review Gate',
  category: 'step',
  description: 'Human review checkpoint with approve/revise/reject decisions and reviewer notes',
  icon: 'gavel',
  color: { bg: '#fef3c7', border: '#f59e0b', text: '#d97706' },
  configSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        title: 'Review Instructions',
        description:
          "Shown to the reviewer. Supports Nunjucks — reference {{ trigger.FIELD }} or {{ stages.STAGE_ID.latest.FIELD }}.",
        format: 'template',
      },
      timeout_minutes: {
        type: 'number',
        title: 'Timeout (minutes)',
        description: 'How long to wait. Empty = wait indefinitely.',
        'x-placeholder': '∞',
      },
      timeout_action: {
        type: 'string',
        title: 'Timeout Decision',
        enum: ['approved', 'revised', 'rejected'],
        default: 'rejected',
        'x-enum-labels': [
          'Auto-approve on timeout',
          'Auto-request revision on timeout',
          'Auto-reject on timeout',
        ],
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'Fixed shape: { decision, notes?, data? }.',
        format: 'json',
        readOnly: true,
      },
    },
  },
  defaultConfig: {
    output_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approved', 'revised', 'rejected'] },
        notes: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['decision'],
    },
  },
  executor,
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: {
        type: 'string',
        title: 'Condition',
        description:
          "JS expression on this stage's output. Typical values: output.decision === 'approved' (proceed), output.decision === 'revised' (loop back upstream).",
        format: 'code',
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
    {
      kind: 'help-text',
      title: 'Routing decisions',
      markdown: `Wire three outgoing edges (any can be omitted):\n\n- **Approve**: \`output.decision === 'approved'\` → next stage\n- **Revise**: \`output.decision === 'revised'\` → loop back to upstream stage for another pass (the reviewer's notes are available as \`{{ stages.<review_gate_id>.latest.notes }}\`)\n- **Reject**: no edge needed — the gate throws a TerminalError and marks the instance failed`,
    },
  ],
};
