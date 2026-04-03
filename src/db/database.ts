import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { WorkflowDefinition, MCPServerConfig } from '../types/workflow.js';
import type { WorkflowInstance } from '../types/instance.js';
import type { CustomProviderConfig } from '../types/events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

interface WorkflowRow {
  id: string;
  definition: string;
  version: number;
}

interface InstanceRow {
  id: string;
  definition_id: string;
  definition_version: number | null;
  status: string;
  trigger_event: string;
  context: string;
  current_stage_ids: string | null;
  restate_workflow_id: string | null;
  is_test: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface WorkflowVersionRow {
  workflow_id: string;
  version: number;
  definition: string;
  created_at: string;
}

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  config: string;
}

interface MCPServerRow {
  id: string;
  name: string;
  description: string | null;
  command: string;
  args: string;
  env: string | null;
}

interface MigrationRow {
  name: string;
}

export class OrchestratorDB {
  private db: Database.Database;

  constructor(dbPath: string = process.env.DATABASE_PATH || './data/orchestrator.db') {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
  }

  private runMigrations(): void {
    // Ensure _migrations tracking table exists first
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Handle legacy table rename: old DBs used 'pipelines', code now uses 'workflows'
    const tables = this.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pipelines', 'workflows')",
      )
      .all();
    const tableNames = new Set(tables.map((t) => t.name));
    if (tableNames.has('pipelines') && !tableNames.has('workflows')) {
      this.db.exec('ALTER TABLE pipelines RENAME TO workflows');
      console.log('[db] Renamed table: pipelines → workflows');
    }

    const appliedStmt = this.db.prepare<[], MigrationRow>('SELECT name FROM _migrations ORDER BY name');
    const applied = new Set(appliedStmt.all().map((r) => r.name));

    let migrationFiles: string[];
    try {
      migrationFiles = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      // Migrations directory not readable — skip (shouldn't happen in normal use)
      return;
    }

    const runMigration = this.db.transaction((name: string, sql: string) => {
      this.db.exec(sql);
      this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });

