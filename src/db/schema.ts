import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    active: integer('active').notNull().default(0),
    definition: text('definition').notNull(),
    version: integer('version').notNull().default(1),
    is_test: integer('is_test').notNull().default(0),
    parent_workflow_id: text('parent_workflow_id'),
    created_at: text('created_at').notNull().default("(datetime('now'))"),
    updated_at: text('updated_at').notNull().default("(datetime('now'))"),
  },
  (table) => [
    index('idx_workflows_is_test').on(table.is_test),
    index('idx_workflows_parent').on(table.parent_workflow_id),
  ],
);

// ---------------------------------------------------------------------------
// pending_author_messages
// ---------------------------------------------------------------------------

export const pendingAuthorMessages = sqliteTable(
  'pending_author_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflow_id: text('workflow_id').notNull(),
    text: text('text').notNull(),
    kind: text('kind').notNull().default('system'),
    created_at: text('created_at').notNull().default("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"),
  },
  (table) => [index('idx_pending_author_messages_workflow').on(table.workflow_id)],
);

// ---------------------------------------------------------------------------
// instances
// ---------------------------------------------------------------------------

export const instances = sqliteTable(
  'instances',
  {
    id: text('id').primaryKey(),
    definition_id: text('definition_id').references(() => workflows.id),
    definition_version: integer('definition_version'),
    status: text('status').notNull().default('running'),
    trigger_event: text('trigger_event').notNull(),
    context: text('context').notNull(),
    current_stage_ids: text('current_stage_ids'),
    is_test: integer('is_test').notNull().default(0),
    initiated_by: text('initiated_by').notNull().default('user'),
    resume_count: integer('resume_count').notNull().default(0),
    created_at: text('created_at').notNull().default("(datetime('now'))"),
    updated_at: text('updated_at').notNull().default("(datetime('now'))"),
    completed_at: text('completed_at'),
    definition_snapshot: text('definition_snapshot'),
    display_summary: text('display_summary'),
  },
  (table) => [
    index('idx_instances_definition').on(table.definition_id),
    index('idx_instances_status').on(table.status),
    index('idx_instances_created_at').on(table.created_at),
  ],
);

// ---------------------------------------------------------------------------
// workflow_versions
// ---------------------------------------------------------------------------

export const workflowVersions = sqliteTable(
  'workflow_versions',
  {
    workflow_id: text('workflow_id').notNull(),
    version: integer('version').notNull(),
    definition: text('definition').notNull(),
    created_at: text('created_at').notNull().default("(datetime('now'))"),
  },
  (table) => [primaryKey({ columns: [table.workflow_id, table.version] })],
);

// ---------------------------------------------------------------------------
// workflow_drafts
// ---------------------------------------------------------------------------

export const workflowDrafts = sqliteTable('workflow_drafts', {
  workflow_id: text('workflow_id').primaryKey(),
  draft: text('draft').notNull(),
  updated_at: text('updated_at').notNull().default("(datetime('now'))"),
});

// ---------------------------------------------------------------------------
// segments
// ---------------------------------------------------------------------------

export const segments = sqliteTable(
  'segments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instance_id: text('instance_id').notNull(),
    stage_id: text('stage_id').notNull(),
    iteration: integer('iteration').notNull().default(1),
    segment_index: integer('segment_index').notNull(),
    segment_type: text('segment_type').notNull(),
    content: text('content'),
    tool_call_id: text('tool_call_id'),
    created_at: text('created_at').notNull().default("(datetime('now'))"),
  },
  (table) => [
    index('idx_segments_lookup').on(
      table.instance_id,
      table.stage_id,
      table.iteration,
      table.segment_index,
    ),
  ],
);

// ---------------------------------------------------------------------------
// tool_calls
// ---------------------------------------------------------------------------

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    instance_id: text('instance_id').notNull(),
    stage_id: text('stage_id').notNull(),
    iteration: integer('iteration').notNull().default(1),
    title: text('title'),
    kind: text('kind'),
    status: text('status').notNull().default('pending'),
    raw_input: text('raw_input'),
    raw_output: text('raw_output'),
    parent_tool_use_id: text('parent_tool_use_id'),
    created_at: text('created_at').notNull().default("(datetime('now'))"),
    updated_at: text('updated_at').notNull().default("(datetime('now'))"),
  },
  (table) => [
    index('idx_tool_calls_lookup').on(table.instance_id, table.stage_id, table.iteration),
  ],
);

// ---------------------------------------------------------------------------
// rendered_prompts
// ---------------------------------------------------------------------------

export const renderedPrompts = sqliteTable(
  'rendered_prompts',
  {
    instance_id: text('instance_id').notNull(),
    stage_id: text('stage_id').notNull(),
    iteration: integer('iteration').notNull().default(1),
    prompt: text('prompt').notNull(),
    created_at: text('created_at').notNull().default("(datetime('now'))"),
  },
  (table) => [primaryKey({ columns: [table.instance_id, table.stage_id, table.iteration] })],
);

// ---------------------------------------------------------------------------
// acp_sessions
// ---------------------------------------------------------------------------

export const acpSessions = sqliteTable('acp_sessions', {
  key: text('key').primaryKey(),
  session_id: text('session_id').notNull(),
  process_pid: integer('process_pid'),
  status: text('status').notNull().default('active'),
  model_name: text('model_name'),
  created_at: text('created_at').notNull().default("(datetime('now'))"),
  updated_at: text('updated_at').notNull().default("(datetime('now'))"),
});

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config').notNull(),
  created_at: text('created_at').notNull().default("(datetime('now'))"),
});

// ---------------------------------------------------------------------------
// mcp_servers
// ---------------------------------------------------------------------------

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  command: text('command').notNull(),
  args: text('args').notNull(),
  env: text('env'),
  created_at: text('created_at').notNull().default("(datetime('now'))"),
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: text('updated_at').notNull().default("(datetime('now'))"),
});

// ---------------------------------------------------------------------------
// draft_aliases
// ---------------------------------------------------------------------------

export const draftAliases = sqliteTable('draft_aliases', {
  from_id: text('from_id').primaryKey(),
  to_id: text('to_id').notNull(),
  created_at: text('created_at').notNull().default("(datetime('now'))"),
});

// ---------------------------------------------------------------------------
// _migrations
// ---------------------------------------------------------------------------

export const migrations = sqliteTable('_migrations', {
  name: text('name').primaryKey(),
  applied_at: text('applied_at').notNull().default("(datetime('now'))"),
});
