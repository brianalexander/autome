import { OrchestratorDB } from '../src/db/database.js';

const db = new OrchestratorDB();

// Check if workflows already exist
const existing = db.listWorkflows();
if (existing.data.length > 0) {
  console.log(`Database already has ${existing.data.length} workflow(s). Skipping seed.`);
  console.log(existing.data.map((p) => `  - ${p.name}`).join('\n'));
  db.close();
  process.exit(0);
}

console.log('Seeding database with sample workflows...\n');

// Workflow 1: Jira Ticket to Merged PR (with iterative review loops)
const jiraPipeline = db.createWorkflow({
  name: 'Jira Ticket to Merged PR',
  description:
    'Requirements analysis → code generation → iterative code review → PR publishing. Full ticket-to-PR automation.',
  active: false,
  trigger: { provider: 'manual' },
  stages: [
    {
      id: 'manual-trigger',
      type: 'manual-trigger',
      label: 'Manual Trigger',
      config: { provider: 'manual', output_schema: { type: 'object', properties: {} } },
      position: { x: 250, y: 0 },
    },
    {
      id: 'deep-dive',
      type: 'agent',
      label: 'Requirements Analysis',
      config: {
        agentId: 'researcher',
        max_turns: 50,
        timeout_minutes: 30,
      },
      position: { x: 250, y: 120 },
    },
    {
      id: 'gate-requirements',
      type: 'gate',
      label: 'Requirements Review',
      config: {
        type: 'manual',
        message: 'Review the requirements analysis before implementation begins.',
        timeout_minutes: 1440,
        timeout_action: 'reject',
      },
      position: { x: 250, y: 240 },
    },
    {
      id: 'code-gen',
      type: 'agent',
      label: 'Code Generator',
      config: {
        agentId: 'implementer',
        max_iterations: 4,
        max_turns: 100,
        timeout_minutes: 60,
      },
      position: { x: 250, y: 360 },
    },
    {
      id: 'code-reviewer',
      type: 'agent',
      label: 'Code Reviewer',
      config: {
        agentId: 'reviewer',
        max_iterations: 4,
        max_turns: 50,
        timeout_minutes: 30,
      },
      position: { x: 250, y: 480 },
    },
    {
      id: 'pr-publisher',
      type: 'agent',
      label: 'PR Publisher',
      config: {
        agentId: 'generalist',
        max_turns: 20,
        timeout_minutes: 10,
      },
      position: { x: 250, y: 600 },
    },
  ],
  edges: [
    {
      id: 'e0',
      source: 'manual-trigger',
      target: 'deep-dive',
      prompt_template: 'Analyze this task:\n{{ trigger | dump }}',
    },
    { id: 'e1', source: 'deep-dive', target: 'gate-requirements' },
    { id: 'e2', source: 'gate-requirements', target: 'code-gen' },
    {
      id: 'e3',
      source: 'code-gen',
      target: 'code-reviewer',
      prompt_template:
        'Review this implementation:\nSummary: {{ output.summary }}\nFiles changed: {{ output.files_changed }}',
    },
    {
      id: 'e4-revise',
      source: 'code-reviewer',
      target: 'code-gen',
      label: 'Needs revision',
      condition: "output.decision === 'revise'",
      prompt_template: 'Reviewer feedback (address ALL points):\n{{ output.notes }}\nIssues: {{ output.issues }}',
    },
    {
      id: 'e4-approved',
      source: 'code-reviewer',
      target: 'pr-publisher',
      label: 'Approved',
      condition: "output.decision === 'approved'",
      prompt_template:
        'The code review passed. Publish the PR.\nReview decision: {{ output.decision }}\nNotes: {{ output.notes }}',
    },
  ],
});
console.log(`Created: ${jiraPipeline.name} (${jiraPipeline.id})`);

// Workflow 2: Simple Analysis (minimal — one trigger, one agent)
const simplePipeline = db.createWorkflow({
  name: 'Simple Analysis',
  description: 'A minimal pipeline: analyze input and produce a summary.',
  active: false,
  trigger: { provider: 'manual' },
  stages: [
    {
      id: 'manual-trigger',
      type: 'manual-trigger',
      label: 'Manual Trigger',
      config: { provider: 'manual', output_schema: { type: 'object', properties: {} } },
      position: { x: 250, y: 0 },
    },
    {
      id: 'analyzer',
      type: 'agent',
      label: 'Analyzer',
      config: {
        agentId: 'generalist',
        max_turns: 10,
        timeout_minutes: 5,
      },
      position: { x: 250, y: 120 },
    },
  ],
  edges: [
    { id: 'e0', source: 'manual-trigger', target: 'analyzer', prompt_template: 'Analyze this:\n{{ trigger | dump }}' },
  ],
});
console.log(`Created: ${simplePipeline.name} (${simplePipeline.id})`);

// Workflow 3: Webhook-triggered analysis
const webhookPipeline = db.createWorkflow({
  name: 'Webhook Analysis',
  description: 'Triggered by external webhook. Analyzes the incoming payload.',
  active: false,
  trigger: { provider: 'webhook' },
  stages: [
    {
      id: 'webhook-trigger',
      type: 'webhook-trigger',
      label: 'Webhook Trigger',
      config: {
        provider: 'webhook',
        payload_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', description: 'Incoming webhook payload.' },
      },
      position: { x: 250, y: 0 },
    },
    {
      id: 'analyzer',
      type: 'agent',
      label: 'Payload Analyzer',
      config: {
        agentId: 'generalist',
        max_turns: 10,
        timeout_minutes: 5,
      },
      position: { x: 250, y: 120 },
    },
  ],
  edges: [
    {
      id: 'e0',
      source: 'webhook-trigger',
      target: 'analyzer',
      prompt_template: 'Analyze this incoming webhook payload:\n{{ trigger | dump }}',
    },
  ],
});
console.log(`Created: ${webhookPipeline.name} (${webhookPipeline.id})`);

console.log('\nDone! 3 workflows seeded.');
db.close();
