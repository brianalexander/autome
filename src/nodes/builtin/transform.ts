/**
 * Transform node — pure data transformation using a JS expression.
 * Maps (input, context) → output without side effects.
 */
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { safeEval } from '../../engine/safe-eval.js';
import { buildExecutorScope } from '../executor-scope.js';

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown }> {
    const { ctx, stageId, config, iteration } = execCtx;
    const expression = (config.expression as string) || 'input';

    const scope = buildExecutorScope(execCtx);

    const output = await ctx.run(`transform-${stageId}-${iteration}`, () => {
      try {
        return safeEval(expression, scope as unknown as Record<string, unknown>);
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
  icon: '🔄',
  color: { bg: '#fffbeb', border: '#f59e0b', text: '#d97706' },
  configSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        title: 'Expression',
        description:
          'JS expression. Available variable: input (Record<stageId, upstreamOutput>). Access via input.stage_name or Object.values(input)[0] for single-input. Must return the output object.',
        format: 'code',
        default: 'input',
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
