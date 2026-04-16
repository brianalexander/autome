import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, sql, inArray, desc, asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { WorkflowDefinition, MCPServerConfig } from '../types/workflow.js';
import type { WorkflowInstance, InitiatedBy, PendingAuthorMessage } from '../types/instance.js';
import type { CustomProviderConfig } from '../types/events.js';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Node template types
// ---------------------------------------------------------------------------

export interface NodeTemplateRow {
  id: string;
  name: string;
  description: string | null;
  node_type: string;
  icon: string | null;
  category: string | null;
  config: Record<string, unknown>;
  exposed: string[];
  locked: string[];
  version: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface CreateNodeTemplate {
  id?: string;
  name: string;
  description?: string;
  nodeType: string;
  icon?: string;
  category?: string;
  config: Record<string, unknown>;
  exposed?: string[];
  locked?: string[];
  source?: string;
}

interface RawNodeTemplateRow {
  id: string;
  name: string;
  description: string | null;
  node_type: string;
  icon: string | null;
  category: string | null;
  config: string;
  exposed: string | null;
  locked: string | null;
  version: number;
  source: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Gate types
// ---------------------------------------------------------------------------

export interface GateRow {
  instance_id: string;
  stage_id: string;
  kind: 'gate' | 'stage-complete';
  status: 'waiting' | 'resolved' | 'rejected';
  payload: unknown | null;  // parsed JSON
  created_at: string;
  resolved_at: string | null;
}

interface RawGateRow {
  instance_id: string;
  stage_id: string;
  kind: string;
  status: string;
  payload: string | null;
  created_at: string;
  resolved_at: string | null;
}

function parseGateRow(row: RawGateRow): GateRow {
  return {
    instance_id: row.instance_id,
    stage_id: row.stage_id,
    kind: row.kind as GateRow['kind'],
    status: row.status as GateRow['status'],
    payload: row.payload !== null ? JSON.parse(row.payload) : null,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

// ---------------------------------------------------------------------------
// Scheduled timer types
// ---------------------------------------------------------------------------

export interface ScheduledTimerRow {
  id: string;
  instance_id: string;
  stage_id: string;
  kind: string;
  fire_at: string;
  payload: unknown | null;
  created_at: string;
}

interface RawScheduledTimerRow {
  id: string;
  instance_id: string;
  stage_id: string;
  kind: string;
  fire_at: string;
  payload: string | null;
  created_at: string;
}

function parseScheduledTimerRow(row: RawScheduledTimerRow): ScheduledTimerRow {
  return {
    id: row.id,
    instance_id: row.instance_id,
    stage_id: row.stage_id,
    kind: row.kind,
    fire_at: row.fire_at,
    payload: row.payload !== null ? JSON.parse(row.payload) : null,
    created_at: row.created_at,
  };
}

function parseNodeTemplateRow(row: RawNodeTemplateRow): NodeTemplateRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    node_type: row.node_type,
    icon: row.icon,
    category: row.category,
    config: JSON.parse(row.config) as Record<string, unknown>,
    exposed: JSON.parse(row.exposed ?? '[]') as string[],
    locked: JSON.parse(row.locked ?? '[]') as string[],
    version: row.version,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export class OrchestratorDB {
  private sqlite: Database.Database;
  private db: BetterSQLite3Database<typeof schema>;

  constructor(dbPath: string = process.env.DATABASE_PATH || './data/orchestrator.db') {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.db = drizzle(this.sqlite, { schema });
    this.runMigrations();
  }

  private runMigrations(): void {
    // Ensure _migrations tracking table exists first
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Handle legacy table rename: old DBs used 'pipelines', code now uses 'workflows'
    const tables = this.sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pipelines', 'workflows')",
      )
      .all();
    const tableNames = new Set(tables.map((t) => t.name));
    if (tableNames.has('pipelines') && !tableNames.has('workflows')) {
      this.sqlite.exec('ALTER TABLE pipelines RENAME TO workflows');
      console.log('[db] Renamed table: pipelines → workflows');
    }

    const applied = new Set(
      this.sqlite
        .prepare<[], { name: string }>('SELECT name FROM _migrations ORDER BY name')
        .all()
        .map((r) => r.name),
    );

    let migrationFiles: string[];
    try {
      migrationFiles = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Migrations directory doesn't exist — nothing to apply
        return;
      }
      throw err;
    }

    const runMigration = this.sqlite.transaction((name: string, migSql: string) => {
      this.sqlite.exec(migSql);
      this.sqlite.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });

    for (const file of migrationFiles) {
      if (!applied.has(file)) {
        const migSql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
        runMigration(file, migSql);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Workflow CRUD
  // ---------------------------------------------------------------------------

  createWorkflow(
    input: Omit<WorkflowDefinition, 'id'> & { id?: string },
    opts?: { isTest?: boolean; parentWorkflowId?: string },
  ): WorkflowDefinition {
    const id = uuidv4();
    const { id: _inputId, ...rest } = input as Omit<WorkflowDefinition, 'id'> & { id?: string };
    const workflow: WorkflowDefinition = {
      ...rest,
      id,
      version: 1,
      ...(opts?.parentWorkflowId ? { parent_workflow_id: opts.parentWorkflowId } : {}),
    };
    this.db.insert(schema.workflows).values({
      id,
      name: workflow.name,
      description: workflow.description ?? null,
      active: workflow.active ? 1 : 0,
      definition: JSON.stringify(workflow),
      is_test: opts?.isTest ? 1 : 0,
      parent_workflow_id: opts?.parentWorkflowId ?? null,
      version: 1,
    }).run();
    // Store version 1 in workflow_versions
    this.db.insert(schema.workflowVersions).values({
      workflow_id: id,
      version: 1,
      definition: JSON.stringify(workflow),
    }).run();
    return workflow;
  }

  getWorkflow(id: string): WorkflowDefinition | null {
    const row = this.db
      .select({ id: schema.workflows.id, definition: schema.workflows.definition, version: schema.workflows.version })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, id))
      .get();
    if (!row) return null;
    const workflow = JSON.parse(row.definition) as WorkflowDefinition;
    workflow.version = row.version;
    return workflow;
  }

  listWorkflows(opts?: { includeTest?: boolean; limit?: number; offset?: number }): {
    data: WorkflowDefinition[];
    total: number;
  } {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const offset = opts?.offset ?? 0;
    const whereCondition = opts?.includeTest ? undefined : eq(schema.workflows.is_test, 0);

    const countResult = this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.workflows)
      .where(whereCondition)
      .get()!;
    const total = countResult.count;

    const rows = this.db
      .select({ id: schema.workflows.id, definition: schema.workflows.definition, version: schema.workflows.version })
      .from(schema.workflows)
      .where(whereCondition)
      .orderBy(sql`rowid`)
      .limit(limit)
      .offset(offset)
      .all();

    const data = rows.map((r) => {
      const workflow = JSON.parse(r.definition) as WorkflowDefinition;
      workflow.version = r.version;
      return workflow;
    });
    return { data, total };
  }

  updateWorkflow(id: string, updates: Partial<WorkflowDefinition>): WorkflowDefinition {
    const txn = this.sqlite.transaction((): WorkflowDefinition => {
      const existing = this.getWorkflow(id);
      if (!existing) {
        throw new Error(`Workflow not found: ${id}`);
      }

      // Determine if this is a definition change (not just an active toggle)
      const isDefinitionChange = Object.keys(updates).some((k) => k !== 'active' && k !== 'id' && k !== 'version');

      // Auto-increment version on definition changes
      const currentVersion = existing.version ?? 1;
      const newVersion = isDefinitionChange ? currentVersion + 1 : currentVersion;

      const updated: WorkflowDefinition = { ...existing, ...updates, id, version: newVersion };
      this.db
        .update(schema.workflows)
        .set({
          name: updated.name,
          description: updated.description ?? null,
          active: updated.active ? 1 : 0,
          definition: JSON.stringify(updated),
          version: newVersion,
          updated_at: sql`datetime('now')`,
        })
        .where(eq(schema.workflows.id, id))
        .run();

      // Store the new version in workflow_versions when the version increments
      if (isDefinitionChange) {
        this.db
          .insert(schema.workflowVersions)
          .values({
            workflow_id: id,
            version: newVersion,
            definition: JSON.stringify(updated),
          })
          .onConflictDoNothing()
          .run();
      }
      return updated;
    });
    return txn();
  }

  deleteWorkflow(id: string): void {
    this.sqlite.transaction(() => {
      // Delete author chat segments (instanceId='author', stageId=workflowId)
      this.db
        .delete(schema.segments)
        .where(and(eq(schema.segments.instance_id, 'author'), eq(schema.segments.stage_id, id)))
        .run();
      this.db
        .delete(schema.toolCalls)
        .where(and(eq(schema.toolCalls.instance_id, 'author'), eq(schema.toolCalls.stage_id, id)))
        .run();
      // Delete version history
      this.db.delete(schema.workflowVersions).where(eq(schema.workflowVersions.workflow_id, id)).run();
      // Detach instances so they survive workflow deletion (FK is enforced)
      this.db
        .update(schema.instances)
        .set({ definition_id: null })
        .where(eq(schema.instances.definition_id, id))
        .run();
      // Delete the workflow itself
      this.db.delete(schema.workflows).where(eq(schema.workflows.id, id)).run();
    })();
  }

  deleteTestWorkflows(): number {
    const testRows = this.db
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(eq(schema.workflows.is_test, 1))
      .all();
    if (testRows.length === 0) return 0;
    const deleteAll = this.sqlite.transaction(() => {
      for (const row of testRows) {
        this.deleteWorkflow(row.id);
      }
    });
    deleteAll();
    return testRows.length;
  }

  // ---------------------------------------------------------------------------
  // Instance CRUD
  // ---------------------------------------------------------------------------

  createInstance(input: Omit<WorkflowInstance, 'id' | 'created_at' | 'updated_at'>): WorkflowInstance {
    const id = uuidv4();
    const now = new Date().toISOString();
    const instance: WorkflowInstance = {
      id,
      created_at: now,
      updated_at: now,
      ...input,
      // Apply defaults for new lineage fields after spread so callers can override
      initiated_by: input.initiated_by ?? 'user',
      resume_count: input.resume_count ?? 0,
    };
    this.db.insert(schema.instances).values({
      id: instance.id,
      definition_id: instance.definition_id ?? null,
      definition_version: instance.definition_version ?? null,
      status: instance.status,
      trigger_event: JSON.stringify(instance.trigger_event),
      context: JSON.stringify(instance.context),
      current_stage_ids: JSON.stringify(instance.current_stage_ids),
      restate_workflow_id: instance.restate_workflow_id ?? null,
      is_test: instance.is_test ? 1 : 0,
      initiated_by: instance.initiated_by ?? 'user',
      resume_count: instance.resume_count ?? 0,
      created_at: instance.created_at,
      updated_at: instance.updated_at,
      completed_at: instance.completed_at ?? null,
    }).run();
    return instance;
  }

  getInstance(id: string): WorkflowInstance | null {
    const row = this.db
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, id))
      .get();
    if (!row) return null;
    return this.rowToInstance(row);
  }

