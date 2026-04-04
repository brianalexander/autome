/**
 * Safe expression evaluator — replaces raw `new Function()` calls.
 * Uses Node's vm module with a restricted sandbox context.
 * No access to process, require, global, __dirname, etc.
 */
import vm from 'node:vm';

const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Evaluate a JS expression in a sandboxed vm context.
 * Only the explicitly provided variables are accessible.
 */
export function safeEval(expression: string, variables: Record<string, unknown>, opts?: { timeout?: number }): unknown {
  const sandbox = {
    ...variables,
    // Safe built-ins only
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    undefined,
    NaN,
    Infinity,
    isNaN,
    isFinite,
  };

  const script = new vm.Script(`(${expression})`, { filename: 'expression' });
  const context = vm.createContext(sandbox);
  return script.runInContext(context, { timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS });
}

/**
 * Evaluate a boolean condition expression. Returns false on error.
 * Logs a warning so operators can debug misconfigured gate/edge conditions.
 */
export function safeEvalCondition(expression: string, variables: Record<string, unknown>): boolean {
  try {
    return !!safeEval(expression, variables);
  } catch (err) {
    console.warn(`[safeEvalCondition] Expression evaluation failed — returning false.\n  expression: ${expression}\n  error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
