import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from './shared.js';
import { errorMessage } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TemplateIdParams = z.object({ id: z.string() });

const TemplateQuerySchema = z.object({
  nodeType: z.string().optional(),
  source: z.string().optional(),
});

const CreateTemplateBody = z.object({
  name: z.string(),
  description: z.string().optional(),
  nodeType: z.string(),
  icon: z.string().optional(),
  category: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  exposed: z.array(z.string()).optional(),
  locked: z.array(z.string()).optional(),
  source: z.string().optional(),
});

const UpdateTemplateBody = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  nodeType: z.string().optional(),
  icon: z.string().optional(),
  category: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  exposed: z.array(z.string()).optional(),
  locked: z.array(z.string()).optional(),
  source: z.string().optional(),
});

const ImportTemplateItem = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  nodeType: z.string(),
  icon: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()),
  exposed: z.array(z.string()).nullable().optional(),
  locked: z.array(z.string()).nullable().optional(),
  source: z.string().optional(),
});

const ImportTemplateBody = z.union([ImportTemplateItem, z.array(ImportTemplateItem)]);

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTemplateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // GET /api/templates — list all templates, optionally filtered
  typedApp.get(
    '/api/templates',
    { schema: { querystring: TemplateQuerySchema } },
    async (request, reply) => {
      try {
        const { nodeType, source } = request.query;
        const filter: { nodeType?: string; source?: string } = {};
        if (nodeType) filter.nodeType = nodeType;
        if (source) filter.source = source;
        return db.listNodeTemplates(filter);
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/templates/:id — get a single template
  typedApp.get(
    '/api/templates/:id',
    { schema: { params: TemplateIdParams } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const template = db.getNodeTemplate(id);
        if (!template) return reply.code(404).send({ error: 'Template not found' });
        return template;
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/templates — create a template
  typedApp.post(
    '/api/templates',
    { schema: { body: CreateTemplateBody } },
    async (request, reply) => {
      try {
        const template = db.createNodeTemplate(request.body);
        return reply.code(201).send(template);
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // PUT /api/templates/:id — update a template
  typedApp.put(
    '/api/templates/:id',
    { schema: { params: TemplateIdParams, body: UpdateTemplateBody } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const updated = db.updateNodeTemplate(id, request.body);
        if (!updated) return reply.code(404).send({ error: 'Template not found' });
        return updated;
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // DELETE /api/templates/:id — delete a template
  typedApp.delete(
    '/api/templates/:id',
    { schema: { params: TemplateIdParams } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const deleted = db.deleteNodeTemplate(id);
        if (!deleted) return reply.code(404).send({ error: 'Template not found' });
        return reply.code(204).send();
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/templates/:id/duplicate — duplicate a template with a new ID
  typedApp.post(
    '/api/templates/:id/duplicate',
    { schema: { params: TemplateIdParams } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const existing = db.getNodeTemplate(id);
        if (!existing) return reply.code(404).send({ error: 'Template not found' });
        const duplicate = db.createNodeTemplate({
          name: `${existing.name} (copy)`,
          description: existing.description ?? undefined,
          nodeType: existing.node_type,
          icon: existing.icon ?? undefined,
          category: existing.category ?? undefined,
          config: existing.config,
          exposed: existing.exposed,
          locked: existing.locked,
          source: 'local',
        });
        return reply.code(201).send(duplicate);
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/templates/import — import one or more templates from JSON
  typedApp.post(
    '/api/templates/import',
    { schema: { body: ImportTemplateBody } },
    async (request, reply) => {
      try {
        const items = Array.isArray(request.body) ? request.body : [request.body];
        // Coerce nulls to undefined (the Zod schema accepts null for nullable fields)
        const results = items.map((item) => {
          const clean = {
            id: item.id,
            name: item.name,
            description: item.description ?? undefined,
            nodeType: item.nodeType,
            icon: item.icon ?? undefined,
            category: item.category ?? undefined,
            config: item.config,
            exposed: item.exposed ?? undefined,
            locked: item.locked ?? undefined,
            source: item.source ?? 'imported',
          };
          if (clean.id) {
            const existing = db.getNodeTemplate(clean.id);
            if (existing) {
              return db.updateNodeTemplate(clean.id, clean);
            }
          }
          return db.createNodeTemplate(clean);
        });
        return reply.code(201).send(results);
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/templates/:id/export — export as clean, portable JSON
  typedApp.get(
    '/api/templates/:id/export',
    { schema: { params: TemplateIdParams } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const template = db.getNodeTemplate(id);
        if (!template) return reply.code(404).send({ error: 'Template not found' });
        // Strip null/empty values for a clean portable JSON
        const exported: Record<string, unknown> = {
          name: template.name,
          nodeType: template.node_type,
          config: template.config,
        };
        if (template.description) exported.description = template.description;
        if (template.icon) exported.icon = template.icon;
        if (template.category) exported.category = template.category;
        if (template.exposed?.length) exported.exposed = template.exposed;
        if (template.locked?.length) exported.locked = template.locked;
        return exported;
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

}
