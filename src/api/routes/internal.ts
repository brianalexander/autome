import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps, SharedState } from './shared.js';
import { validateCode } from '../validate-code.js';
import { validateTemplate } from '../validate-template.js';
import { errorMessage } from '../../utils/errors.js';
import { broadcast } from '../websocket.js';
import { registerSignalRoutes } from './internal-signals.js';
import { registerAuthorRoutes } from './internal-author.js';
import { registerAssistantRoutes } from './internal-assistant.js';

// ---------------------------------------------------------------------------
// Schema for POST /api/internal/ui-action
// ---------------------------------------------------------------------------

const UiActionBody = z.object({
  workflowId: z.string().optional(),
  action: z.enum(['show_test_run', 'navigate', 'highlight_element', 'toast']),
  // show_test_run
  instanceId: z.string().optional(),
  testWorkflowId: z.string().optional(),
  // navigate
  to: z.string().optional(),
  // highlight_element
  elementId: z.string().optional(),
  pulseMs: z.number().optional(),
  // toast
  level: z.enum(['info', 'success', 'warn', 'error']).optional(),
  text: z.string().optional(),
});

const ValidateCodeBody = z.object({
  code: z.string(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  nodeType: z.string().optional(),
  validationMode: z.enum(['function', 'expression']).optional(),
  returnSchema: z.record(z.string(), z.unknown()).optional(),
  sandbox: z.boolean().optional(),
});

const ValidateTemplateBody = z.object({
  template: z.string(),
});

export function registerInternalRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // Register agent signal callbacks (spawn-agent, kill-agent, workflow-signal, etc.)
  registerSignalRoutes(app, deps, state);

  // Register AI author session management (author chat, drafts, segments, etc.)
  registerAuthorRoutes(app, deps, state);

  // Register AI assistant session management (global run overseer chat, segments, etc.)
  registerAssistantRoutes(app, deps, state);

  // POST /api/internal/validate-code — TypeScript type-checking for the code editor
  typedApp.post(
    '/api/internal/validate-code',
    { schema: { body: ValidateCodeBody } },
    async (request) => {
      try {
        const { code, outputSchema, nodeType, validationMode, returnSchema, sandbox } = request.body;
        const diagnostics = validateCode({ code, outputSchema, nodeType, validationMode, returnSchema, sandbox });
        return { diagnostics };
      } catch (err) {
        console.error('[validate-code] Error:', err);
        return { diagnostics: [] };
      }
    },
  );

  // POST /api/internal/validate-template — Jinja2/nunjucks syntax validation for template editor
  typedApp.post(
    '/api/internal/validate-template',
    { schema: { body: ValidateTemplateBody } },
    async (request) => {
      try {
        const { template } = request.body;
        if (!template?.trim()) return { diagnostics: [] };
        const diagnostics = validateTemplate(template);
        return { diagnostics };
      } catch (err) {
        console.error('[validate-template] Error:', err);
        return { diagnostics: [] };
      }
    },
  );

  // POST /api/internal/ui-action — Broadcast a UI action to connected frontend clients.
  // The agent can use this to show the user something in the UI when explicitly asked.
  typedApp.post(
    '/api/internal/ui-action',
    { schema: { body: UiActionBody } },
    async (request, reply) => {
      try {
        const { workflowId, ...rest } = request.body;
        const scope = workflowId ? { workflowId } : undefined;
        broadcast('ui:action', { workflowId, ...rest }, scope);
        return { ok: true };
      } catch (err) {
        console.error('[ui-action] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

}
