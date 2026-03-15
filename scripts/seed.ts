import { OrchestratorDB } from '../src/db/database.js';

const db = new OrchestratorDB();

// Check if pipelines already exist
const existing = db.listPipelines();
if (existing.length > 0) {
  console.log(`Database already has ${existing.length} pipeline(s). Skipping seed.`);
  console.log(existing.map((p) => `  - ${p.name}`).join('\n'));
  db.close();
  process.exit(0);
}

console.log('Seeding database with sample pipelines...\n');

// Pipeline 1: Jira Ticket to Merged PR (with iterative review loops)
const jiraPipeline = db.createPipeline({
  name: 'Jira Ticket to Merged PR',
  description:
    'Requirements analysis → code generation → iterative code review → PR publishing. Full ticket-to-PR automation.',
  active: false,
  trigger: { provider: 'manual' },
  stages: [
    {
      id: 'manual-trigger',
      type: 'trigger',
      label: 'Manual Trigger',
      config: { provider: 'manual' },
      position: { x: 250, y: 0 },
    },
    {
      id: 'deep-dive',
      type: 'agent',
      label: 'Requirements Analysis',
      config: {
        agentId: 'requirements-analyst',
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
        agentId: 'code-generator',
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
        agentId: 'code-reviewer',
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
        agentId: 'pr-publisher',
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
      prompt_template: 'Analyze this task:\n{{ trigger.payload }}',
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

// Pipeline 2: Simple Analysis (minimal — one trigger, one agent)
const simplePipeline = db.createPipeline({
  name: 'Simple Analysis',
  description: 'A minimal pipeline: analyze input and produce a summary.',
  active: false,
  trigger: { provider: 'manual' },
  stages: [
    {
      id: 'manual-trigger',
      type: 'trigger',
      label: 'Manual Trigger',
      config: { provider: 'manual' },
      position: { x: 250, y: 0 },
    },
    {
      id: 'analyzer',
      type: 'agent',
      label: 'Analyzer',
      config: {
        agentId: 'requirements-analyst',
        max_turns: 10,
        timeout_minutes: 5,
      },
      position: { x: 250, y: 120 },
    },
  ],
  edges: [
    { id: 'e0', source: 'manual-trigger', target: 'analyzer', prompt_template: 'Analyze this:\n{{ trigger.payload }}' },
  ],
});
console.log(`Created: ${simplePipeline.name} (${simplePipeline.id})`);

// Pipeline 3: Webhook-triggered analysis
const webhookPipeline = db.createPipeline({
  name: 'Webhook Analysis',
  description: 'Triggered by external webhook. Analyzes the incoming payload.',
  active: false,
  trigger: { provider: 'webhook' },
  stages: [
    {
      id: 'webhook-trigger',
      type: 'trigger',
      label: 'Webhook Trigger',
      config: {
        provider: 'webhook',
        webhook: {},
      },
      position: { x: 250, y: 0 },
    },
    {
      id: 'analyzer',
      type: 'agent',
      label: 'Payload Analyzer',
      config: {
        agentId: 'requirements-analyst',
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
      prompt_template: 'Analyze this incoming webhook payload:\n{{ trigger.payload }}',
    },
  ],
});
console.log(`Created: ${webhookPipeline.name} (${webhookPipeline.id})`);

console.log('\nDone! 3 pipelines seeded.');
db.close();