    for (const file of migrationFiles) {
      if (!applied.has(file)) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
        runMigration(file, sql);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Workflow CRUD
  // ---------------------------------------------------------------------------

  createWorkflow(
    input: Omit<WorkflowDefinition, 'id'> & { id?: string },
    opts?: { isTest?: boolean },
  ): WorkflowDefinition {
    const id = uuidv4();
    const { id: _inputId, ...rest } = input as Omit<WorkflowDefinition, 'id'> & { id?: string };
    const workflow: WorkflowDefinition = { ...rest, id, version: 1 };
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, description, active, definition, is_test, version)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        id,
        workflow.name,
        workflow.description ?? null,
        workflow.active ? 1 : 0,
        JSON.stringify(workflow),
        opts?.isTest ? 1 : 0,
      );
    // Store version 1 in workflow_versions
    this.db
      .prepare(
        `INSERT INTO workflow_versions (workflow_id, version, definition)
         VALUES (?, 1, ?)`,
      )
      .run(id, JSON.stringify(workflow));
    return workflow;
  }

  getWorkflow(id: string): WorkflowDefinition | null {
    const row = this.db
      .prepare<[string], WorkflowRow>('SELECT id, definition, version FROM workflows WHERE id = ?')
      .get(id);
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
    const whereClause = opts?.includeTest ? '' : 'WHERE is_test = 0';
    const total = (this.db.prepare(`SELECT COUNT(*) as count FROM workflows ${whereClause}`).get() as { count: number })
      .count;
    const sql = `SELECT id, definition, version FROM workflows ${whereClause} ORDER BY rowid LIMIT ? OFFSET ?`;
    const rows = this.db.prepare<[number, number], WorkflowRow>(sql).all(limit, offset);
    const data = rows.map((r) => {
      const workflow = JSON.parse(r.definition) as WorkflowDefinition;
      workflow.version = r.version;
      return workflow;
    });
    return { data, total };
  }

  updateWorkflow(id: string, updates: Partial<WorkflowDefinition>): WorkflowDefinition {
    const txn = this.db.transaction((): WorkflowDefinition => {
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
        .prepare(
          `UPDATE workflows
           SET name = ?, description = ?, active = ?, definition = ?, version = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(
          updated.name,
          updated.description ?? null,
          updated.active ? 1 : 0,
          JSON.stringify(updated),
          newVersion,
          id,
        );
      // Store the new version in workflow_versions when the version increments
      if (isDefinitionChange) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_versions (workflow_id, version, definition)
             VALUES (?, ?, ?)`,
          )
          .run(id, newVersion, JSON.stringify(updated));
      }
      return updated;
    });
    return txn();
  }

  deleteWorkflow(id: string): void {
    // Delete author chat segments (instanceId='author', stageId=workflowId)
    this.db.prepare('DELETE FROM segments WHERE instance_id = ? AND stage_id = ?').run('author', id);
    this.db.prepare('DELETE FROM tool_calls WHERE instance_id = ? AND stage_id = ?').run('author', id);
    // Delete version history
    this.db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(id);
    // Detach instances so they survive workflow deletion (FK is enforced)
    this.db.prepare('UPDATE instances SET definition_id = NULL WHERE definition_id = ?').run(id);
    // Delete the workflow itself
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  }

  deleteTestWorkflows(): number {
    const testRows = this.db.prepare('SELECT id FROM workflows WHERE is_test = 1').all() as { id: string }[];
    if (testRows.length === 0) return 0;
    const deleteAll = this.db.transaction(() => {
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
    };
    this.db
      .prepare(
        `INSERT INTO instances
           (id, definition_id, definition_version, status, trigger_event, context, current_stage_ids,
            restate_workflow_id, is_test, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instance.id,
        instance.definition_id,
        instance.definition_version ?? null,
        instance.status,
        JSON.stringify(instance.trigger_event),
        JSON.stringify(instance.context),
        JSON.stringify(instance.current_stage_ids),
        instance.restate_workflow_id ?? null,
        instance.is_test ? 1 : 0,
        instance.created_at,
        instance.updated_at,
        instance.completed_at ?? null,
      );
    return instance;
  }

  getInstance(id: string): WorkflowInstance | null {
    const row = this.db.prepare<[string], InstanceRow>('SELECT * FROM instances WHERE id = ?').get(id);
    if (!row) return null;
    return this.rowToInstance(row);
  }

  listInstances(filter?: {
    status?: string;
    definitionId?: string;
    includeTest?: boolean;
    limit?: number;
    offset?: number;
  }): { data: WorkflowInstance[]; total: number } {
    const limit = Math.min(filter?.limit ?? 50, 200);
    const offset = filter?.offset ?? 0;
    const baseSelect = `SELECT id, definition_id, definition_version, status, trigger_event, context, current_stage_ids, restate_workflow_id, is_test, created_at, updated_at, completed_at FROM instances`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.definitionId) {
      conditions.push('definition_id = ?');
      params.push(filter.definitionId);
    }
    if (!filter?.includeTest) {
      conditions.push('is_test = 0');
    }
    const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM instances${whereClause}`).get(...params) as { count: number }
    ).count;

    const sql = `${baseSelect}${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare<(string | number)[], InstanceRow>(sql).all(...params, limit, offset);
    const data = rows.map((r) => this.rowToInstance(r));
    return { data, total };
  }

  updateInstance(id: string, updates: Partial<WorkflowInstance>): void {
    const txn = this.db.transaction(() => {
      const existing = this.getInstance(id);
      if (!existing) {
        throw new Error(`Instance not found: ${id}`);
      }
      const updated: WorkflowInstance = { ...existing, ...updates, id };
      this.db
        .prepare(
          `UPDATE instances
           SET definition_id = ?, status = ?, trigger_event = ?, context = ?,
               current_stage_ids = ?, restate_workflow_id = ?, updated_at = datetime('now'),
               completed_at = ?
           WHERE id = ?`,
        )
        .run(
          updated.definition_id,
          updated.status,
          JSON.stringify(updated.trigger_event),
          JSON.stringify(updated.context),
          JSON.stringify(updated.current_stage_ids),
          updated.restate_workflow_id ?? null,
          updated.completed_at ?? null,
          id,
        );
    });
    txn();
  }

  deleteInstance(id: string): void {
    this.db.prepare('DELETE FROM rendered_prompts WHERE instance_id = ?').run(id);
    this.db.prepare('DELETE FROM segments WHERE instance_id = ?').run(id);
    this.db.prepare('DELETE FROM tool_calls WHERE instance_id = ?').run(id);
    this.db.prepare('DELETE FROM instances WHERE id = ?').run(id);
  }

  private rowToInstance(row: InstanceRow): WorkflowInstance {
    return {
      id: row.id,
      definition_id: row.definition_id,
      definition_version: row.definition_version ?? undefined,
      status: row.status as WorkflowInstance['status'],
      trigger_event: JSON.parse(row.trigger_event),
      context: JSON.parse(row.context),
      current_stage_ids: row.current_stage_ids ? JSON.parse(row.current_stage_ids) : [],
      restate_workflow_id: row.restate_workflow_id ?? undefined,
      is_test: !!row.is_test,
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
      .prepare<[string, number], WorkflowVersionRow>(
        'SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?',
      )
      .get(workflowId, version);
    if (!row) return null;
    const def = JSON.parse(row.definition) as WorkflowDefinition;
    def.version = row.version;
    return def;
  }

  listWorkflowVersions(
    workflowId: string,
  ): Array<{ version: number; definition: WorkflowDefinition; created_at: string }> {
    const rows = this.db
      .prepare<[string], WorkflowVersionRow>(
        'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC',
      )
      .all(workflowId);
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
    if (instance.definition_version != null) {
      const versioned = this.getWorkflowVersion(instance.definition_id, instance.definition_version);
      if (versioned) return versioned;
    }
    // Fall back to current workflow definition
    return this.getWorkflow(instance.definition_id);
  }

  // ---------------------------------------------------------------------------
  // Provider methods
  // ---------------------------------------------------------------------------

  listProviders(): CustomProviderConfig[] {
    const rows = this.db.prepare<[], ProviderRow>('SELECT * FROM providers ORDER BY rowid').all();
    return rows.map((r) => JSON.parse(r.config) as CustomProviderConfig);
  }

  registerProvider(config: CustomProviderConfig): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO providers (id, name, type, config)
         VALUES (?, ?, ?, ?)`,
      )
      .run(config.id, config.name, config.type, JSON.stringify(config));
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------------------
  // MCP Server registry methods
  // ---------------------------------------------------------------------------

  listMCPServers(): Array<MCPServerConfig & { id: string; description?: string }> {
    const rows = this.db.prepare<[], MCPServerRow>('SELECT * FROM mcp_servers ORDER BY rowid').all();
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
      .prepare(
        `INSERT OR REPLACE INTO mcp_servers (id, name, description, command, args, env)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.id,
        config.name,
        config.description ?? null,
        config.command,
        JSON.stringify(config.args),
        config.env ? JSON.stringify(config.env) : null,
      );
  }

  deleteMCPServer(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------------------
  // Rendered prompts
  // ---------------------------------------------------------------------------

  storeRenderedPrompt(instanceId: string, stageId: string, iteration: number, prompt: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rendered_prompts (instance_id, stage_id, iteration, prompt)
       VALUES (?, ?, ?, ?)`,
      )
      .run(instanceId, stageId, iteration, prompt);
  }

  getRenderedPrompt(
    instanceId: string,
    stageId: string,
    iteration?: number,
  ): { prompt: string; iteration: number; created_at: string } | null {
    let sql = 'SELECT prompt, iteration, created_at FROM rendered_prompts WHERE instance_id = ? AND stage_id = ?';
    const params: (string | number)[] = [instanceId, stageId];
    if (iteration != null) {
      sql += ' AND iteration = ?';
      params.push(iteration);
    }
    sql += ' ORDER BY iteration DESC LIMIT 1';
    return (this.db.prepare(sql).get(...params) as { prompt: string; iteration: number; created_at: string } | undefined) ?? null;
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
    const insert = this.db.transaction((): number => {
      const row = this.db
        .prepare(
          `SELECT COALESCE(MAX(segment_index), -1) + 1 AS next_index
         FROM segments WHERE instance_id = ? AND stage_id = ? AND iteration = ?`,
        )
        .get(instanceId, stageId, iteration) as { next_index: number };
      const segmentIndex = row.next_index;
      this.db
        .prepare(
          `INSERT INTO segments (instance_id, stage_id, iteration, segment_index, segment_type, content, tool_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(instanceId, stageId, iteration, segmentIndex, segmentType, content ?? null, toolCallId ?? null);
      return segmentIndex;
    });
    return insert();
  }

  appendToLastTextSegment(instanceId: string, stageId: string, iteration: number, text: string): void {
    // Try to append to the last segment if it's a text segment
    const last = this.db
      .prepare(
        `SELECT id, segment_type FROM segments
       WHERE instance_id = ? AND stage_id = ? AND iteration = ?
       ORDER BY segment_index DESC LIMIT 1`,
      )
      .get(instanceId, stageId, iteration) as { id: number; segment_type: string } | undefined;

    if (last && last.segment_type === 'text') {
      this.db.prepare(`UPDATE segments SET content = COALESCE(content, '') || ? WHERE id = ?`).run(text, last.id);
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
    let sql = `SELECT s.id, s.segment_index, s.segment_type, s.content, s.tool_call_id, s.created_at,
                      tc.id AS tc_id, tc.title AS tc_title, tc.kind AS tc_kind, tc.status AS tc_status,
                      tc.raw_input AS tc_raw_input, tc.raw_output AS tc_raw_output,
                      tc.parent_tool_use_id AS tc_parent_tool_use_id,
                      tc.created_at AS tc_created_at, tc.updated_at AS tc_updated_at
               FROM segments s
               LEFT JOIN tool_calls tc ON s.tool_call_id = tc.id
               WHERE s.instance_id = ? AND s.stage_id = ?`;
    const params: (string | number)[] = [instanceId, stageId];

    if (iteration != null) {
      sql += ' AND s.iteration = ?';
      params.push(iteration);
    }
    sql += ' ORDER BY s.segment_index ASC';

    interface SegmentJoinRow {
      id: number;
      segment_index: number;
      segment_type: string;
      content: string | null;
      tc_id: string | null;
      tc_title: string | null;
      tc_kind: string | null;
      tc_status: string | null;
      tc_raw_input: string | null;
      tc_raw_output: string | null;
      tc_parent_tool_use_id: string | null;
      tc_created_at: string | null;
      tc_updated_at: string | null;
      created_at: string;
    }
    const rows = this.db.prepare(sql).all(...params) as SegmentJoinRow[];
    return rows.map((r) => ({
      id: r.id,
      segment_index: r.segment_index,
      segment_type: r.segment_type,
      content: r.content,
      tool_call: r.tc_id
        ? {
            id: r.tc_id,
            title: r.tc_title,
            kind: r.tc_kind,
            // status, created_at, updated_at are NOT NULL in the DB — only null in the row type due to LEFT JOIN
            status: r.tc_status!,
            raw_input: r.tc_raw_input,
            raw_output: r.tc_raw_output,
            parent_tool_use_id: r.tc_parent_tool_use_id,
            created_at: r.tc_created_at!,
            updated_at: r.tc_updated_at!,
          }
        : null,
      created_at: r.created_at,
    }));
  }

  deleteSegments(instanceId: string, stageId: string, iteration?: number): void {
    if (iteration != null) {
      // Also delete associated tool calls
      this.db
        .prepare('DELETE FROM tool_calls WHERE instance_id = ? AND stage_id = ? AND iteration = ?')
        .run(instanceId, stageId, iteration);
      this.db
        .prepare('DELETE FROM segments WHERE instance_id = ? AND stage_id = ? AND iteration = ?')
        .run(instanceId, stageId, iteration);
    } else {
      this.db.prepare('DELETE FROM tool_calls WHERE instance_id = ? AND stage_id = ?').run(instanceId, stageId);
      this.db.prepare('DELETE FROM segments WHERE instance_id = ? AND stage_id = ?').run(instanceId, stageId);
    }
  }

  migrateAuthorSegments(fromStageId: string, toStageId: string): number {
    const result = this.db
      .prepare(`UPDATE segments SET stage_id = ? WHERE instance_id = 'author' AND stage_id = ?`)
      .run(toStageId, fromStageId);
    this.db
      .prepare(`UPDATE tool_calls SET stage_id = ? WHERE instance_id = 'author' AND stage_id = ?`)
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
      .prepare(
        `INSERT OR IGNORE INTO tool_calls (id, instance_id, stage_id, iteration, title, kind, status, raw_input, raw_output, parent_tool_use_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.instanceId,
        data.stageId,
        data.iteration,
        data.title ?? null,
        data.kind ?? null,
        data.status,
        data.rawInput ?? null,
        data.rawOutput ?? null,
        data.parentToolUseId ?? null,
      );
    // Always update — the second phase may bring new data
    this.db
      .prepare(
        `UPDATE tool_calls SET
         title = COALESCE(?, title),
         kind = COALESCE(?, kind),
         status = ?,
         raw_input = COALESCE(?, raw_input),
         raw_output = COALESCE(?, raw_output),
         parent_tool_use_id = COALESCE(?, parent_tool_use_id),
         updated_at = datetime('now')
       WHERE id = ?`,
      )
      .run(data.title ?? null, data.kind ?? null, data.status, data.rawInput ?? null, data.rawOutput ?? null, data.parentToolUseId ?? null, data.id);
  }

  sweepToolCallStatuses(
    instanceId: string,
    stageId: string,
    iteration: number,
    fromStatuses: string[],
    toStatus: string,
  ): number {
    if (fromStatuses.length === 0) return 0;
    const placeholders = fromStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE tool_calls SET status = ?, updated_at = datetime('now')
       WHERE instance_id = ? AND stage_id = ? AND iteration = ? AND status IN (${placeholders})`,
      )
      .run(toStatus, instanceId, stageId, iteration, ...fromStatuses);
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
    let sql = 'SELECT * FROM tool_calls WHERE instance_id = ? AND stage_id = ?';
    const params: (string | number)[] = [instanceId, stageId];
    if (iteration != null) {
      sql += ' AND iteration = ?';
      params.push(iteration);
    }
    sql += ' ORDER BY created_at ASC';
    return this.db.prepare(sql).all(...params) as Array<{
      id: string;
      title: string | null;
      kind: string | null;
      status: string;
      raw_input: string | null;
      raw_output: string | null;
      created_at: string;
      updated_at: string;
    }>;
  }

  // (Author messages removed — now uses segments table with instanceId='author')

  // ---------------------------------------------------------------------------
  // ACP Sessions
  // ---------------------------------------------------------------------------

  getAcpSession(key: string): { session_id: string; process_pid: number | null; status: string; model_name: string | null } | null {
    return (
      (this.db.prepare('SELECT session_id, process_pid, status, model_name FROM acp_sessions WHERE key = ?').get(key) as
        | { session_id: string; process_pid: number | null; status: string; model_name: string | null }
        | undefined) ?? null
    );
  }

  upsertAcpSession(key: string, sessionId: string, pid: number | null): void {
    this.db
      .prepare(
        `INSERT INTO acp_sessions (key, session_id, process_pid, status, updated_at)
       VALUES (?, ?, ?, 'active', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET session_id = ?, process_pid = ?, status = 'active', updated_at = datetime('now')`,
      )
      .run(key, sessionId, pid, sessionId, pid);
  }

  markAcpSessionStatus(key: string, status: string): void {
    this.db.prepare("UPDATE acp_sessions SET status = ?, updated_at = datetime('now') WHERE key = ?").run(status, key);
  }

  updateAcpSessionModel(key: string, modelName: string): void {
    this.db.prepare("UPDATE acp_sessions SET model_name = ?, updated_at = datetime('now') WHERE key = ?").run(modelName, key);
  }

  clearAcpSessionPids(): void {
    this.db.prepare("UPDATE acp_sessions SET process_pid = NULL, status = 'error' WHERE status = 'active'").run();
  }

  getActiveAcpSessions(): Array<{ key: string; session_id: string }> {
    return this.db
      .prepare("SELECT key, session_id FROM acp_sessions WHERE status = 'active'")
      .all() as Array<{ key: string; session_id: string }>;
  }

  // ---------------------------------------------------------------------------
  // Draft persistence
  // ---------------------------------------------------------------------------

  saveDraft(workflowId: string, draft: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const json = JSON.stringify(draft);
    this.db
      .prepare(`
      INSERT INTO workflow_drafts (workflow_id, draft, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET draft = ?, updated_at = ?
    `)
      .run(workflowId, json, now, json, now);
  }

  getDraft(workflowId: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT draft FROM workflow_drafts WHERE workflow_id = ?').get(workflowId) as
      | { draft: string }
      | undefined;
    return row ? (JSON.parse(row.draft) as Record<string, unknown>) : null;
  }

  deleteDraft(workflowId: string): void {
    this.db.prepare('DELETE FROM workflow_drafts WHERE workflow_id = ?').run(workflowId);
  }

  listDrafts(): Array<{ workflowId: string; updatedAt: string }> {
    const rows = this.db
      .prepare('SELECT workflow_id, updated_at FROM workflow_drafts ORDER BY updated_at DESC')
      .all() as Array<{ workflow_id: string; updated_at: string }>;
    return rows.map((r) => ({ workflowId: r.workflow_id, updatedAt: r.updated_at }));
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      )
      .run(key, value, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
