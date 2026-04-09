/**
 * Cron Trigger node — triggers workflows on a schedule.
 * Uses setInterval for simplicity (a cron library can be swapped in later).
 */
import type { NodeTypeSpec, TriggerExecutor } from '../types.js';

/** Parse a simple cron-like interval string to milliseconds. Returns null if unrecognized. */
function parseScheduleMs(schedule: string): number | null {
  // Support simple formats: "5m", "1h", "30s"
  const match = schedule.match(/^(\d+)(s|m|h)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60_000;
      case 'h':
        return value * 3_600_000;
    }
  }
  // Cron expression: extract minute interval if it's a simple */N pattern
  const cronMatch = schedule.match(/^\*\/(\d+)\s/);
  if (cronMatch) {
    return parseInt(cronMatch[1], 10) * 60_000;
  }
  return null;
}

const executor: TriggerExecutor = {
  type: 'trigger',
  async activate(workflowId, stageId, config, emit) {
    const schedule = (config.schedule as string) || '5m';
    const parsed = parseScheduleMs(schedule);
    let intervalMs: number;
    if (parsed === null) {
      console.warn(
        `[cron-trigger] Unrecognized schedule expression "${schedule}" for workflow ${workflowId}. ` +
        `Falling back to 5 minutes. Supported formats: "30s", "5m", "1h", or "*/N * * * *".`,
      );
      intervalMs = 300_000;
    } else {
      intervalMs = parsed;
    }

    console.log(`[cron-trigger] Activated for workflow ${workflowId}, schedule: ${schedule} (${intervalMs}ms)`);

    const id = setInterval(() => {
      emit({
        type: 'cron',
        timestamp: new Date().toISOString(),
        schedule,
      });
    }, intervalMs);

    // Return cleanup function
    return () => {
      clearInterval(id);
      console.log(`[cron-trigger] Deactivated for workflow ${workflowId}`);
    };
  },
};

export const cronTriggerSpec: NodeTypeSpec = {
  id: 'cron-trigger',
  name: 'Cron Trigger',
  category: 'trigger',
  description: 'Trigger a workflow on a recurring schedule',
  icon: 'clock',
  color: { bg: '#f0fdf4', border: '#22c55e', text: '#16a34a' },
  configSchema: {
    type: 'object',
    properties: {
      schedule: {
        type: 'string',
        title: 'Schedule',
        description: 'Schedule expression. Simple formats: "5m", "1h", "30s". Limited cron: "*/5 * * * *" (only */N minute patterns). Other cron expressions are not fully supported.',
        default: '5m',
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'JSON Schema describing this node\'s output. Used for design-time validation of downstream references.',
        format: 'json',
      },
    },
    required: ['schedule', 'output_schema'],
  },
  defaultConfig: {
    schedule: '5m',
    output_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'cron' },
        timestamp: { type: 'string', description: 'ISO 8601 timestamp' },
        schedule: { type: 'string', description: 'The cron/interval expression' },
      },
    },
  },
  triggerMode: 'immediate',
  executor,
};
