/**
 * All built-in node type specs — imported by the registry at startup.
 */
import type { NodeTypeSpec } from '../types.js';
import { agentNodeSpec } from './agent.js';
import { gateNodeSpec } from './gate.js';
import { reviewGateNodeSpec } from './review-gate.js';
import { manualTriggerSpec } from './manual-trigger.js';
import { webhookTriggerSpec } from './webhook-trigger.js';
import { cronTriggerSpec } from './cron-trigger.js';
import { codeExecutorNodeSpec } from './code-executor.js';
import { codeTriggerSpec } from './code-trigger.js';
import { promptTriggerSpec } from './prompt-trigger.js';

export const allBuiltinSpecs: NodeTypeSpec[] = [
  // Triggers
  manualTriggerSpec,
  promptTriggerSpec,
  webhookTriggerSpec,
  cronTriggerSpec,
  codeTriggerSpec,
  // Steps
  agentNodeSpec,
  gateNodeSpec,
  reviewGateNodeSpec,
  codeExecutorNodeSpec,
];