  listInstances(filter?: {
    status?: string;
    definitionId?: string;
    includeTest?: boolean;
    initiatedBy?: InitiatedBy;
    limit?: number;
    offset?: number;
  }): { data: WorkflowInstance[]; total: number } {
    const limit = Math.min(filter?.limit ?? 50, 200);
    const offset = filter?.offset ?? 0;

    const conditions = [];
    if (filter?.status) conditions.push(eq(schema.instances.status, filter.status));
    if (filter?.definitionId) conditions.push(eq(schema.instances.definition_id, filter.definitionId));
    if (!filter?.includeTest) conditions.push(eq(schema.instances.is_test, 0));
    if (filter?.initiatedBy) conditions.push(eq(schema.instances.initiated_by, filter.initiatedBy));
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.instances)
      .where(whereCondition)
      .get()!;
    const total = countResult.count;

    const cols = {
      id: schema.instances.id,
      definition_id: schema.instances.definition_id,
      definition_version: schema.instances.definition_version,
      status: schema.instances.status,
      trigger_event: schema.instances.trigger_event,
      context: schema.instances.context,
      current_stage_ids: schema.instances.current_stage_ids,
      restate_workflow_id: schema.instances.restate_workflow_id,
      is_test: schema.instances.is_test,
      initiated_by: schema.instances.initiated_by,
      resume_count: schema.instances.resume_count,
      created_at: schema.instances.created_at,
      updated_at: schema.instances.updated_at,
      completed_at: schema.instances.completed_at,
    };

