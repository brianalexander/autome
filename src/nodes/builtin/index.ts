/**
 * All built-in node type specs — imported by the registry at startup.
 */
import type { NodeTypeSpec } from '../types.js';
import { agentNodeSpec } from './agent.js';
import { gateNodeSpec } from './gate.js';
import { manualTriggerSpec } from './manual-trigger.js';
import { webhookTriggerSpec } from './webhook-trigger.js';
import { cronTriggerSpec } from './cron-trigger.js';
import { transformNodeSpec } from './transform.js';
import { httpRequestNodeSpec } from './http-request.js';
import { codeExecutorNodeSpec } from './code-executor.js';
import { shellExecutorNodeSpec } from './shell-executor.js';
import { codeTriggerSpec } from './code-trigger.js';

export const allBuiltinSpecs: NodeTypeSpec[] = [
  // Triggers
  manualTriggerSpec,
  webhookTriggerSpec,
  cronTriggerSpec,
  codeTriggerSpec,
  // Steps
  agentNodeSpec,
  gateNodeSpec,
  transformNodeSpec,
  httpRequestNodeSpec,
  codeExecutorNodeSpec,
  shellExecutorNodeSpec,
];
