/**
 * OpenAPI Registry — registers the main Zod schemas with @asteasolutions/zod-to-openapi.
 *
 * This registry provides named schema definitions that appear in the OpenAPI spec
 * under `components/schemas`. The Fastify Swagger plugin picks up route-level schemas
 * automatically via `fastify-type-provider-zod`'s `jsonSchemaTransform`, so this
 * registry is primarily for documenting reusable domain models.
 */
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  WorkflowDefinitionSchema,
  StageDefinitionSchema,
  EdgeDefinitionSchema,
  PositionSchema,
  WatcherDefinitionSchema,
  CreateStageBodySchema,
  UpdateStageBodySchema,
  CreateEdgeBodySchema,
  UpdateEdgeBodySchema,
  UpdateTriggerBodySchema,
  UpdateMetadataBodySchema,
} from '../schemas/pipeline.js';

export const registry = new OpenAPIRegistry();

// Core domain models
registry.register('WorkflowDefinition', WorkflowDefinitionSchema);
registry.register('StageDefinition', StageDefinitionSchema);
registry.register('EdgeDefinition', EdgeDefinitionSchema);
registry.register('Position', PositionSchema);
registry.register('WatcherDefinition', WatcherDefinitionSchema);

// Request body schemas
registry.register('CreateStageBody', CreateStageBodySchema);
registry.register('UpdateStageBody', UpdateStageBodySchema);
registry.register('CreateEdgeBody', CreateEdgeBodySchema);
registry.register('UpdateEdgeBody', UpdateEdgeBodySchema);
registry.register('UpdateTriggerBody', UpdateTriggerBodySchema);
registry.register('UpdateMetadataBody', UpdateMetadataBodySchema);