    const rows = this.db
      .select(cols)
      .from(schema.instances)
      .where(whereCondition)
      .orderBy(desc(schema.instances.created_at))
      .limit(limit)
      .offset(offset)
      .all();

    const data = rows.map((r) => this.rowToInstance(r));
    return { data, total };
  }

  updateInstance(id: string, updates: Partial<WorkflowInstance>): void {
    const txn = this.sqlite.transaction(() => {
      const existing = this.getInstance(id);
      if (!existing) {
        throw new Error(`Instance not found: ${id}`);
      }
      const updated: WorkflowInstance = { ...existing, ...updates, id };
      this.db
        .update(schema.instances)
        .set({
          definition_id: updated.definition_id ?? null,
          status: updated.status,
          trigger_event: JSON.stringify(updated.trigger_event),
          context: JSON.stringify(updated.context),
          current_stage_ids: JSON.stringify(updated.current_stage_ids),
          restate_workflow_id: updated.restate_workflow_id ?? null,
          updated_at: sql`datetime('now')`,
          completed_at: updated.completed_at ?? null,
          resume_count: updated.resume_count ?? 0,
          initiated_by: updated.initiated_by ?? 'user',
        })
        .where(eq(schema.instances.id, id))
        .run();
    });
    txn();
  }

  /** Atomically flip a failed/cancelled instance to 'running'. Returns true if successful, false if the status was already changed (lost race). */
  atomicResumeInstance(id: string): boolean {
    const result = this.sqlite.prepare(
      `UPDATE instances SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('failed', 'cancelled')`
    ).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  deleteInstance(id: string): void {
    this.sqlite.transaction(() => {
      this.db.delete(schema.renderedPrompts).where(eq(schema.renderedPrompts.instance_id, id)).run();
      this.db.delete(schema.segments).where(eq(schema.segments.instance_id, id)).run();
      this.db.delete(schema.toolCalls).where(eq(schema.toolCalls.instance_id, id)).run();
      this.db.delete(schema.instances).where(eq(schema.instances.id, id)).run();
    })();
  }

  private rowToInstance(
    row: Pick<
      typeof schema.instances.$inferSelect,
      | 'id'
      | 'definition_id'
      | 'definition_version'
      | 'status'
      | 'trigger_event'
      | 'context'
      | 'current_stage_ids'
      | 'restate_workflow_id'
      | 'is_test'
      | 'initiated_by'
      | 'resume_count'
      | 'created_at'
      | 'updated_at'
      | 'completed_at'
    >,
  ): WorkflowInstance {
    return {
      id: row.id,
      definition_id: row.definition_id ?? null,
      definition_version: row.definition_version ?? undefined,
      status: row.status as WorkflowInstance['status'],
      trigger_event: JSON.parse(row.trigger_event),
      context: JSON.parse(row.context),
      current_stage_ids: row.current_stage_ids ? JSON.parse(row.current_stage_ids) : [],
      restate_workflow_id: row.restate_workflow_id ?? undefined,
      is_test: !!row.is_test,
      initiated_by: (row.initiated_by ?? 'user') as WorkflowInstance['initiated_by'],
      resume_count: row.resume_count ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Workflow Version History
  // ---------------------------------------------------------------------------

  getWorkflowVersion(workflowId: string, version: number): WorkflowDefinition | null {
    const row = this.db
      .select()
      .from(schema.workflowVersions)
      .where(
        and(
          eq(schema.workflowVersions.workflow_id, workflowId),
          eq(schema.workflowVersions.version, version),
        ),
      )
      .get();
    if (!row) return null;
    const def = JSON.parse(row.definition) as WorkflowDefinition;
    def.version = row.version;
    return def;
  }

  listWorkflowVersions(
    workflowId: string,
  ): Array<{ version: number; definition: WorkflowDefinition; created_at: string }> {
    const rows = this.db
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.workflow_id, workflowId))
      .orderBy(desc(schema.workflowVersions.version))
      .all();
    return rows.map((r) => {
      const def = JSON.parse(r.definition) as WorkflowDefinition;
      def.version = r.version;
      return { version: r.version, definition: def, created_at: r.created_at };
    });
  }

  getInstanceDefinition(instanceId: string): WorkflowDefinition | null {
    const instance = this.getInstance(instanceId);
    if (!instance) return null;
    // Try to fetch the exact version from workflow_versions
    if (instance.definition_id && instance.definition_version != null) {
      const versioned = this.getWorkflowVersion(instance.definition_id, instance.definition_version);
      if (versioned) return versioned;
    }
    // Fall back to current workflow definition (guard against null definition_id)
    if (!instance.definition_id) return null;
    return this.getWorkflow(instance.definition_id);
  }

  // ---------------------------------------------------------------------------
  // Provider methods
  // ---------------------------------------------------------------------------

  listProviders(): CustomProviderConfig[] {
    const rows = this.db.select().from(schema.providers).orderBy(sql`rowid`).all();
    return rows.map((r) => JSON.parse(r.config) as CustomProviderConfig);
  }

  registerProvider(config: CustomProviderConfig): void {
    this.db
      .insert(schema.providers)
      .values({
        id: config.id,
        name: config.name,
        type: config.type,
        config: JSON.stringify(config),
      })
      .onConflictDoUpdate({
        target: schema.providers.id,
        set: {
          name: config.name,
          type: config.type,
          config: JSON.stringify(config),
        },
      })
      .run();
  }

  deleteProvider(id: string): void {
    this.db.delete(schema.providers).where(eq(schema.providers.id, id)).run();
  }

  // ---------------------------------------------------------------------------
  // MCP Server registry methods
  // ---------------------------------------------------------------------------

  listMCPServers(): Array<MCPServerConfig & { id: string; description?: string }> {
    const rows = this.db.select().from(schema.mcpServers).orderBy(sql`rowid`).all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? undefined,
      command: r.command,
      args: JSON.parse(r.args) as string[],
      env: r.env ? (JSON.parse(r.env) as Record<string, string>) : undefined,
    }));
  }

  registerMCPServer(config: MCPServerConfig & { id: string; description?: string }): void {
    this.db
      .insert(schema.mcpServers)
      .values({
        id: config.id,
        name: config.name,
        description: config.description ?? null,
        command: config.command,
        args: JSON.stringify(config.args),
        env: config.env ? JSON.stringify(config.env) : null,
      })
      .onConflictDoUpdate({
        target: schema.mcpServers.id,
        set: {
          name: config.name,
          description: config.description ?? null,
          command: config.command,
          args: JSON.stringify(config.args),
          env: config.env ? JSON.stringify(config.env) : null,
        },
      })
      .run();
  }

  deleteMCPServer(id: string): void {
    this.db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, id)).run();
  }

  // ---------------------------------------------------------------------------
  // Rendered prompts
  // ---------------------------------------------------------------------------

  storeRenderedPrompt(instanceId: string, stageId: string, iteration: number, prompt: string): void {
    this.db
      .insert(schema.renderedPrompts)
      .values({ instance_id: instanceId, stage_id: stageId, iteration, prompt })
      .onConflictDoUpdate({
        target: [schema.renderedPrompts.instance_id, schema.renderedPrompts.stage_id, schema.renderedPrompts.iteration],
        set: { prompt },
      })
      .run();
  }

  getRenderedPrompt(
    instanceId: string,
    stageId: string,
    iteration?: number,
  ): { prompt: string; iteration: number; created_at: string } | null {
    const conditions = [
      eq(schema.renderedPrompts.instance_id, instanceId),
      eq(schema.renderedPrompts.stage_id, stageId),
      ...(iteration != null ? [eq(schema.renderedPrompts.iteration, iteration)] : []),
    ];
    const row = this.db
      .select({
        prompt: schema.renderedPrompts.prompt,
        iteration: schema.renderedPrompts.iteration,
        created_at: schema.renderedPrompts.created_at,
      })
      .from(schema.renderedPrompts)
      .where(and(...conditions))
      .orderBy(desc(schema.renderedPrompts.iteration))
      .limit(1)
      .get();
    return row ?? null;
  }

  // ---------------------------------------------------------------------------
  // Segments
  // ---------------------------------------------------------------------------

  appendSegment(
    instanceId: string,
    stageId: string,
    iteration: number,
    segmentType: 'text' | 'tool' | 'user',
    content?: string,
    toolCallId?: string,
  ): number {
    const insert = this.sqlite.transaction((): number => {
      const row = this.db
        .select({
          nextIndex: sql<number>`COALESCE(MAX(${schema.segments.segment_index}), -1) + 1`,
        })
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.instance_id, instanceId),
            eq(schema.segments.stage_id, stageId),
            eq(schema.segments.iteration, iteration),
          ),
        )
        .get()!;

      this.db.insert(schema.segments).values({
        instance_id: instanceId,
        stage_id: stageId,
        iteration,
        segment_index: row.nextIndex,
        segment_type: segmentType,
        content: content ?? null,
        tool_call_id: toolCallId ?? null,
        created_at: new Date().toISOString(),
      }).run();

      return row.nextIndex;
    });
    return insert();
  }

  appendToLastTextSegment(instanceId: string, stageId: string, iteration: number, text: string): void {
    const last = this.db
      .select({ id: schema.segments.id, segment_type: schema.segments.segment_type })
      .from(schema.segments)
      .where(
        and(
          eq(schema.segments.instance_id, instanceId),
          eq(schema.segments.stage_id, stageId),
          eq(schema.segments.iteration, iteration),
        ),
      )
      .orderBy(desc(schema.segments.segment_index))
      .limit(1)
      .get();

    if (last && last.segment_type === 'text') {
      this.db
        .update(schema.segments)
        .set({ content: sql`COALESCE(${schema.segments.content}, '') || ${text}` })
        .where(eq(schema.segments.id, last.id))
        .run();
    } else {
      this.appendSegment(instanceId, stageId, iteration, 'text', text);
    }
  }

  getSegments(
    instanceId: string,
    stageId: string,
    iteration?: number,
  ): Array<{
    id: number;
    segment_index: number;
    segment_type: string;
    content: string | null;
    tool_call: {
      id: string;
      title: string | null;
      kind: string | null;
      status: string;
      raw_input: string | null;
      raw_output: string | null;
      parent_tool_use_id: string | null;
      created_at: string;
      updated_at: string;
    } | null;
    created_at: string;
  }> {
    const conditions = [
      eq(schema.segments.instance_id, instanceId),
      eq(schema.segments.stage_id, stageId),
      ...(iteration != null ? [eq(schema.segments.iteration, iteration)] : []),
    ];

    const rows = this.db
      .select({
        id: schema.segments.id,
        segment_index: schema.segments.segment_index,
        segment_type: schema.segments.segment_type,
        content: schema.segments.content,
        created_at: schema.segments.created_at,
        tc_id: schema.toolCalls.id,
        tc_title: schema.toolCalls.title,
        tc_kind: schema.toolCalls.kind,
        tc_status: schema.toolCalls.status,
        tc_raw_input: schema.toolCalls.raw_input,
        tc_raw_output: schema.toolCalls.raw_output,
        tc_parent_tool_use_id: schema.toolCalls.parent_tool_use_id,
        tc_created_at: schema.toolCalls.created_at,
        tc_updated_at: schema.toolCalls.updated_at,
      })
      .from(schema.segments)
      .leftJoin(schema.toolCalls, eq(schema.segments.tool_call_id, schema.toolCalls.id))
      .where(and(...conditions))
      .orderBy(asc(schema.segments.segment_index))
      .all();

    return rows.map((r) => ({
      id: r.id!,
      segment_index: r.segment_index,
      segment_type: r.segment_type,
      content: r.content,
      tool_call: r.tc_id
        ? {
            id: r.tc_id,
            title: r.tc_title ?? null,
            kind: r.tc_kind ?? null,
            // status, created_at, updated_at are NOT NULL in the DB — only null in the row type due to LEFT JOIN
            status: r.tc_status!,
            raw_input: r.tc_raw_input ?? null,
            raw_output: r.tc_raw_output ?? null,
            parent_tool_use_id: r.tc_parent_tool_use_id ?? null,
            created_at: r.tc_created_at!,
            updated_at: r.tc_updated_at!,
          }
        : null,
      created_at: r.created_at,
    }));
  }

  deleteSegments(instanceId: string, stageId: string, iteration?: number): void {
    if (iteration != null) {
      this.db
        .delete(schema.toolCalls)
        .where(
          and(
            eq(schema.toolCalls.instance_id, instanceId),
            eq(schema.toolCalls.stage_id, stageId),
            eq(schema.toolCalls.iteration, iteration),
          ),
        )
        .run();
      this.db
        .delete(schema.segments)
        .where(
          and(
            eq(schema.segments.instance_id, instanceId),
            eq(schema.segments.stage_id, stageId),
            eq(schema.segments.iteration, iteration),
          ),
        )
        .run();
    } else {
      this.db
        .delete(schema.toolCalls)
        .where(
          and(eq(schema.toolCalls.instance_id, instanceId), eq(schema.toolCalls.stage_id, stageId)),
        )
        .run();
      this.db
        .delete(schema.segments)
        .where(
          and(eq(schema.segments.instance_id, instanceId), eq(schema.segments.stage_id, stageId)),
        )
        .run();
    }
  }

  migrateAuthorSegments(fromStageId: string, toStageId: string): number {
    const txn = this.sqlite.transaction(() => {
      const result = this.db
        .update(schema.segments)
        .set({ stage_id: toStageId })
        .where(and(eq(schema.segments.instance_id, 'author'), eq(schema.segments.stage_id, fromStageId)))
        .run();
      this.db
        .update(schema.toolCalls)
        .set({ stage_id: toStageId })
        .where(and(eq(schema.toolCalls.instance_id, 'author'), eq(schema.toolCalls.stage_id, fromStageId)))
        .run();
      return result.changes;
    });
    return txn();
  }

  copyAuthorSegments(fromStageId: string, toStageId: string): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO segments (instance_id, stage_id, iteration, segment_index, segment_type, content, tool_call_id, created_at)
        SELECT instance_id, ?, iteration, segment_index, segment_type, content, NULL, created_at
        FROM segments
        WHERE instance_id = 'author' AND stage_id = ?`,
      )
      .run(toStageId, fromStageId);
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  upsertToolCall(data: {
    id: string;
    instanceId: string;
    stageId: string;
    iteration: number;
    title?: string;
    kind?: string;
    status: string;
    rawInput?: string;
    rawOutput?: string;
    parentToolUseId?: string;
  }): void {
    this.db
      .insert(schema.toolCalls)
      .values({
        id: data.id,
        instance_id: data.instanceId,
        stage_id: data.stageId,
        iteration: data.iteration,
        title: data.title ?? null,
        kind: data.kind ?? null,
        status: data.status,
        raw_input: data.rawInput ?? null,
        raw_output: data.rawOutput ?? null,
        parent_tool_use_id: data.parentToolUseId ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    // Always update — the second phase may bring new data.
    // All optional fields use COALESCE so a missing value in one phase does not
    // wipe the other phase's data (e.g. tool_call has title but tool_call_update
    // does not — COALESCE preserves the original title).
    this.db
      .update(schema.toolCalls)
      .set({
        title: sql`COALESCE(${data.title ?? null}, ${schema.toolCalls.title})`,
        kind: sql`COALESCE(${data.kind ?? null}, ${schema.toolCalls.kind})`,
        status: data.status,
        raw_input: sql`COALESCE(${data.rawInput ?? null}, ${schema.toolCalls.raw_input})`,
        raw_output: sql`COALESCE(${data.rawOutput ?? null}, ${schema.toolCalls.raw_output})`,
        parent_tool_use_id: sql`COALESCE(${data.parentToolUseId ?? null}, ${schema.toolCalls.parent_tool_use_id})`,
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.toolCalls.id, data.id))
      .run();
  }

  sweepToolCallStatuses(
    instanceId: string,
    stageId: string,
    iteration: number,
    fromStatuses: string[],
    toStatus: string,
  ): number {
    if (fromStatuses.length === 0) return 0;
    const result = this.db
      .update(schema.toolCalls)
      .set({ status: toStatus, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(schema.toolCalls.instance_id, instanceId),
          eq(schema.toolCalls.stage_id, stageId),
          eq(schema.toolCalls.iteration, iteration),
          inArray(schema.toolCalls.status, fromStatuses),
        ),
      )
      .run();
    return result.changes;
  }

  getToolCalls(
    instanceId: string,
    stageId: string,
    iteration?: number,
  ): Array<{
    id: string;
    title: string | null;
    kind: string | null;
    status: string;
    raw_input: string | null;
    raw_output: string | null;
    created_at: string;
    updated_at: string;
  }> {
    const conditions = [
      eq(schema.toolCalls.instance_id, instanceId),
      eq(schema.toolCalls.stage_id, stageId),
      ...(iteration != null ? [eq(schema.toolCalls.iteration, iteration)] : []),
    ];
    return this.db
      .select({
        id: schema.toolCalls.id,
        title: schema.toolCalls.title,
        kind: schema.toolCalls.kind,
        status: schema.toolCalls.status,
        raw_input: schema.toolCalls.raw_input,
        raw_output: schema.toolCalls.raw_output,
        created_at: schema.toolCalls.created_at,
        updated_at: schema.toolCalls.updated_at,
      })
      .from(schema.toolCalls)
      .where(and(...conditions))
      .orderBy(asc(schema.toolCalls.created_at))
      .all();
  }

  // (Author messages removed — now uses segments table with instanceId='author')

  // ---------------------------------------------------------------------------
  // ACP Sessions
  // ---------------------------------------------------------------------------

  getAcpSession(key: string): { session_id: string; process_pid: number | null; status: string; model_name: string | null } | null {
    const row = this.db
      .select({
        session_id: schema.acpSessions.session_id,
        process_pid: schema.acpSessions.process_pid,
        status: schema.acpSessions.status,
        model_name: schema.acpSessions.model_name,
      })
      .from(schema.acpSessions)
      .where(eq(schema.acpSessions.key, key))
      .get();
    return row ?? null;
  }

  upsertAcpSession(key: string, sessionId: string, pid: number | null): void {
    this.db
      .insert(schema.acpSessions)
      .values({
        key,
        session_id: sessionId,
        process_pid: pid,
        status: 'active',
        updated_at: sql`datetime('now')`,
      })
      .onConflictDoUpdate({
        target: schema.acpSessions.key,
        set: {
          session_id: sessionId,
          process_pid: pid,
          status: 'active',
          updated_at: sql`datetime('now')`,
        },
      })
      .run();
  }

  markAcpSessionStatus(key: string, status: string): void {
    this.db
      .update(schema.acpSessions)
      .set({ status, updated_at: sql`datetime('now')` })
      .where(eq(schema.acpSessions.key, key))
      .run();
  }

  updateAcpSessionModel(key: string, modelName: string): void {
    this.db
      .update(schema.acpSessions)
      .set({ model_name: modelName, updated_at: sql`datetime('now')` })
      .where(eq(schema.acpSessions.key, key))
      .run();
  }

  /** Return all non-null process PIDs for sessions marked 'active'. */
  getActiveSessionPids(): number[] {
    const rows = this.db
      .select({ pid: schema.acpSessions.process_pid })
      .from(schema.acpSessions)
      .where(and(
        eq(schema.acpSessions.status, 'active'),
        sql`${schema.acpSessions.process_pid} IS NOT NULL`,
      ))
      .all();
    return rows.map(r => r.pid!).filter(p => p > 0);
  }

  clearAcpSessionPids(): void {
    this.db
      .update(schema.acpSessions)
      .set({ process_pid: null, status: 'error' })
      .where(eq(schema.acpSessions.status, 'active'))
      .run();
  }

  getActiveAcpSessions(): Array<{ key: string; session_id: string }> {
    return this.db
      .select({ key: schema.acpSessions.key, session_id: schema.acpSessions.session_id })
      .from(schema.acpSessions)
      .where(eq(schema.acpSessions.status, 'active'))
      .all();
  }

  // ---------------------------------------------------------------------------
  // Draft persistence
  // ---------------------------------------------------------------------------

  saveDraft(workflowId: string, draft: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const json = JSON.stringify(draft);
    this.db
      .insert(schema.workflowDrafts)
      .values({ workflow_id: workflowId, draft: json, updated_at: now })
      .onConflictDoUpdate({
        target: schema.workflowDrafts.workflow_id,
        set: { draft: json, updated_at: now },
      })
      .run();
  }

  getDraft(workflowId: string): Record<string, unknown> | null {
    const row = this.db
      .select({ draft: schema.workflowDrafts.draft })
      .from(schema.workflowDrafts)
      .where(eq(schema.workflowDrafts.workflow_id, workflowId))
      .get();
    return row ? (JSON.parse(row.draft) as Record<string, unknown>) : null;
  }

  deleteDraft(workflowId: string): void {
    this.db.delete(schema.workflowDrafts).where(eq(schema.workflowDrafts.workflow_id, workflowId)).run();
  }

  listDrafts(): Array<{ workflowId: string; updatedAt: string }> {
    const rows = this.db
      .select({ workflow_id: schema.workflowDrafts.workflow_id, updated_at: schema.workflowDrafts.updated_at })
      .from(schema.workflowDrafts)
      .orderBy(desc(schema.workflowDrafts.updated_at))
      .all();
    return rows.map((r) => ({ workflowId: r.workflow_id, updatedAt: r.updated_at }));
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .get();
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .insert(schema.settings)
      .values({ key, value, updated_at: sql`datetime('now')` })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value, updated_at: sql`datetime('now')` },
      })
      .run();
  }

  deleteSetting(key: string): void {
    this.db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db
      .select({ key: schema.settings.key, value: schema.settings.value })
      .from(schema.settings)
      .all();
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Draft aliases
  // ---------------------------------------------------------------------------

  registerDraftAlias(fromId: string, toId: string): void {
    const now = new Date().toISOString();
    this.db
      .insert(schema.draftAliases)
      .values({ from_id: fromId, to_id: toId, created_at: now })
      .onConflictDoUpdate({
        target: schema.draftAliases.from_id,
        set: { to_id: toId, created_at: now },
      })
      .run();
  }

  listDraftAliases(): Array<{ fromId: string; toId: string }> {
    const rows = this.db
      .select({ from_id: schema.draftAliases.from_id, to_id: schema.draftAliases.to_id })
      .from(schema.draftAliases)
      .all();
    return rows.map((r) => ({ fromId: r.from_id, toId: r.to_id }));
  }

  // ---------------------------------------------------------------------------
  // Test workflow helpers
  // ---------------------------------------------------------------------------

  /** Return all workflows flagged as is_test=1, in rowid (insertion) order. */
  listTestWorkflows(): WorkflowDefinition[] {
    const rows = this.db
      .select({ id: schema.workflows.id, definition: schema.workflows.definition, version: schema.workflows.version })
      .from(schema.workflows)
      .where(eq(schema.workflows.is_test, 1))
      .orderBy(sql`rowid`)
      .all();
    return rows.map((r) => {
      const workflow = JSON.parse(r.definition) as WorkflowDefinition;
      workflow.version = r.version;
      return workflow;
    });
  }

  /**
   * Returns true if the given workflow definition has at least one instance in
   * a non-terminal state. Uses LIMIT 1 so it never scans the full table.
   */
  hasNonTerminalInstances(definitionId: string): boolean {
    const row = this.sqlite
      .prepare<[string], { found: number }>(
        `SELECT 1 AS found FROM instances
         WHERE definition_id = ?
           AND status IN ('running', 'waiting_gate', 'waiting_input', 'pending')
         LIMIT 1`,
      )
      .get(definitionId);
    return row !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Pending author messages
  // ---------------------------------------------------------------------------

  addPendingAuthorMessage(msg: { workflow_id: string; text: string; kind: 'system' | 'user' }): void {
    this.db.insert(schema.pendingAuthorMessages).values({
      workflow_id: msg.workflow_id,
      text: msg.text,
      kind: msg.kind,
    }).run();
  }

  /**
   * Atomically delete and return all pending messages for a workflow.
   * Idempotent under concurrent calls — the second call returns [].
   */
  flushPendingAuthorMessages(workflowId: string): PendingAuthorMessage[] {
    const rows = this.sqlite.transaction((): PendingAuthorMessage[] => {
      const fetched = this.sqlite
        .prepare<[string], { id: number; workflow_id: string; text: string; kind: string; created_at: string }>(
          'SELECT id, workflow_id, text, kind, created_at FROM pending_author_messages WHERE workflow_id = ? ORDER BY id',
        )
        .all(workflowId);
      if (fetched.length > 0) {
        this.sqlite
          .prepare('DELETE FROM pending_author_messages WHERE workflow_id = ?')
          .run(workflowId);
      }
      return fetched.map((r) => ({
        id: r.id,
        workflow_id: r.workflow_id,
        text: r.text,
        kind: r.kind as 'system' | 'user',
        created_at: r.created_at,
      }));
    })();
    return rows;
  }

  listPendingAuthorMessages(workflowId: string): PendingAuthorMessage[] {
    const rows = this.db
      .select()
      .from(schema.pendingAuthorMessages)
      .where(eq(schema.pendingAuthorMessages.workflow_id, workflowId))
      .orderBy(asc(schema.pendingAuthorMessages.id))
      .all();
    return rows.map((r) => ({
      id: r.id!,
      workflow_id: r.workflow_id,
      text: r.text,
      kind: r.kind as 'system' | 'user',
      created_at: r.created_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // Node templates
  // ---------------------------------------------------------------------------

  getNodeTemplate(id: string): NodeTemplateRow | undefined {
    const row = this.sqlite
      .prepare<[string], RawNodeTemplateRow>(
        'SELECT id, name, description, node_type, icon, category, config, exposed, locked, version, source, created_at, updated_at FROM node_templates WHERE id = ?',
      )
      .get(id);
    return row ? parseNodeTemplateRow(row) : undefined;
  }

  listNodeTemplates(filter?: { nodeType?: string; source?: string }): NodeTemplateRow[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filter?.nodeType) {
      conditions.push('node_type = ?');
      params.push(filter.nodeType);
    }
    if (filter?.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.sqlite
      .prepare<string[], RawNodeTemplateRow>(
        `SELECT id, name, description, node_type, icon, category, config, exposed, locked, version, source, created_at, updated_at FROM node_templates ${where} ORDER BY name`,
      )
      .all(...params);
    return rows.map(parseNodeTemplateRow);
  }

  createNodeTemplate(template: CreateNodeTemplate): NodeTemplateRow {
    const id = template.id ?? uuidv4();
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO node_templates (id, name, description, node_type, icon, category, config, exposed, locked, version, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        template.name,
        template.description ?? null,
        template.nodeType,
        template.icon ?? null,
        template.category ?? null,
        JSON.stringify(template.config),
        JSON.stringify(template.exposed ?? []),
        JSON.stringify(template.locked ?? []),
        template.source ?? 'local',
        now,
        now,
      );
    return this.getNodeTemplate(id)!;
  }

  updateNodeTemplate(id: string, updates: Partial<CreateNodeTemplate>): NodeTemplateRow | undefined {
    const existing = this.getNodeTemplate(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE node_templates SET
           name = ?, description = ?, node_type = ?, icon = ?, category = ?,
           config = ?, exposed = ?, locked = ?, source = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updates.name ?? existing.name,
        updates.description !== undefined ? (updates.description ?? null) : existing.description,
        updates.nodeType ?? existing.node_type,
        updates.icon !== undefined ? (updates.icon ?? null) : existing.icon,
        updates.category !== undefined ? (updates.category ?? null) : existing.category,
        updates.config !== undefined ? JSON.stringify(updates.config) : JSON.stringify(existing.config),
        updates.exposed !== undefined ? JSON.stringify(updates.exposed) : JSON.stringify(existing.exposed),
        updates.locked !== undefined ? JSON.stringify(updates.locked) : JSON.stringify(existing.locked),
        updates.source ?? existing.source,
        now,
        id,
      );
    return this.getNodeTemplate(id);
  }

  deleteNodeTemplate(id: string): boolean {
    const result = this.sqlite.prepare('DELETE FROM node_templates WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Gates (durable wait state for engine)
  // ---------------------------------------------------------------------------

  getGate(instanceId: string, stageId: string, kind: 'gate' | 'stage-complete'): GateRow | null {
    const row = this.sqlite
      .prepare<[string, string, string], RawGateRow>(
        'SELECT instance_id, stage_id, kind, status, payload, created_at, resolved_at FROM gates WHERE instance_id = ? AND stage_id = ? AND kind = ?',
      )
      .get(instanceId, stageId, kind);
    return row ? parseGateRow(row) : null;
  }

  upsertWaitingGate(instanceId: string, stageId: string, kind: 'gate' | 'stage-complete'): void {
    this.sqlite
      .prepare(
        `INSERT INTO gates (instance_id, stage_id, kind, status)
         VALUES (?, ?, ?, 'waiting')
         ON CONFLICT (instance_id, stage_id, kind) DO UPDATE SET
           status = CASE WHEN status = 'waiting' THEN 'waiting' ELSE status END`,
      )
      .run(instanceId, stageId, kind);
  }

  resolveGate(instanceId: string, stageId: string, kind: 'gate' | 'stage-complete', payload: unknown): void {
    this.sqlite
      .prepare(
        `INSERT INTO gates (instance_id, stage_id, kind, status, payload, resolved_at)
         VALUES (?, ?, ?, 'resolved', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (instance_id, stage_id, kind) DO UPDATE SET
           status = 'resolved',
           payload = excluded.payload,
           resolved_at = excluded.resolved_at`,
      )
      .run(instanceId, stageId, kind, JSON.stringify(payload));
  }

  rejectGate(instanceId: string, stageId: string, kind: 'gate' | 'stage-complete', reason: unknown): void {
    this.sqlite
      .prepare(
        `INSERT INTO gates (instance_id, stage_id, kind, status, payload, resolved_at)
         VALUES (?, ?, ?, 'rejected', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (instance_id, stage_id, kind) DO UPDATE SET
           status = 'rejected',
           payload = excluded.payload,
           resolved_at = excluded.resolved_at`,
      )
      .run(instanceId, stageId, kind, JSON.stringify(reason));
  }

  listWaitingGatesForInstance(instanceId: string): GateRow[] {
    const rows = this.sqlite
      .prepare<[string], RawGateRow>(
        `SELECT instance_id, stage_id, kind, status, payload, created_at, resolved_at
         FROM gates WHERE instance_id = ? AND status = 'waiting'`,
      )
      .all(instanceId);
    return rows.map(parseGateRow);
  }

  clearGatesForInstance(instanceId: string): void {
    this.sqlite.prepare('DELETE FROM gates WHERE instance_id = ?').run(instanceId);
  }

  // ---------------------------------------------------------------------------
  // Scheduled timers (durable timers for engine)
  // ---------------------------------------------------------------------------

  createScheduledTimer(params: {
    id?: string;
    instanceId: string;
    stageId: string;
    kind: string;
    fireAt: string;
    payload?: unknown;
  }): ScheduledTimerRow {
    const id = params.id ?? uuidv4();
    this.sqlite
      .prepare(
        `INSERT INTO scheduled_timers (id, instance_id, stage_id, kind, fire_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.instanceId,
        params.stageId,
        params.kind,
        params.fireAt,
        params.payload !== undefined ? JSON.stringify(params.payload) : null,
      );
    return this.getScheduledTimer(id)!;
  }

  getScheduledTimer(id: string): ScheduledTimerRow | null {
    const row = this.sqlite
      .prepare<[string], RawScheduledTimerRow>(
        'SELECT id, instance_id, stage_id, kind, fire_at, payload, created_at FROM scheduled_timers WHERE id = ?',
      )
      .get(id);
    return row ? parseScheduledTimerRow(row) : null;
  }

  deleteScheduledTimer(id: string): void {
    this.sqlite.prepare('DELETE FROM scheduled_timers WHERE id = ?').run(id);
  }

  /** Returns all timers with fire_at <= now, ordered by fire_at ascending. */
  listPendingTimers(): ScheduledTimerRow[] {
    const rows = this.sqlite
      .prepare<[], RawScheduledTimerRow>(
        `SELECT id, instance_id, stage_id, kind, fire_at, payload, created_at
         FROM scheduled_timers
         WHERE fire_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY fire_at ASC`,
      )
      .all();
    return rows.map(parseScheduledTimerRow);
  }

  clearTimersForInstance(instanceId: string): void {
    this.sqlite.prepare('DELETE FROM scheduled_timers WHERE instance_id = ?').run(instanceId);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.sqlite.close();
  }
}
