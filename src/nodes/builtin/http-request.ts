/**
 * HTTP Request node — makes an HTTP call and returns the response.
 * URL and body support template variables from upstream output.
 */
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { resolveTemplate } from '../../engine/context-resolver.js';
import { jsonSchemaToZod } from '../schema-to-zod.js';
import { buildExecutorScope } from '../executor-scope.js';

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown }> {
    const { ctx, stageId, config, input, iteration } = execCtx;

    // Build template variables — spread raw input data and add 'item' alias
    // when executing inside a map_over loop so {{ item.field }} resolves correctly.
    const scope = buildExecutorScope(execCtx);
    const templateVars: Record<string, unknown> = {
      ...(scope.input as Record<string, unknown>),
      sourceOutputs: scope.sourceOutputs,
    };
    if (input?.mapElement !== undefined) {
      templateVars.item = input.mapElement;
    }

    const url = resolveTemplate((config.url as string) || '', templateVars);
    const method = ((config.method as string) || 'GET').toUpperCase();
    const headers = (config.headers as Record<string, string>) || {};
    const bodyTemplate = config.body as string | undefined;
    const body = bodyTemplate ? resolveTemplate(bodyTemplate, templateVars) : undefined;

    const output = await ctx.run(`http-request-${stageId}-${iteration}`, async () => {
      const res = await fetch(url, {
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body && method !== 'GET' ? { body } : {}),
      });

      const responseBody = await res.text();
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(responseBody);
      } catch {
        parsedBody = responseBody;
      }

      // Validate response against expected schema if configured
      if (config.response_schema && typeof config.response_schema === 'object') {
        try {
          const responseSchema = jsonSchemaToZod(config.response_schema as Record<string, unknown>);
          const validation = responseSchema.safeParse(parsedBody);
          if (!validation.success) {
            const issues = validation.error.issues
              .map(i => `${i.path.join('.')}: ${i.message}`)
              .join('; ');
            throw new Error(
              `Response schema validation failed: ${issues}`
            );
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Response schema validation')) {
            throw err; // Re-throw validation errors
          }
          console.warn(`[http-request] Failed to validate response schema: ${err}`);
        }
      }

      return {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body: parsedBody,
      };
    });

    return { output };
  },
};

export const httpRequestNodeSpec: NodeTypeSpec = {
  id: 'http-request',
  name: 'HTTP Request',
  category: 'step',
  description: 'Make an HTTP request and return the response',
  icon: '🌐',
  color: { bg: '#ecfeff', border: '#06b6d4', text: '#0891b2' },
  configSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        title: 'URL',
        description: 'Request URL. Supports {{ field }} templates from upstream output.',
        format: 'url',
      },
      method: { type: 'string', title: 'Method', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      headers: {
        type: 'object',
        title: 'Headers',
        description: 'HTTP headers as key-value pairs',
      },
      body: {
        type: 'string',
        title: 'Request Body (JSON)',
        description: 'JSON payload sent with POST/PUT/PATCH requests. Supports {{ field }} template variables from upstream output.',
        format: 'json',
        'x-show-if': { field: 'method', notEquals: 'GET' },
      },
      response_schema: {
        type: 'object',
        title: 'Expected Response Schema',
        description: 'JSON Schema defining the expected response body structure. If set, the node fails immediately when the response doesn\'t match.',
        format: 'json',
      },
    },
    required: ['url', 'method', 'response_schema'],
  },
  defaultConfig: { url: '', method: 'GET' },
  executor,
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: { type: 'string', title: 'Condition', description: 'e.g., output.status === 200', format: 'code' },
    },
  },
};
