import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps, SharedState } from './shared.js';
import { validateCode } from '../validate-code.js';
import { validateTemplate } from '../validate-template.js';
import { errorMessage } from '../../utils/errors.js';
import { registerRestateRoutes } from './internal-restate.js';
import { registerAuthorRoutes } from './internal-author.js';

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

  // Register Restate-facing callbacks (spawn-agent, kill-agent, workflow-signal, etc.)
  registerRestateRoutes(app, deps, state);

  // Register AI author session management (author chat, drafts, segments, etc.)
  registerAuthorRoutes(app, deps, state);

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
}
