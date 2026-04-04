#!/usr/bin/env node
/**
 * MCP server for the AI Author agent.
 * Pure thin proxy — forwards calls to the Fastify draft API and relays responses.
 * All validation, schemas, and OpenAPI spec generation live in Fastify.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';

const workflowId = process.env.WORKFLOW_ID;
const orchestratorPort = process.env.ORCHESTRATOR_PORT || String(config.port);
const baseUrl = `http://localhost:${orchestratorPort}`;

if (!workflowId) {
  console.error('WORKFLOW_ID environment variable is required');
  process.exit(1);
}

const server = new Server({ name: 'workflow-author', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'autome_api',
      description: [
        'Make an API call to modify the workflow definition.',
        'Paths are relative to the current workflow (e.g. "/stages", "/edges/edge-1", "/trigger").',
        'Refer to the OpenAPI spec and <node_types> in your context for all available endpoints, stage types, and config schemas.',
        '',
        'Key semantics:',
        '- PUT replaces a resource entirely (omitted fields are removed)',
        '- PATCH does RFC 7396 merge (omitted fields preserved, null deletes a field)',
        '- Use PUT when redefining a stage/edge, PATCH for surgical field changes',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTP method',
          },
          path: {
            type: 'string',
            description: 'API path relative to the workflow',
          },
          body: {
            type: 'object',
            description: 'Request body (required for POST, PUT, PATCH)',
            additionalProperties: true,
          },
        },
        required: ['method', 'path'],
      },
    },
    {
      name: 'validate_workflow',
      description: [
        'Validate the entire workflow graph for errors and warnings.',
        'Returns comprehensive diagnostics: graph structure issues, stage config errors,',
        'TypeScript code/expression errors, edge problems, and missing schema warnings.',
        '',
        'Call this after making changes to verify the workflow is valid.',
        'No arguments needed — validates the current workflow draft.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'validate_workflow') {
    const url = `${baseUrl}/api/draft/${workflowId}/validate`;
    const response = await fetch(url);
    const result = await response.json();

    if (!response.ok) {
      return { content: [{ type: 'text', text: `Validation error: ${JSON.stringify(result)}` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (name !== 'autome_api') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    const method = ((args?.method as string) || 'GET').toUpperCase();
    const path = args?.path as string;
    const body = args?.body as Record<string, unknown> | undefined;

    if (!path) {
      return { content: [{ type: 'text', text: 'Error: "path" is required' }], isError: true };
    }

    const url = `${baseUrl}/api/draft/${workflowId}${path}`;
    const hasBody = body && ['POST', 'PUT', 'PATCH'].includes(method);
    const fetchOpts: RequestInit = {
      method,
      ...(hasBody ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    };

    const response = await fetch(url, fetchOpts);
    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        content: [{ type: 'text', text: `API error (${response.status}): ${JSON.stringify(responseBody)}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify(responseBody, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
