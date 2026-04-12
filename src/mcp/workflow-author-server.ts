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

const orchestratorPort = process.env.ORCHESTRATOR_PORT || String(config.port);
const baseUrl = `http://localhost:${orchestratorPort}`;

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
        '',
        'IMPORTANT: Do NOT use autome_api for test runs. Use the dedicated test-run tools instead.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The workflow ID to operate on. Use the workflow_id from your context.',
          },
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
            description:
              'Request body as a JSON object (required for POST, PUT, PATCH). Pass an object literal, NOT a stringified JSON. Example: { "name": "My Workflow" } — not "{\\"name\\":\\"My Workflow\\"}"',
            additionalProperties: true,
          },
        },
        required: ['workflow_id', 'method', 'path'],
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
        'Pass the workflow_id from your context.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The workflow ID to operate on. Use the workflow_id from your context.',
          },
        },
        required: ['workflow_id'],
      },
    },
    {
      name: 'start_test_run',
      description: [
        'Launch a test run for the workflow. Returns immediately with an instanceId.',
        'You do NOT need to poll — when the run reaches a terminal state, a system message will be pushed into this chat summarizing the result.',
        'Use `get_test_run_stage_details` in response if you need deeper failure context.',
        'Before starting, automatically cleans up old test runs (keeps last 3).',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The workflow ID to test. Use the workflow_id from your context.',
          },
          payload: {
            type: 'object',
            description: 'Optional trigger payload to pass to the test run',
            additionalProperties: true,
          },
        },
        required: ['workflow_id'],
      },
    },
    {
      name: 'get_test_run_snapshot',
      description: [
        'Get a compact snapshot of a test run: status, progress, per-stage summary, and failed stage details.',
        'Use this when a terminal-event push message arrives and you want structured context about what happened.',
        'On 403/404, returns a clean error message.',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The workflow ID (used for scope check). Use the workflow_id from your context.',
          },
          instanceId: {
            type: 'string',
            description: 'The instance ID returned by start_test_run',
          },
        },
        required: ['workflow_id', 'instanceId'],
      },
    },
    {
      name: 'get_test_run_stage_details',
      description: [
        'Get detailed diagnostics for a specific stage in a test run: rendered prompt, full agent transcript, output, and error.',
        'Use this after a test run fails to understand what the agent did and why it failed.',
        'Combines the stage prompt and transcript in one call.',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The workflow ID (used for scope check). Use the workflow_id from your context.',
          },
          instanceId: {
            type: 'string',
            description: 'The test run instance ID',
          },
          stageId: {
            type: 'string',
            description: 'The stage ID to inspect (use `failedStage.stageId` from the snapshot)',
          },
          iteration: {
            type: 'number',
            description: 'Stage iteration to inspect (defaults to latest)',
          },
        },
        required: ['workflow_id', 'instanceId', 'stageId'],
      },
    },
    {
      name: 'cancel_test_run',
      description: [
        'Cancel a running test run.',
        'Use this if a test is taking too long or you want to abort and make changes to the workflow.',
        'The scope check ensures you can only cancel test runs for the current workflow.',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The workflow ID (used for scope check). Use the workflow_id from your context.',
          },
          instanceId: {
            type: 'string',
            description: 'The instance ID of the test run to cancel',
          },
        },
        required: ['workflow_id', 'instanceId'],
      },
    },
    {
      name: 'list_test_runs',
      description: [
        'List recent test runs for the workflow, ordered newest-first.',
        'Useful for reviewing history of test attempts before starting a new one.',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          workflow_id: {
            type: 'string',
            description: 'The workflow ID. Use the workflow_id from your context.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of runs to return (default: 10, max: 50)',
          },
        },
        required: ['workflow_id'],
      },
    },
    {
      name: 'show_test_run',
      description: [
        'Open the test run viewer in the editor for a specific instance.',
        'Only call when the user EXPLICITLY asks (e.g. "show me the test run", "open it").',
        'Do NOT call proactively — the user does not want to be navigated around without consent.',
        '',
        'Example: user says "run a test and let me know how it goes." → call start_test_run, wait for push, summarize in chat. Do NOT call show_test_run.',
        'Example: user says "ok show me the test run." → call show_test_run.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The instance ID returned by start_test_run.',
          },
          testWorkflowId: {
            type: 'string',
            description: 'The testWorkflowId returned by start_test_run.',
          },
        },
        required: ['instanceId', 'testWorkflowId'],
      },
    },
    {
      name: 'navigate',
      description: 'Navigate the UI to a path.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string',
            description: 'The route path to navigate to (e.g. "/instances/abc").',
          },
        },
        required: ['to'],
      },
    },
    {
      name: 'highlight_stage',
      description: [
        'Highlight a stage on the canvas with a pulse animation.',
        'Use after navigating to draw the user\'s attention to a particular stage.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          stageId: {
            type: 'string',
            description: 'The stage ID to highlight.',
          },
          pulseMs: {
            type: 'number',
            description: 'Duration of the pulse animation in milliseconds (default: 2500).',
          },
        },
        required: ['stageId'],
      },
    },
    {
      name: 'toast',
      description: 'Show a notification toast in the UI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          level: {
            type: 'string',
            enum: ['info', 'success', 'warn', 'error'],
            description: 'Severity level of the toast.',
          },
          text: {
            type: 'string',
            description: 'The message to display in the toast.',
          },
        },
        required: ['level', 'text'],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiGet(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

async function apiPost(path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function errorText(status: number, body: unknown): string {
  if (status === 404) return 'Error: test run not found (404)';
  if (status === 403) {
    const msg = (body as Record<string, unknown>)?.error ?? 'Forbidden';
    return `Error: ${msg} (403)`;
  }
  return `API error (${status}): ${JSON.stringify(body)}`;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // -----------------------------------------------------------------------
  // validate_workflow
  // -----------------------------------------------------------------------
  if (name === 'validate_workflow') {
    const workflowId = args?.workflow_id as string;
    if (!workflowId) {
      return { content: [{ type: 'text', text: 'Error: "workflow_id" is required' }], isError: true };
    }
    const url = `${baseUrl}/api/draft/${workflowId}/validate`;
    const response = await fetch(url);
    const result = await response.json();

    if (!response.ok) {
      return { content: [{ type: 'text', text: `Validation error: ${JSON.stringify(result)}` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  // -----------------------------------------------------------------------
  // autome_api
  // -----------------------------------------------------------------------
  if (name === 'autome_api') {
    try {
      const workflowId = args?.workflow_id as string;
      if (!workflowId) {
        return { content: [{ type: 'text', text: 'Error: "workflow_id" is required' }], isError: true };
      }

      const method = ((args?.method as string) || 'GET').toUpperCase();
      const path = args?.path as string;

      // Defensive coercion: agents (especially Claude) sometimes pass `body`
      // as a stringified JSON ("{\"foo\":1}") rather than an object. Auto-parse
      // it so we don't waste a turn on a 400 the agent can't easily diagnose.
      let body: Record<string, unknown> | undefined;
      const rawBody = args?.body;
      if (typeof rawBody === 'string') {
        try {
          const parsed = JSON.parse(rawBody);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: "body" must be a JSON object. Pass it as an object, not a string. Example: { "name": "X" }',
                },
              ],
              isError: true,
            };
          }
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: "body" was a string but not valid JSON. Pass `body` as a JSON object, not a string. Example: { "name": "X" }',
              },
            ],
            isError: true,
          };
        }
      } else if (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
        body = rawBody as Record<string, unknown>;
      }

      if (!path) {
        return { content: [{ type: 'text', text: 'Error: "path" is required' }], isError: true };
      }

      // Guard: block test-run paths — the agent must use the dedicated tools instead
      if (path === '/test-run' || path.startsWith('/test-runs')) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'autome_api cannot be used for test runs. Use the dedicated tools: start_test_run, get_test_run_snapshot, get_test_run_stage_details, cancel_test_run, list_test_runs.',
              }),
            },
          ],
          isError: true,
        };
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
  }

  // -----------------------------------------------------------------------
  // start_test_run
  // -----------------------------------------------------------------------
  if (name === 'start_test_run') {
    try {
      const workflowId = args?.workflow_id as string;
      if (!workflowId) {
        return { content: [{ type: 'text', text: 'Error: "workflow_id" is required' }], isError: true };
      }
      const payload = args?.payload as Record<string, unknown> | undefined;

      // Best-effort cleanup of old test runs before starting a new one
      try {
        await apiPost('/api/internal/test-runs/cleanup', { parentWorkflowId: workflowId, keep: 3 });
      } catch (err) {
        console.error('[start_test_run] Cleanup failed (continuing):', err);
      }

      const result = await apiPost(`/api/draft/${workflowId}/test-run`, { payload: payload ?? {} });
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: errorText(result.status, result.body) }],
          isError: true,
        };
      }

      const data = result.body as { instance?: { id?: string; created_at?: string }; testWorkflowId?: string };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                instanceId: data.instance?.id,
                testWorkflowId: data.testWorkflowId,
                startedAt: data.instance?.created_at,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // get_test_run_snapshot
  // -----------------------------------------------------------------------
  if (name === 'get_test_run_snapshot') {
    try {
      const workflowId = args?.workflow_id as string;
      const instanceId = args?.instanceId as string;
      if (!workflowId) {
        return { content: [{ type: 'text', text: 'Error: "workflow_id" is required' }], isError: true };
      }
      if (!instanceId) {
        return { content: [{ type: 'text', text: 'Error: "instanceId" is required' }], isError: true };
      }

      const result = await apiGet(
        `/api/test-runs/${instanceId}?parentWorkflowId=${encodeURIComponent(workflowId)}`,
      );
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result.body, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // get_test_run_stage_details
  // -----------------------------------------------------------------------
  if (name === 'get_test_run_stage_details') {
    try {
      const workflowId = args?.workflow_id as string;
      const instanceId = args?.instanceId as string;
      const stageId = args?.stageId as string;
      const iteration = args?.iteration as number | undefined;

      if (!workflowId || !instanceId || !stageId) {
        return {
          content: [{ type: 'text', text: 'Error: "workflow_id", "instanceId", and "stageId" are required' }],
          isError: true,
        };
      }

      // Step 1: scope check via snapshot
      const scopeResult = await apiGet(
        `/api/test-runs/${instanceId}?parentWorkflowId=${encodeURIComponent(workflowId)}`,
      );
      if (!scopeResult.ok) {
        return { content: [{ type: 'text', text: errorText(scopeResult.status, scopeResult.body) }], isError: true };
      }

      const snapshot = scopeResult.body as {
        stageSummary?: Array<{ stageId: string; status: string; runCount: number }>;
      };

      // Resolve the iteration: use provided, or latest from stage summary
      let resolvedIteration = iteration;
      if (resolvedIteration == null) {
        const stageSummaryEntry = snapshot.stageSummary?.find((s) => s.stageId === stageId);
        resolvedIteration = stageSummaryEntry?.runCount ?? 1;
      }

      const iterQuery = `?iteration=${resolvedIteration}`;

      // Step 2: fetch transcript (segments)
      const segmentsResult = await apiGet(
        `/api/instances/${instanceId}/stages/${stageId}/segments${iterQuery}`,
      );

      // Step 3: fetch rendered prompt
      const promptResult = await apiGet(
        `/api/instances/${instanceId}/stages/${stageId}/prompt${iterQuery}`,
      );

      // Build compact transcript from segments
      type SegmentItem = {
        segment_type: string;
        content?: string | null;
        tool_call?: {
          kind?: string;
          title?: string;
          status?: string;
          raw_input?: string;
          raw_output?: string;
        } | null;
      };
      const MAX_TEXT_BYTES = 4096;
      const segments: SegmentItem[] = Array.isArray(segmentsResult.body) ? (segmentsResult.body as SegmentItem[]) : [];
      const transcript = segments.map((seg) => {
        if (seg.segment_type === 'tool') {
          return {
            kind: 'tool' as const,
            toolCall: seg.tool_call
              ? {
                  kind: seg.tool_call.kind,
                  title: seg.tool_call.title,
                  status: seg.tool_call.status,
                  input: seg.tool_call.raw_input
                    ? seg.tool_call.raw_input.length > MAX_TEXT_BYTES
                      ? seg.tool_call.raw_input.slice(0, MAX_TEXT_BYTES) + '…[truncated]'
                      : seg.tool_call.raw_input
                    : undefined,
                  output: seg.tool_call.raw_output
                    ? seg.tool_call.raw_output.length > MAX_TEXT_BYTES
                      ? seg.tool_call.raw_output.slice(0, MAX_TEXT_BYTES) + '…[truncated]'
                      : seg.tool_call.raw_output
                    : undefined,
                }
              : null,
          };
        }
        // text or user segment
        const content = seg.content ?? '';
        return {
          kind: 'text' as const,
          role: seg.segment_type === 'user' ? 'user' : 'assistant',
          text: content.length > MAX_TEXT_BYTES ? content.slice(0, MAX_TEXT_BYTES) + '…[truncated]' : content,
        };
      });

      // Find stage status from snapshot
      const stageEntry = (snapshot.stageSummary ?? []).find((s) => s.stageId === stageId);

      const renderedPrompt =
        promptResult.ok && promptResult.body
          ? (promptResult.body as { prompt?: string }).prompt ?? ''
          : '(no rendered prompt found)';

      // Get output/error from the snapshot's stageSummary latestError field
      const latestError = stageEntry
        ? (snapshot.stageSummary?.find((s) => s.stageId === stageId) as Record<string, unknown> | undefined)
            ?.latestError
        : undefined;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                stageId,
                iteration: resolvedIteration,
                status: stageEntry?.status ?? 'unknown',
                renderedPrompt,
                transcript,
                ...(latestError ? { error: latestError } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // cancel_test_run
  // -----------------------------------------------------------------------
  if (name === 'cancel_test_run') {
    try {
      const workflowId = args?.workflow_id as string;
      const instanceId = args?.instanceId as string;
      if (!workflowId || !instanceId) {
        return {
          content: [{ type: 'text', text: 'Error: "workflow_id" and "instanceId" are required' }],
          isError: true,
        };
      }

      // Scope check
      const scopeResult = await apiGet(
        `/api/test-runs/${instanceId}?parentWorkflowId=${encodeURIComponent(workflowId)}`,
      );
      if (!scopeResult.ok) {
        return { content: [{ type: 'text', text: errorText(scopeResult.status, scopeResult.body) }], isError: true };
      }

      // Cancel the instance
      const cancelResult = await apiPost(`/api/instances/${instanceId}/cancel`, {});
      if (!cancelResult.ok) {
        return {
          content: [{ type: 'text', text: errorText(cancelResult.status, cancelResult.body) }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ cancelled: true }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // list_test_runs
  // -----------------------------------------------------------------------
  if (name === 'list_test_runs') {
    try {
      const workflowId = args?.workflow_id as string;
      if (!workflowId) {
        return { content: [{ type: 'text', text: 'Error: "workflow_id" is required' }], isError: true };
      }
      const limit = (args?.limit as number | undefined) ?? 10;
      const clampedLimit = Math.min(Math.max(1, limit), 50);

      const result = await apiGet(
        `/api/test-runs?parentWorkflowId=${encodeURIComponent(workflowId)}&limit=${clampedLimit}`,
      );
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result.body, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // show_test_run
  // -----------------------------------------------------------------------
  if (name === 'show_test_run') {
    try {
      const instanceId = args?.instanceId as string;
      const testWorkflowId = args?.testWorkflowId as string;
      if (!instanceId || !testWorkflowId) {
        return {
          content: [{ type: 'text', text: 'Error: "instanceId" and "testWorkflowId" are required' }],
          isError: true,
        };
      }

      const WORKFLOW_ID = process.env.WORKFLOW_ID as string;
      const result = await apiPost('/api/internal/ui-action', {
        action: 'show_test_run',
        instanceId,
        testWorkflowId,
        workflowId: WORKFLOW_ID,
      });
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `API error (${result.status}): ${JSON.stringify(result.body)}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // navigate
  // -----------------------------------------------------------------------
  if (name === 'navigate') {
    try {
      const to = args?.to as string;
      if (!to) {
        return { content: [{ type: 'text', text: 'Error: "to" is required' }], isError: true };
      }

      const WORKFLOW_ID = process.env.WORKFLOW_ID as string;
      const result = await apiPost('/api/internal/ui-action', {
        action: 'navigate',
        to,
        workflowId: WORKFLOW_ID,
      });
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `API error (${result.status}): ${JSON.stringify(result.body)}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, to }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // highlight_stage
  // -----------------------------------------------------------------------
  if (name === 'highlight_stage') {
    try {
      const stageId = args?.stageId as string;
      if (!stageId) {
        return { content: [{ type: 'text', text: 'Error: "stageId" is required' }], isError: true };
      }

      const WORKFLOW_ID = process.env.WORKFLOW_ID as string;
      const pulseMs = args?.pulseMs as number | undefined;
      const result = await apiPost('/api/internal/ui-action', {
        action: 'highlight_element',
        elementId: stageId,
        workflowId: WORKFLOW_ID,
        ...(pulseMs != null ? { pulseMs } : {}),
      });
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `API error (${result.status}): ${JSON.stringify(result.body)}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ highlighted: true }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -----------------------------------------------------------------------
  // toast
  // -----------------------------------------------------------------------
  if (name === 'toast') {
    try {
      const level = args?.level as string;
      const text = args?.text as string;
      if (!level || !text) {
        return {
          content: [{ type: 'text', text: 'Error: "level" and "text" are required' }],
          isError: true,
        };
      }

      const WORKFLOW_ID = process.env.WORKFLOW_ID as string;
      const result = await apiPost('/api/internal/ui-action', {
        action: 'toast',
        level,
        text,
        workflowId: WORKFLOW_ID,
      });
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `API error (${result.status}): ${JSON.stringify(result.body)}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ shown: true }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
