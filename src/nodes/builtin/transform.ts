/**
 * Transform node — pure data transformation using a JS expression.
 * Maps (input, context) → output without side effects.
 */
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { safeEval } from '../../engine/safe-eval.js';

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown }> {
    const { ctx, stageId, config, workflowContext, input, iteration } = execCtx;
    const expression = (config.expression as string) || 'input';

    const output = await ctx.run(`transform-${stageId}-${iteration}`, () => {
      try {
        return safeEval(expression, {
          input: input?.sourceOutput ?? {},
          context: workflowContext,
          trigger: workflowContext.trigger,
        });
      } catch (err) {
        throw new Error(`Transform expression failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    return { output };
  },
};

export const transformNodeSpec: NodeTypeSpec = {
  id: 'transform',
  name: 'Transform',
  category: 'step',
  description: 'Transform data between stages using a JS expression',
  icon: 'shuffle',
  color: { bg: '#fffbeb', border: '#f59e0b', text: '#d97706' },
  configSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        title: 'Expression',
        description:
          'JS expression that transforms data. `input` contains the upstream stage\'s output — access fields via input.fieldName. Also available: context (context.stages["id"].latest), trigger (original trigger event). Must return the output object.',
        format: 'code',
        default: '({ ...input })',
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'JSON Schema describing this node\'s output. Used for design-time validation of downstream references.',
        format: 'json',
      },
    },
    required: ['expression'],
  },
  defaultConfig: { expression: '({ ...input })' },
  executor,
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: { type: 'string', title: 'Condition', format: 'code' },
    },
  },
};
