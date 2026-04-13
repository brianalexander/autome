#!/usr/bin/env node
/**
 * MCP server for the AI Assistant agent.
 * Provides tools to inspect and manage live workflow run instances.
 * Thin proxy — forwards calls to the Fastify orchestrator API and relays responses.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';

const orchestratorPort = process.env.ORCHESTRATOR_PORT || String(config.port);
const baseUrl = `http://localhost:${orchestratorPort}`;

const server = new Server({ name: 'workflow-assistant', version: '1.0.0' }, { capabilities: { tools: {} } });

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ------------------------------------------------------------------
    // list_runs
    // ------------------------------------------------------------------
    {
      name: 'list_runs',
      description: [
        'List workflow run instances. Excludes test runs (is_test=true).',
        'Use this to get an overview of recent or in-flight runs, filter by status or workflow,',
        'or find suspected-stalled instances (running stages idle >30 min, not waiting on a gate/input).',
        '',
        'Returns each item with a `suspected_stalled` boolean field.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            description: 'Filter by run status (e.g. "running", "completed", "failed", "cancelled")',
          },
          definitionId: {
            type: 'string',
            description: 'Filter by workflow definition ID',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp — only return runs created at or after this time',
          },
          until: {
            type: 'string',
            description: 'ISO 8601 timestamp — only return runs created before this time. Use with `since` for a date range.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of runs to return (default: 20)',
          },
          suspected_stalled: {
            type: 'boolean',
            description: 'If true, only return runs that are suspected stalled',
          },
        },
      },
    },

    // ------------------------------------------------------------------
    // get_run
    // ------------------------------------------------------------------
    {
      name: 'get_run',
      description: [
        'Get full details of a specific workflow run instance, including stage context summary.',
        'Also fetches the workflow definition name for the instance.',
        'Use this to drill into a specific run after finding it with list_runs.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID',
          },
        },
        required: ['instanceId'],
      },
    },

    // ------------------------------------------------------------------
    // get_stage_transcript
    // ------------------------------------------------------------------
    {
      name: 'get_stage_transcript',
      description: [
        'Get the full agent conversation transcript (segments) for a specific stage run.',
        'Use this to understand what the agent said and did during a stage.',
        'Combine with get_stage_prompt to see the full picture for a failed or unexpected stage.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID',
          },
          stageId: {
            type: 'string',
            description: 'The stage ID',
          },
          iteration: {
            type: 'number',
            description: 'Stage iteration to fetch (defaults to latest)',
          },
        },
        required: ['instanceId', 'stageId'],
      },
    },

    // ------------------------------------------------------------------
    // get_stage_prompt
    // ------------------------------------------------------------------
    {
      name: 'get_stage_prompt',
      description: [
        'Get the rendered system prompt that was sent to the agent for a specific stage iteration.',
        'Useful for diagnosing why an agent behaved unexpectedly — see exactly what instructions it received.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID',
          },
          stageId: {
            type: 'string',
            description: 'The stage ID',
          },
          iteration: {
            type: 'number',
            description: 'Stage iteration to fetch (defaults to latest)',
          },
        },
        required: ['instanceId', 'stageId'],
      },
    },

    // ------------------------------------------------------------------
    // get_stage_error
    // ------------------------------------------------------------------
    {
      name: 'get_stage_error',
      description: [
        'Get error details for a failed stage in a workflow run.',
        'Returns the error message, last run timing, and stage status.',
        'Use this as a quick diagnostic before diving into the full transcript.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID',
          },
          stageId: {
            type: 'string',
            description: 'The stage ID to inspect',
          },
        },
        required: ['instanceId', 'stageId'],
      },
    },

    // ------------------------------------------------------------------
    // list_workflows
    // ------------------------------------------------------------------
    {
      name: 'list_workflows',
      description: [
        'List all workflow definitions (published/active workflows).',
        'Use this to discover available workflows or find a definitionId to filter runs with.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of workflows to return',
          },
        },
      },
    },

    // ------------------------------------------------------------------
    // cancel_run
    // ------------------------------------------------------------------
    {
      name: 'cancel_run',
      description: [
        'Cancel a running workflow instance, stopping all in-progress stages.',
        'Use this when a run is stuck, needs to be aborted, or should be replaced by a fresh run.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID to cancel',
          },
        },
        required: ['instanceId'],
      },
    },

    // ------------------------------------------------------------------
    // resume_run
    // ------------------------------------------------------------------
    {
      name: 'resume_run',
      description: [
        'Resume a failed or cancelled workflow instance from a specific stage.',
        'Optionally specify fromStageId to resume from a particular stage; otherwise resumes from where it left off.',
        'Use this to retry a failed run after fixing the underlying cause.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID to resume',
          },
          fromStageId: {
            type: 'string',
            description: 'Optional stage ID to resume from. Defaults to the failed/stopped stage.',
          },
        },
        required: ['instanceId'],
      },
    },

    // ------------------------------------------------------------------
    // open_instance
    // ------------------------------------------------------------------
    {
      name: 'open_instance',
      description: [
        'Navigate the UI to the instance detail page for a specific workflow run.',
        'Optionally pass stageId to hint at a specific stage (reserved for future deep linking).',
        'Use this when the user asks to "show" or "open" a run.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID to navigate to',
          },
          stageId: {
            type: 'string',
            description: 'Optional stage ID to append as a query parameter (?stageId=…)',
          },
        },
        required: ['instanceId'],
      },
    },

    // ------------------------------------------------------------------
    // highlight_stage
    // ------------------------------------------------------------------
    {
      name: 'highlight_stage',
      description: [
        'Highlight a specific stage node on the canvas with a pulse animation.',
        'Use this after open_instance to draw the user\'s attention to a particular stage.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID',
          },
          stageId: {
            type: 'string',
            description: 'The stage ID to highlight',
          },
          pulseMs: {
            type: 'number',
            description: 'Duration of the pulse animation in milliseconds (default: 2500)',
          },
        },
        required: ['instanceId', 'stageId'],
      },
    },

    // ------------------------------------------------------------------
    // toast
    // ------------------------------------------------------------------
    {
      name: 'toast',
      description: [
        'Show a notification toast in the UI.',
        'Use this to surface a status message or confirmation to the user.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          level: {
            type: 'string',
            enum: ['info', 'success', 'warn', 'error'],
            description: 'Severity level of the toast',
          },
          text: {
            type: 'string',
            description: 'The message to display in the toast',
          },
        },
        required: ['level', 'text'],
      },
    },

    // ------------------------------------------------------------------
    // restart_stage_session
    // ------------------------------------------------------------------
    {
      name: 'restart_stage_session',
      description: [
        'Restart a hung or stuck agent session for a specific stage.',
        'Optionally send a message to the agent after restarting (e.g. to provide guidance or re-prompt).',
        'Use this when an agent session appears frozen but the stage is still marked as running.',
      ].join('\n'),
      inputSchema: {
        type: 'object' as const,
        properties: {
          instanceId: {
            type: 'string',
            description: 'The workflow instance ID',
          },
          stageId: {
            type: 'string',
            description: 'The stage ID whose session should be restarted',
          },
          message: {
            type: 'string',
            description: 'Optional message to send to the agent after restarting the session',
          },
        },
        required: ['instanceId', 'stageId'],
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
  if (status === 404) return 'Error: not found (404)';
  if (status === 403) {
    const msg = (body as Record<string, unknown>)?.error ?? 'Forbidden';
    return `Error: ${msg} (403)`;
  }
  return `API error (${status}): ${JSON.stringify(body)}`;
}

// ---------------------------------------------------------------------------
// Stalled-instance heuristic
// ---------------------------------------------------------------------------

const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

type StageContext = {
  status: string;
  runs?: Array<{ started_at?: string | null; status?: string }>;
};

function isSuspectedStalled(instance: { status: string; context?: { stages?: Record<string, StageContext> } }): boolean {
  if (instance.status !== 'running') return false;
  const stages = instance.context?.stages ?? {};
  const contexts = Object.values(stages);
  const runningStages = contexts.filter((s) => s.status === 'running');
  if (runningStages.length === 0) return false;

  // If any stage is waiting on a gate or human input, it's not stalled — it's blocked intentionally
  const hasWaiting = contexts.some(
    (s) => s.status === 'waiting_gate' || s.status === 'waiting_input',
  );
  if (hasWaiting) return false;

  // Flag as stalled if every running stage has been running for >30 minutes.
  // Use the started_at from the last run record, falling back to assuming stalled.
  const now = Date.now();
  return runningStages.every((s) => {
    const lastRun = s.runs && s.runs.length > 0 ? s.runs[s.runs.length - 1] : null;
    if (!lastRun?.started_at) return true; // no start time → assume stalled
    return now - new Date(lastRun.started_at).getTime() > STALL_THRESHOLD_MS;
  });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // -------------------------------------------------------------------------
  // list_runs
  // -------------------------------------------------------------------------
  if (name === 'list_runs') {
    try {
      const status = args?.status as string | undefined;
      const definitionId = args?.definitionId as string | undefined;
      const since = args?.since as string | undefined;
      const until = args?.until as string | undefined;
      const limit = (args?.limit as number | undefined) ?? 20;
      const suspectedStalledFilter = args?.suspected_stalled as boolean | undefined;

      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (definitionId) params.set('definitionId', definitionId);
      // When filtering by date range client-side, fetch more records to avoid missing results
      params.set('limit', (since || until) ? '200' : String(limit));

      const [result, workflowsResult] = await Promise.all([
        apiGet(`/api/instances?${params.toString()}`),
        apiGet('/api/workflows?limit=200'),
      ]);
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      // Build workflow name lookup
      const workflowNameMap = new Map<string, string>();
      if (workflowsResult.ok) {
        const wfRaw = workflowsResult.body as { data?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
        const wfRows = Array.isArray(wfRaw) ? wfRaw : (wfRaw.data ?? []);
        for (const wf of wfRows) workflowNameMap.set(wf.id, wf.name);
      }

      type InstanceRow = {
        id: string;
        definition_id?: string;
        status: string;
        created_at: string;
        completed_at?: string | null;
        is_test?: boolean;
        failed_stage?: string | null;
        context?: { stages?: Record<string, StageContext> };
      };

      const raw = result.body as { data?: InstanceRow[]; total?: number } | InstanceRow[];
      const rows: InstanceRow[] = Array.isArray(raw) ? raw : (raw.data ?? []);
      const total: number = Array.isArray(raw) ? rows.length : (raw.total ?? rows.length);

      // Exclude test instances
      let filtered = rows.filter((r) => !r.is_test);

      // Apply date range filter (since/until)
      if (since) {
        const sinceTs = new Date(since).getTime();
        filtered = filtered.filter((r) => new Date(r.created_at).getTime() >= sinceTs);
      }
      if (until) {
        const untilTs = new Date(until).getTime();
        filtered = filtered.filter((r) => new Date(r.created_at).getTime() < untilTs);
      }

      // Annotate with suspected_stalled
      const annotated = filtered.map((r) => ({
        instanceId: r.id,
        workflowName: (r.definition_id ? workflowNameMap.get(r.definition_id) : null) ?? null,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at ?? null,
        failedStage: r.failed_stage ?? null,
        suspected_stalled: isSuspectedStalled(r),
      }));

      // Apply suspected_stalled filter after annotation
      let finalRows = suspectedStalledFilter === true ? annotated.filter((r) => r.suspected_stalled) : annotated;

      // Truncate to the user-requested limit (relevant when since expanded the fetch limit)
      if (finalRows.length > limit) {
        finalRows = finalRows.slice(0, limit);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ data: finalRows, total: finalRows.length }, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // get_run
  // -------------------------------------------------------------------------
  if (name === 'get_run') {
    try {
      const instanceId = args?.instanceId as string;
      if (!instanceId) {
        return { content: [{ type: 'text', text: 'Error: "instanceId" is required' }], isError: true };
      }

      const [instanceResult, definitionResult] = await Promise.all([
        apiGet(`/api/instances/${instanceId}`),
        apiGet(`/api/instances/${instanceId}/definition`),
      ]);

      if (!instanceResult.ok) {
        return { content: [{ type: 'text', text: errorText(instanceResult.status, instanceResult.body) }], isError: true };
      }

      const instance = instanceResult.body as Record<string, unknown>;
      const definition = definitionResult.ok ? (definitionResult.body as Record<string, unknown>) : null;

      const enriched = {
        ...instance,
        workflowName: definition?.name ?? null,
      };

      return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // get_stage_transcript
  // -------------------------------------------------------------------------
  if (name === 'get_stage_transcript') {
    try {
      const instanceId = args?.instanceId as string;
      const stageId = args?.stageId as string;
      const iteration = args?.iteration as number | undefined;

      if (!instanceId || !stageId) {
        return {
          content: [{ type: 'text', text: 'Error: "instanceId" and "stageId" are required' }],
          isError: true,
        };
      }

      const iterQuery = iteration != null ? `?iteration=${iteration}` : '';
      const result = await apiGet(`/api/instances/${instanceId}/stages/${stageId}/segments${iterQuery}`);

      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result.body, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // get_stage_prompt
  // -------------------------------------------------------------------------
  if (name === 'get_stage_prompt') {
    try {
      const instanceId = args?.instanceId as string;
      const stageId = args?.stageId as string;
      const iteration = args?.iteration as number | undefined;

      if (!instanceId || !stageId) {
        return {
          content: [{ type: 'text', text: 'Error: "instanceId" and "stageId" are required' }],
          isError: true,
        };
      }

      const iterQuery = iteration != null ? `?iteration=${iteration}` : '';
      const result = await apiGet(`/api/instances/${instanceId}/stages/${stageId}/prompt${iterQuery}`);

      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      const data = result.body as { prompt?: string; iteration?: number; created_at?: string };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                prompt: data.prompt ?? null,
                iteration: data.iteration ?? null,
                created_at: data.created_at ?? null,
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

  // -------------------------------------------------------------------------
  // get_stage_error
  // -------------------------------------------------------------------------
  if (name === 'get_stage_error') {
    try {
      const instanceId = args?.instanceId as string;
      const stageId = args?.stageId as string;

      if (!instanceId || !stageId) {
        return {
          content: [{ type: 'text', text: 'Error: "instanceId" and "stageId" are required' }],
          isError: true,
        };
      }

      const result = await apiGet(`/api/instances/${instanceId}`);
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      type RunRecord = {
        iteration?: number;
        started_at?: string | null;
        completed_at?: string | null;
        status?: string;
        error?: string | null;
      };

      type StageCtx = {
        status?: string;
        runs?: RunRecord[];
      };

      // The API returns context.stages as a Record<stageId, StageCtx>, not a stageContexts array.
      const instance = result.body as { context?: { stages?: Record<string, StageCtx> } };
      const stageCtx: StageCtx | undefined = instance.context?.stages?.[stageId];

      if (!stageCtx) {
        return {
          content: [{ type: 'text', text: `Error: stage "${stageId}" not found in instance` }],
          isError: true,
        };
      }

      const runs: RunRecord[] = stageCtx.runs ?? [];
      const lastRun: RunRecord | null = runs.length > 0 ? runs[runs.length - 1] : null;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                // error lives on the last run record, not on the stage context itself
                error: lastRun?.error ?? null,
                stageStatus: stageCtx.status ?? null,
                lastRun: lastRun
                  ? {
                      iteration: lastRun.iteration ?? null,
                      started_at: lastRun.started_at ?? null,
                      completed_at: lastRun.completed_at ?? null,
                      status: lastRun.status ?? null,
                    }
                  : null,
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

  // -------------------------------------------------------------------------
  // list_workflows
  // -------------------------------------------------------------------------
  if (name === 'list_workflows') {
    try {
      const limit = args?.limit as number | undefined;
      const params = new URLSearchParams();
      if (limit != null) params.set('limit', String(limit));

      const result = await apiGet(`/api/workflows?${params.toString()}`);
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      type WorkflowRow = {
        id: string;
        name: string;
        description?: string | null;
        active?: boolean;
        stages?: unknown[];
        stageCount?: number;
      };

      const raw = result.body as WorkflowRow[] | { data?: WorkflowRow[] };
      const rows: WorkflowRow[] = Array.isArray(raw) ? raw : (raw.data ?? []);

      const mapped = rows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? null,
        active: w.active ?? null,
        stageCount: w.stageCount ?? (Array.isArray(w.stages) ? w.stages.length : null),
      }));

      return { content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // cancel_run
  // -------------------------------------------------------------------------
  if (name === 'cancel_run') {
    try {
      const instanceId = args?.instanceId as string;
      if (!instanceId) {
        return { content: [{ type: 'text', text: 'Error: "instanceId" is required' }], isError: true };
      }

      const result = await apiPost(`/api/instances/${instanceId}/cancel`, {});
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      const data = result.body as { stoppedStages?: unknown };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ cancelled: true, stoppedStages: data.stoppedStages ?? null }, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // resume_run
  // -------------------------------------------------------------------------
  if (name === 'resume_run') {
    try {
      const instanceId = args?.instanceId as string;
      if (!instanceId) {
        return { content: [{ type: 'text', text: 'Error: "instanceId" is required' }], isError: true };
      }

      const fromStageId = args?.fromStageId as string | undefined;
      const result = await apiPost(`/api/instances/${instanceId}/resume`, { fromStageId });

      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      const data = result.body as {
        instanceId?: string;
        resumeCount?: number;
        fromStageIds?: string[];
        restateWorkflowId?: string;
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                instanceId: data.instanceId ?? instanceId,
                resumeCount: data.resumeCount ?? null,
                fromStageIds: data.fromStageIds ?? null,
                restateWorkflowId: data.restateWorkflowId ?? null,
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

  // -------------------------------------------------------------------------
  // restart_stage_session
  // -------------------------------------------------------------------------
  if (name === 'restart_stage_session') {
    try {
      const instanceId = args?.instanceId as string;
      const stageId = args?.stageId as string;
      const message = args?.message as string | undefined;

      if (!instanceId || !stageId) {
        return {
          content: [{ type: 'text', text: 'Error: "instanceId" and "stageId" are required' }],
          isError: true,
        };
      }

      const restartResult = await apiPost(`/api/instances/${instanceId}/stages/${stageId}/restart-session`, {});
      if (!restartResult.ok) {
        return {
          content: [{ type: 'text', text: errorText(restartResult.status, restartResult.body) }],
          isError: true,
        };
      }

      if (message) {
        const msgResult = await apiPost(`/api/instances/${instanceId}/stages/${stageId}/message`, { message });
        if (!msgResult.ok) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ok: true, restarted: true, messageSent: false, error: errorText(msgResult.status, msgResult.body) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, restarted: true, messageSent: message != null }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // open_instance
  // -------------------------------------------------------------------------
  if (name === 'open_instance') {
    try {
      const instanceId = args?.instanceId as string;
      if (!instanceId) {
        return { content: [{ type: 'text', text: 'Error: "instanceId" is required' }], isError: true };
      }

      const stageId = args?.stageId as string | undefined;
      const url = `/instances/${instanceId}${stageId ? `?stageId=${stageId}` : ''}`;

      const result = await apiPost('/api/internal/ui-action', { action: 'navigate', to: url });
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ navigated: true, url }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // highlight_stage
  // -------------------------------------------------------------------------
  if (name === 'highlight_stage') {
    try {
      const instanceId = args?.instanceId as string;
      const stageId = args?.stageId as string;
      if (!instanceId || !stageId) {
        return {
          content: [{ type: 'text', text: 'Error: "instanceId" and "stageId" are required' }],
          isError: true,
        };
      }

      const pulseMs = (args?.pulseMs as number | undefined) ?? 2500;
      const result = await apiPost('/api/internal/ui-action', {
        action: 'highlight_element',
        elementId: stageId,
        instanceId,
        pulseMs,
      });
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ highlighted: true }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // toast
  // -------------------------------------------------------------------------
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

      const result = await apiPost('/api/internal/ui-action', { action: 'toast', level, text });
      if (!result.ok) {
        return { content: [{ type: 'text', text: errorText(result.status, result.body) }], isError: true };
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
