#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';

const instanceId = process.env.WORKFLOW_INSTANCE_ID;
const stageId = process.env.STAGE_ID;
const orchestratorPort = process.env.ORCHESTRATOR_PORT || String(config.port);
const baseUrl = `http://localhost:${orchestratorPort}`;

if (!instanceId || !stageId) {
  console.error('WORKFLOW_INSTANCE_ID and STAGE_ID environment variables are required');
  process.exit(1);
}

const server = new Server({ name: 'workflow-control', version: '1.0.0' }, { capabilities: { tools: {} } });

// --- Validation helpers ---

const VALID_STATUSES = ['completed', 'failed', 'in_progress', 'waiting_input'] as const;
type SignalStatus = (typeof VALID_STATUSES)[number];

interface ValidationResult {
  ok: boolean;
  error?: string;
}

const REQUIRED_FIELDS: Record<SignalStatus, string[]> = {
  completed: ['output'],
  failed: ['error'],
  in_progress: ['message'],
  waiting_input: ['prompt'],
};

const ALLOWED_FIELDS: Record<SignalStatus, Set<string>> = {
  completed: new Set(['status', 'output']),
  failed: new Set(['status', 'error']),
  in_progress: new Set(['status', 'message']),
  waiting_input: new Set(['status', 'prompt']),
};

function validateSignal(args: Record<string, unknown>): ValidationResult {
  if (!args?.status) {
    return {
      ok: false,
      error: 'Missing required field: status. Must be one of: completed, failed, in_progress, waiting_input',
    };
  }
  if (!VALID_STATUSES.includes(args.status as SignalStatus)) {
    return { ok: false, error: `Invalid status "${args.status}". Must be one of: ${VALID_STATUSES.join(', ')}` };
  }
  const status = args.status as SignalStatus;

  // Check required fields for this status
  for (const field of REQUIRED_FIELDS[status]) {
    if (args[field] === undefined || args[field] === null) {
      return { ok: false, error: `Missing required field "${field}" for status "${status}"` };
    }
  }

  // Reject extra fields
  const allowed = ALLOWED_FIELDS[status];
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: `Unexpected field "${key}" for status "${status}". Allowed fields: ${[...allowed].join(', ')}`,
      };
    }
  }

  return { ok: true };
}

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'workflow_signal',
      description:
        'Signal your current status to the workflow orchestrator. You MUST call this before stopping.\n\n' +
        'Variants:\n' +
        '- status="completed" + output={...}  → You finished successfully. Provide structured output.\n' +
        '- status="failed" + error="..."      → You cannot continue. Explain why.\n' +
        '- status="in_progress" + message="..." → Progress update (does not end the stage).\n' +
        '- status="waiting_input" + prompt="..." → You need human input. Ask your question.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['completed', 'failed', 'in_progress', 'waiting_input'],
            description: 'Your current status',
          },
          output: {
            type: 'object',
            description: 'Required when status="completed". The structured output of your work.',
          },
          error: {
            type: 'string',
            description: 'Required when status="failed". Why you cannot continue.',
          },
          message: {
            type: 'string',
            description: 'Required when status="in_progress". Progress update message.',
          },
          prompt: {
            type: 'string',
            description: 'Required when status="waiting_input". Question for the human operator.',
          },
        },
        required: ['status'],
      },
    },
    {
      name: 'workflow_get_context',
      description:
        'Get the accumulated context from prior workflow stages. Returns outputs from all previously completed stages.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'workflow_signal': {
        // Validate the discriminated union
        const validation = validateSignal(args as Record<string, unknown>);
        if (!validation.ok) {
          return { content: [{ type: 'text', text: `Validation error: ${validation.error}` }], isError: true };
        }

        const response = await fetch(`${baseUrl}/api/internal/workflow-signal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId, stageId, ...args }),
        });
        const result = (await response.json()) as { message?: string; error?: string };
        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error: ${result.error || JSON.stringify(result)}` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: result.message || 'Signal received.' }] };
      }

      case 'workflow_get_context': {
        const response = await fetch(`${baseUrl}/api/internal/workflow-context/${instanceId}/${stageId}`);
        const context = await response.json();
        return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error calling orchestrator: ${message}` }],
      isError: true,
    };
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
