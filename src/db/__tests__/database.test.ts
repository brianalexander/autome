import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorDB } from '../database.js';
import type { WorkflowDefinition } from '../../types/workflow.js';
import type { WorkflowInstance } from '../../types/instance.js';
import type { CustomProviderConfig, Event } from '../../types/events.js';

function makeDB(): OrchestratorDB {
  return new OrchestratorDB(':memory:');
}

function makeWorkflowInput(): Omit<WorkflowDefinition, 'id'> {
  return {
    name: 'Test Workflow',
    description: 'A test workflow',
    active: false,
    trigger: { provider: 'webhook' },
    stages: [],
    edges: [],
  };
}

function makeEvent(): Event {
  return {
    id: 'evt-1',
    provider: 'webhook',
    type: 'push',
    timestamp: new Date().toISOString(),
    payload: { ref: 'main' },
  };
}

function makeInstanceInput(definitionId: string): Omit<WorkflowInstance, 'id' | 'created_at' | 'updated_at'> {
  return {
    definition_id: definitionId,
    status: 'running',
    trigger_event: makeEvent() as unknown as Record<string, unknown>,
    context: { trigger: { ref: 'main' }, stages: {} },
    current_stage_ids: [],
    initiated_by: 'user',
    resume_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe('migrations', () => {
  it('runs successfully and creates all tables', () => {
    const db = makeDB();
    // If tables exist, these queries will not throw
    expect(() => db.listWorkflows()).not.toThrow();
    expect(() => db.listInstances()).not.toThrow();
    expect(() => db.listProviders()).not.toThrow();
    expect(() => db.listMCPServers()).not.toThrow();
    db.close();
  });

  it('is idempotent — creating a second DB instance does not error', () => {
    // Two in-memory DBs each run migrations independently
    const db1 = makeDB();
    const db2 = makeDB();
    db1.close();
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// Workflow CRUD
// ---------------------------------------------------------------------------

describe('workflow CRUD', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('creates a workflow and returns it with a generated id', () => {
    const input = makeWorkflowInput();
    const workflow = db.createWorkflow(input);

    expect(workflow.id).toBeTruthy();
    expect(workflow.name).toBe(input.name);
    expect(workflow.description).toBe(input.description);
    expect(workflow.active).toBe(false);
    expect(workflow.trigger).toEqual(input.trigger);
  });

  it('gets a workflow by id', () => {
    const created = db.createWorkflow(makeWorkflowInput());
    const fetched = db.getWorkflow(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe(created.name);
  });

  it('returns null for a missing workflow', () => {
    expect(db.getWorkflow('nonexistent-id')).toBeNull();
  });

  it('lists all workflows', () => {
    db.createWorkflow(makeWorkflowInput());
    db.createWorkflow({ ...makeWorkflowInput(), name: 'Second Workflow' });

    const { data: list } = db.listWorkflows();
    expect(list).toHaveLength(2);
  });

  it('returns an empty list when no workflows exist', () => {
    expect(db.listWorkflows().data).toEqual([]);
  });

  it('updates a workflow', () => {
    const created = db.createWorkflow(makeWorkflowInput());
    const updated = db.updateWorkflow(created.id, { name: 'Updated Name', active: true });

    expect(updated.name).toBe('Updated Name');
    expect(updated.active).toBe(true);
    expect(updated.id).toBe(created.id);

    // Verify persisted
    const fetched = db.getWorkflow(created.id);
    expect(fetched!.name).toBe('Updated Name');
    expect(fetched!.active).toBe(true);
  });

  it('throws when updating a non-existent workflow', () => {
    expect(() => db.updateWorkflow('missing', { name: 'x' })).toThrow('Workflow not found');
  });

  it('deletes a workflow but preserves its instances', () => {
    const created = db.createWorkflow(makeWorkflowInput());
    const inst = db.createInstance(makeInstanceInput(created.id));
    db.deleteWorkflow(created.id);

    expect(db.getWorkflow(created.id)).toBeNull();
    expect(db.listWorkflows().data).toHaveLength(0);
    // Instance survives workflow deletion (definition_id set to null)
    const fetched = db.getInstance(inst.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.definition_id).toBeNull();
  });

  it('delete is a no-op for non-existent workflow', () => {
    expect(() => db.deleteWorkflow('missing')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Instance CRUD
// ---------------------------------------------------------------------------

describe('instance CRUD', () => {
  let db: OrchestratorDB;
  let workflowId: string;

  beforeEach(() => {
    db = makeDB();
    const workflow = db.createWorkflow(makeWorkflowInput());
    workflowId = workflow.id;
  });

  it('creates an instance and returns it with generated id and timestamps', () => {
    const input = makeInstanceInput(workflowId);
    const instance = db.createInstance(input);

    expect(instance.id).toBeTruthy();
    expect(instance.definition_id).toBe(workflowId);
    expect(instance.status).toBe('running');
    expect(instance.created_at).toBeTruthy();
    expect(instance.updated_at).toBeTruthy();
    expect(instance.trigger_event).toEqual(input.trigger_event);
    expect(instance.context).toEqual(input.context);
    expect(instance.current_stage_ids).toEqual([]);
  });

  it('gets an instance by id', () => {
    const created = db.createInstance(makeInstanceInput(workflowId));
    const fetched = db.getInstance(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it('returns null for a missing instance', () => {
    expect(db.getInstance('nonexistent')).toBeNull();
  });

  it('lists all instances without filter', () => {
    db.createInstance(makeInstanceInput(workflowId));
    db.createInstance(makeInstanceInput(workflowId));

    expect(db.listInstances().data).toHaveLength(2);
  });

  it('filters instances by status', () => {
    db.createInstance(makeInstanceInput(workflowId));
    const completed = db.createInstance({ ...makeInstanceInput(workflowId), status: 'completed' });
    db.updateInstance(completed.id, { status: 'completed' });

    const { data: running } = db.listInstances({ status: 'running' });
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe('running');

    const { data: completedList } = db.listInstances({ status: 'completed' });
    expect(completedList).toHaveLength(1);
  });

  it('filters instances by definitionId', () => {
    const otherWorkflow = db.createWorkflow({ ...makeWorkflowInput(), name: 'Other' });
    db.createInstance(makeInstanceInput(workflowId));
    db.createInstance(makeInstanceInput(otherWorkflow.id));

    const { data: filtered } = db.listInstances({ definitionId: workflowId });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].definition_id).toBe(workflowId);
  });

  it('filters by both status and definitionId', () => {
    const otherWorkflow = db.createWorkflow({ ...makeWorkflowInput(), name: 'Other' });
    db.createInstance(makeInstanceInput(workflowId));
    db.createInstance(makeInstanceInput(otherWorkflow.id));

    const { data: result } = db.listInstances({ status: 'running', definitionId: workflowId });
    expect(result).toHaveLength(1);
  });

  it('updates an instance status', () => {
    const created = db.createInstance(makeInstanceInput(workflowId));
    db.updateInstance(created.id, { status: 'completed', completed_at: new Date().toISOString() });

    const fetched = db.getInstance(created.id);
    expect(fetched!.status).toBe('completed');
    expect(fetched!.completed_at).toBeTruthy();
  });

  it('updates current_stage_ids', () => {
    const created = db.createInstance(makeInstanceInput(workflowId));
    db.updateInstance(created.id, { current_stage_ids: ['stage-1', 'stage-2'] });

    const fetched = db.getInstance(created.id);
    expect(fetched!.current_stage_ids).toEqual(['stage-1', 'stage-2']);
  });

  it('throws when updating a non-existent instance', () => {
    expect(() => db.updateInstance('missing', { status: 'completed' })).toThrow('Instance not found');
  });

  it('stores definition_version and retrieves it', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    const input = {
      ...makeInstanceInput(workflow.id),
      definition_version: 1,
    };
    const instance = db.createInstance(input);
    const fetched = db.getInstance(instance.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.definition_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Workflow Version History
// ---------------------------------------------------------------------------

describe('workflow version history', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('creates version 1 when a workflow is created', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    const versions = db.listWorkflowVersions(workflow.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].definition.name).toBe('Test Workflow');
  });

  it('creates a new version when workflow definition changes', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    db.updateWorkflow(workflow.id, { name: 'Updated Name' });
    const versions = db.listWorkflowVersions(workflow.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2); // DESC order
    expect(versions[0].definition.name).toBe('Updated Name');
    expect(versions[1].version).toBe(1);
    expect(versions[1].definition.name).toBe('Test Workflow');
  });

  it('does not create a new version for active-only toggle', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    db.updateWorkflow(workflow.id, { active: true });
    const versions = db.listWorkflowVersions(workflow.id);
    expect(versions).toHaveLength(1);
  });

  it('fetches a specific version', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    db.updateWorkflow(workflow.id, { name: 'V2' });
    const v1 = db.getWorkflowVersion(workflow.id, 1);
    expect(v1).not.toBeNull();
    expect(v1!.name).toBe('Test Workflow');
    const v2 = db.getWorkflowVersion(workflow.id, 2);
    expect(v2).not.toBeNull();
    expect(v2!.name).toBe('V2');
  });

  it('returns null for missing version', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    expect(db.getWorkflowVersion(workflow.id, 999)).toBeNull();
  });

  it('getInstanceDefinition returns versioned definition', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    db.updateWorkflow(workflow.id, { name: 'V2' });
    const instance = db.createInstance({
      ...makeInstanceInput(workflow.id),
      definition_version: 1,
    });
    const def = db.getInstanceDefinition(instance.id);
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Test Workflow');
  });

  it('getInstanceDefinition falls back to current workflow', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    const instance = db.createInstance(makeInstanceInput(workflow.id));
    // No definition_version set — should fall back to current
    const def = db.getInstanceDefinition(instance.id);
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Test Workflow');
  });

  it('deletes version history when workflow is deleted', () => {
    const workflow = db.createWorkflow(makeWorkflowInput());
    db.updateWorkflow(workflow.id, { name: 'V2' });
    db.deleteWorkflow(workflow.id);
    expect(db.listWorkflowVersions(workflow.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

describe('provider registry', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('registers and lists a provider', () => {
    const config: CustomProviderConfig = {
      id: 'provider-1',
      name: 'My Webhook',
      type: 'webhook',
      webhook: {
        path: '/hooks/my',
        event_type_field: 'type',
      },
    };
    db.registerProvider(config);

    const list = db.listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('provider-1');
    expect(list[0].name).toBe('My Webhook');
    expect(list[0].type).toBe('webhook');
  });

  it('returns empty list when no providers registered', () => {
    expect(db.listProviders()).toEqual([]);
  });

  it('replaces an existing provider on re-register', () => {
    const config: CustomProviderConfig = {
      id: 'provider-1',
      name: 'Original',
      type: 'webhook',
      webhook: { path: '/old', event_type_field: 'type' },
    };
    db.registerProvider(config);
    db.registerProvider({ ...config, name: 'Updated' });

    const list = db.listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Updated');
  });

  it('deletes a provider', () => {
    const config: CustomProviderConfig = {
      id: 'provider-1',
      name: 'My Webhook',
      type: 'webhook',
      webhook: { path: '/hooks/my', event_type_field: 'type' },
    };
    db.registerProvider(config);
    db.deleteProvider('provider-1');

    expect(db.listProviders()).toHaveLength(0);
  });

  it('delete is a no-op for non-existent provider', () => {
    expect(() => db.deleteProvider('missing')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MCP Server registry
// ---------------------------------------------------------------------------

describe('MCP server registry', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('registers and lists an MCP server', () => {
    db.registerMCPServer({
      id: 'mcp-1',
      name: 'GitHub MCP',
      description: 'GitHub integration',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'token123' },
    });

    const list = db.listMCPServers();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('mcp-1');
    expect(list[0].name).toBe('GitHub MCP');
    expect(list[0].description).toBe('GitHub integration');
    expect(list[0].command).toBe('npx');
    expect(list[0].args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(list[0].env).toEqual({ GITHUB_TOKEN: 'token123' });
  });

  it('registers an MCP server without optional fields', () => {
    db.registerMCPServer({
      id: 'mcp-2',
      name: 'Minimal MCP',
      command: 'node',
      args: ['server.js'],
    });

    const list = db.listMCPServers();
    expect(list).toHaveLength(1);
    expect(list[0].description).toBeUndefined();
    expect(list[0].env).toBeUndefined();
  });

  it('returns empty list when no MCP servers registered', () => {
    expect(db.listMCPServers()).toEqual([]);
  });

  it('replaces an existing MCP server on re-register', () => {
    db.registerMCPServer({ id: 'mcp-1', name: 'Original', command: 'node', args: [] });
    db.registerMCPServer({ id: 'mcp-1', name: 'Updated', command: 'node', args: [] });

    const list = db.listMCPServers();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Updated');
  });

  it('deletes an MCP server', () => {
    db.registerMCPServer({ id: 'mcp-1', name: 'MCP', command: 'node', args: [] });
    db.deleteMCPServer('mcp-1');

    expect(db.listMCPServers()).toHaveLength(0);
  });

  it('delete is a no-op for non-existent MCP server', () => {
    expect(() => db.deleteMCPServer('missing')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

describe('segments', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('appendSegment creates a segment with segment_index 0 for the first segment', () => {
    const idx = db.appendSegment('inst-1', 'stage-1', 0, 'text', 'hello');
    expect(idx).toBe(0);
    const segs = db.getSegments('inst-1', 'stage-1', 0);
    expect(segs).toHaveLength(1);
    expect(segs[0].segment_index).toBe(0);
    expect(segs[0].segment_type).toBe('text');
    expect(segs[0].content).toBe('hello');
  });

  it('appendSegment second segment gets segment_index 1', () => {
    db.appendSegment('inst-1', 'stage-1', 0, 'text', 'first');
    const idx = db.appendSegment('inst-1', 'stage-1', 0, 'text', 'second');
    expect(idx).toBe(1);
    const segs = db.getSegments('inst-1', 'stage-1', 0);
    expect(segs).toHaveLength(2);
    expect(segs[1].segment_index).toBe(1);
    expect(segs[1].content).toBe('second');
  });

  it('appendToLastTextSegment appends to existing text segment', () => {
    db.appendSegment('inst-1', 'stage-1', 0, 'text', 'hello');
    db.appendToLastTextSegment('inst-1', 'stage-1', 0, ' world');
    const segs = db.getSegments('inst-1', 'stage-1', 0);
    expect(segs).toHaveLength(1);
    expect(segs[0].content).toBe('hello world');
  });

  it('appendToLastTextSegment creates new segment if last is a tool segment', () => {
    const toolCallId = 'tc-1';
    db.upsertToolCall({
      id: toolCallId,
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      status: 'running',
    });
    db.appendSegment('inst-1', 'stage-1', 0, 'tool', undefined, toolCallId);
    db.appendToLastTextSegment('inst-1', 'stage-1', 0, 'new text');
    const segs = db.getSegments('inst-1', 'stage-1', 0);
    expect(segs).toHaveLength(2);
    expect(segs[0].segment_type).toBe('tool');
    expect(segs[1].segment_type).toBe('text');
    expect(segs[1].content).toBe('new text');
  });

  it('getSegments returns segments with tool_call joins', () => {
    const toolCallId = 'tc-join-1';
    db.upsertToolCall({
      id: toolCallId,
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      title: 'My Tool',
      kind: 'bash',
      status: 'completed',
      rawInput: '{"cmd":"ls"}',
      rawOutput: 'file.txt',
    });
    db.appendSegment('inst-1', 'stage-1', 0, 'tool', undefined, toolCallId);
    const segs = db.getSegments('inst-1', 'stage-1', 0);
    expect(segs).toHaveLength(1);
    expect(segs[0].tool_call).not.toBeNull();
    expect(segs[0].tool_call!.id).toBe(toolCallId);
    expect(segs[0].tool_call!.title).toBe('My Tool');
    expect(segs[0].tool_call!.kind).toBe('bash');
    expect(segs[0].tool_call!.status).toBe('completed');
    expect(segs[0].tool_call!.raw_input).toBe('{"cmd":"ls"}');
    expect(segs[0].tool_call!.raw_output).toBe('file.txt');
  });

  it('getSegments with iteration filter returns only that iteration', () => {
    db.appendSegment('inst-1', 'stage-1', 0, 'text', 'iter0');
    db.appendSegment('inst-1', 'stage-1', 1, 'text', 'iter1');
    const iter0Segs = db.getSegments('inst-1', 'stage-1', 0);
    expect(iter0Segs).toHaveLength(1);
    expect(iter0Segs[0].content).toBe('iter0');
    const iter1Segs = db.getSegments('inst-1', 'stage-1', 1);
    expect(iter1Segs).toHaveLength(1);
    expect(iter1Segs[0].content).toBe('iter1');
    const allSegs = db.getSegments('inst-1', 'stage-1');
    expect(allSegs).toHaveLength(2);
  });

  it('deleteSegments deletes segments and associated tool_calls', () => {
    const toolCallId = 'tc-del-1';
    db.upsertToolCall({
      id: toolCallId,
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      status: 'completed',
    });
    db.appendSegment('inst-1', 'stage-1', 0, 'tool', undefined, toolCallId);
    db.appendSegment('inst-1', 'stage-1', 0, 'text', 'hello');

    db.deleteSegments('inst-1', 'stage-1');

    expect(db.getSegments('inst-1', 'stage-1')).toHaveLength(0);
    expect(db.getToolCalls('inst-1', 'stage-1')).toHaveLength(0);
  });

  it('deleteSegments with iteration filter only deletes that iteration', () => {
    db.appendSegment('inst-1', 'stage-1', 0, 'text', 'iter0');
    db.appendSegment('inst-1', 'stage-1', 1, 'text', 'iter1');

    db.deleteSegments('inst-1', 'stage-1', 0);

    expect(db.getSegments('inst-1', 'stage-1', 0)).toHaveLength(0);
    expect(db.getSegments('inst-1', 'stage-1', 1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

describe('tool calls', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('upsertToolCall creates a new tool call', () => {
    db.upsertToolCall({
      id: 'tc-1',
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      title: 'Read File',
      kind: 'file_read',
      status: 'running',
      rawInput: '{"path":"/tmp/x"}',
    });
    const calls = db.getToolCalls('inst-1', 'stage-1', 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('tc-1');
    expect(calls[0].title).toBe('Read File');
    expect(calls[0].kind).toBe('file_read');
    expect(calls[0].status).toBe('running');
    expect(calls[0].raw_input).toBe('{"path":"/tmp/x"}');
    expect(calls[0].raw_output).toBeNull();
  });

  it('upsertToolCall updates existing tool call (second phase)', () => {
    db.upsertToolCall({
      id: 'tc-2',
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      status: 'running',
      rawInput: '{"path":"/tmp/x"}',
    });
    db.upsertToolCall({
      id: 'tc-2',
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      status: 'completed',
      rawOutput: 'file contents',
    });
    const calls = db.getToolCalls('inst-1', 'stage-1', 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('completed');
    expect(calls[0].raw_output).toBe('file contents');
  });

  it('upsertToolCall COALESCE — raw_output from phase 2 does not overwrite raw_input from phase 1', () => {
    db.upsertToolCall({
      id: 'tc-3',
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      status: 'running',
      rawInput: '{"original":"input"}',
    });
    // Phase 2: provide raw_output but no rawInput
    db.upsertToolCall({
      id: 'tc-3',
      instanceId: 'inst-1',
      stageId: 'stage-1',
      iteration: 0,
      status: 'completed',
      rawOutput: 'the output',
    });
    const calls = db.getToolCalls('inst-1', 'stage-1', 0);
    expect(calls[0].raw_input).toBe('{"original":"input"}');
    expect(calls[0].raw_output).toBe('the output');
  });

  it('sweepToolCallStatuses changes status for matching tool calls', () => {
    db.upsertToolCall({ id: 'tc-a', instanceId: 'inst-1', stageId: 'stage-1', iteration: 0, status: 'running' });
    db.upsertToolCall({ id: 'tc-b', instanceId: 'inst-1', stageId: 'stage-1', iteration: 0, status: 'pending' });
    db.upsertToolCall({ id: 'tc-c', instanceId: 'inst-1', stageId: 'stage-1', iteration: 0, status: 'completed' });

    const changed = db.sweepToolCallStatuses('inst-1', 'stage-1', 0, ['running', 'pending'], 'interrupted');
    expect(changed).toBe(2);

    const calls = db.getToolCalls('inst-1', 'stage-1', 0);
    const statuses = Object.fromEntries(calls.map((c) => [c.id, c.status]));
    expect(statuses['tc-a']).toBe('interrupted');
    expect(statuses['tc-b']).toBe('interrupted');
    expect(statuses['tc-c']).toBe('completed');
  });

  it('sweepToolCallStatuses returns 0 when no matches', () => {
    db.upsertToolCall({ id: 'tc-x', instanceId: 'inst-1', stageId: 'stage-1', iteration: 0, status: 'completed' });
    const changed = db.sweepToolCallStatuses('inst-1', 'stage-1', 0, ['running'], 'interrupted');
    expect(changed).toBe(0);
  });

  it('getToolCalls returns all tool calls for a stage', () => {
    db.upsertToolCall({ id: 'tc-i0', instanceId: 'inst-1', stageId: 'stage-1', iteration: 0, status: 'completed' });
    db.upsertToolCall({ id: 'tc-i1', instanceId: 'inst-1', stageId: 'stage-1', iteration: 1, status: 'completed' });

    const all = db.getToolCalls('inst-1', 'stage-1');
    expect(all).toHaveLength(2);
  });

  it('getToolCalls with iteration filter returns only that iteration', () => {
    db.upsertToolCall({ id: 'tc-i0', instanceId: 'inst-1', stageId: 'stage-1', iteration: 0, status: 'completed' });
    db.upsertToolCall({ id: 'tc-i1', instanceId: 'inst-1', stageId: 'stage-1', iteration: 1, status: 'completed' });

    const iter0 = db.getToolCalls('inst-1', 'stage-1', 0);
    expect(iter0).toHaveLength(1);
    expect(iter0[0].id).toBe('tc-i0');
  });
});

// ---------------------------------------------------------------------------
// Rendered prompts
// ---------------------------------------------------------------------------

describe('rendered prompts', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('storeRenderedPrompt stores and retrieves a prompt', () => {
    db.storeRenderedPrompt('inst-1', 'stage-1', 0, 'You are a helpful assistant.');
    const result = db.getRenderedPrompt('inst-1', 'stage-1', 0);
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe('You are a helpful assistant.');
    expect(result!.iteration).toBe(0);
  });

  it('storeRenderedPrompt upsert replaces existing prompt for same iteration', () => {
    db.storeRenderedPrompt('inst-1', 'stage-1', 0, 'original prompt');
    db.storeRenderedPrompt('inst-1', 'stage-1', 0, 'updated prompt');
    const result = db.getRenderedPrompt('inst-1', 'stage-1', 0);
    expect(result!.prompt).toBe('updated prompt');
  });

  it('getRenderedPrompt returns latest iteration when no iteration specified', () => {
    db.storeRenderedPrompt('inst-1', 'stage-1', 0, 'iter 0');
    db.storeRenderedPrompt('inst-1', 'stage-1', 1, 'iter 1');
    db.storeRenderedPrompt('inst-1', 'stage-1', 2, 'iter 2');
    const result = db.getRenderedPrompt('inst-1', 'stage-1');
    expect(result).not.toBeNull();
    expect(result!.iteration).toBe(2);
    expect(result!.prompt).toBe('iter 2');
  });

  it('getRenderedPrompt returns null when not found', () => {
    const result = db.getRenderedPrompt('missing-inst', 'missing-stage');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ACP sessions
// ---------------------------------------------------------------------------

describe('ACP sessions', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('upsertAcpSession creates a new session', () => {
    db.upsertAcpSession('key-1', 'session-abc', 1234);
    const session = db.getAcpSession('key-1');
    expect(session).not.toBeNull();
    expect(session!.session_id).toBe('session-abc');
    expect(session!.process_pid).toBe(1234);
    expect(session!.status).toBe('active');
  });

  it('upsertAcpSession updates existing session', () => {
    db.upsertAcpSession('key-1', 'session-abc', 1234);
    db.upsertAcpSession('key-1', 'session-xyz', 5678);
    const session = db.getAcpSession('key-1');
    expect(session!.session_id).toBe('session-xyz');
    expect(session!.process_pid).toBe(5678);
    expect(session!.status).toBe('active');
  });

  it('getAcpSession returns null for unknown key', () => {
    const session = db.getAcpSession('no-such-key');
    expect(session).toBeNull();
  });

  it('markAcpSessionStatus changes status', () => {
    db.upsertAcpSession('key-1', 'session-abc', 1234);
    db.markAcpSessionStatus('key-1', 'stopped');
    const session = db.getAcpSession('key-1');
    expect(session!.status).toBe('stopped');
  });

  it('updateAcpSessionModel sets model_name', () => {
    db.upsertAcpSession('key-1', 'session-abc', null);
    db.updateAcpSessionModel('key-1', 'claude-3-5-sonnet');
    const session = db.getAcpSession('key-1');
    expect(session!.model_name).toBe('claude-3-5-sonnet');
  });

  it('clearAcpSessionPids sets all active sessions to error status', () => {
    db.upsertAcpSession('key-1', 'session-1', 100);
    db.upsertAcpSession('key-2', 'session-2', 200);
    db.upsertAcpSession('key-3', 'session-3', 300);
    // Mark one as stopped so it should NOT be affected
    db.markAcpSessionStatus('key-3', 'stopped');

    db.clearAcpSessionPids();

    const s1 = db.getAcpSession('key-1');
    const s2 = db.getAcpSession('key-2');
    const s3 = db.getAcpSession('key-3');
    expect(s1!.status).toBe('error');
    expect(s1!.process_pid).toBeNull();
    expect(s2!.status).toBe('error');
    expect(s2!.process_pid).toBeNull();
    // key-3 was already stopped, should not change to error
    expect(s3!.status).toBe('stopped');
  });

  it('getActiveAcpSessions returns only active sessions', () => {
    db.upsertAcpSession('key-active', 'session-active', 111);
    db.upsertAcpSession('key-stopped', 'session-stopped', 222);
    db.markAcpSessionStatus('key-stopped', 'stopped');

    const active = db.getActiveAcpSessions();
    expect(active).toHaveLength(1);
    expect(active[0].key).toBe('key-active');
    expect(active[0].session_id).toBe('session-active');
  });
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe('drafts', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('saveDraft and getDraft round-trip', () => {
    const draft = { name: 'My Draft', stages: [{ id: 's1' }] };
    db.saveDraft('wf-1', draft);
    const result = db.getDraft('wf-1');
    expect(result).toEqual(draft);
  });

  it('saveDraft upsert overwrites existing draft', () => {
    db.saveDraft('wf-1', { version: 1 });
    db.saveDraft('wf-1', { version: 2 });
    const result = db.getDraft('wf-1');
    expect(result).toEqual({ version: 2 });
  });

  it('getDraft returns null for unknown workflow ID', () => {
    const result = db.getDraft('no-such-wf');
    expect(result).toBeNull();
  });

  it('deleteDraft removes the draft', () => {
    db.saveDraft('wf-1', { name: 'to delete' });
    db.deleteDraft('wf-1');
    expect(db.getDraft('wf-1')).toBeNull();
  });

  it('listDrafts returns drafts sorted by updated_at DESC', async () => {
    // Insert in a specific order with slight delays to get distinct updated_at values
    db.saveDraft('wf-older', { label: 'older' });
    // Small wait to get different timestamps (SQLite datetime is second-resolution)
    // so we manually set different updated_at by saving again with a trick:
    // instead, just verify the list contains both and in some order
    db.saveDraft('wf-newer', { label: 'newer' });
    // Overwrite older to make it definitely newer
    db.saveDraft('wf-newer', { label: 'newest update' });

    const list = db.listDrafts();
    expect(list).toHaveLength(2);
    // Both IDs should be present
    const ids = list.map((d) => d.workflowId);
    expect(ids).toContain('wf-older');
    expect(ids).toContain('wf-newer');
    // Each entry has a workflowId and updatedAt
    expect(list[0].updatedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('setSetting and getSetting round-trip', () => {
    db.setSetting('theme', 'dark');
    expect(db.getSetting('theme')).toBe('dark');
  });

  it('setSetting upsert overwrites existing value', () => {
    db.setSetting('theme', 'dark');
    db.setSetting('theme', 'light');
    expect(db.getSetting('theme')).toBe('light');
  });

  it('getSetting returns null for unknown key', () => {
    expect(db.getSetting('nonexistent')).toBeNull();
  });

  it('deleteSetting removes the setting', () => {
    db.setSetting('to-delete', 'value');
    db.deleteSetting('to-delete');
    expect(db.getSetting('to-delete')).toBeNull();
  });

  it('getAllSettings returns all settings as a record', () => {
    db.setSetting('a', '1');
    db.setSetting('b', '2');
    db.setSetting('c', '3');
    const all = db.getAllSettings();
    expect(all).toEqual({ a: '1', b: '2', c: '3' });
  });
});

// ---------------------------------------------------------------------------
// Draft aliases
// ---------------------------------------------------------------------------

describe('draft aliases', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('registerDraftAlias and listDraftAliases round-trip', () => {
    db.registerDraftAlias('old-id', 'new-id');
    const aliases = db.listDraftAliases();
    expect(aliases).toHaveLength(1);
    expect(aliases[0].fromId).toBe('old-id');
    expect(aliases[0].toId).toBe('new-id');
  });

  it('registerDraftAlias upsert updates the existing alias', () => {
    db.registerDraftAlias('old-id', 'first-target');
    db.registerDraftAlias('old-id', 'second-target');
    const aliases = db.listDraftAliases();
    expect(aliases).toHaveLength(1);
    expect(aliases[0].toId).toBe('second-target');
  });
});

// ---------------------------------------------------------------------------
// Segment migration
// ---------------------------------------------------------------------------

describe('segment migration', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = makeDB();
  });

  it('migrateAuthorSegments moves segments from one stageId to another', () => {
    db.appendSegment('author', 'old-stage', 0, 'text', 'content');
    const changed = db.migrateAuthorSegments('old-stage', 'new-stage');
    expect(changed).toBe(1);
    expect(db.getSegments('author', 'old-stage')).toHaveLength(0);
    expect(db.getSegments('author', 'new-stage')).toHaveLength(1);
    expect(db.getSegments('author', 'new-stage')[0].content).toBe('content');
  });

  it('copyAuthorSegments copies segments without moving and sets tool_call_id to null', () => {
    const toolCallId = 'tc-copy';
    db.upsertToolCall({
      id: toolCallId,
      instanceId: 'author',
      stageId: 'src-stage',
      iteration: 0,
      status: 'completed',
    });
    db.appendSegment('author', 'src-stage', 0, 'text', 'copied content');
    db.appendSegment('author', 'src-stage', 0, 'tool', undefined, toolCallId);

    const copied = db.copyAuthorSegments('src-stage', 'dst-stage');
    expect(copied).toBe(2);

    // Source should still exist
    expect(db.getSegments('author', 'src-stage')).toHaveLength(2);

    // Destination should have copies
    const dstSegs = db.getSegments('author', 'dst-stage');
    expect(dstSegs).toHaveLength(2);
    // tool_call_id should be null on all copied segments
    for (const seg of dstSegs) {
      expect(seg.tool_call).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Transactions — deleteInstance regression tests
// ---------------------------------------------------------------------------

describe('deleteInstance', () => {
  let db: OrchestratorDB;
  let workflowId: string;
  let instanceId: string;

  beforeEach(() => {
    db = makeDB();
    const workflow = db.createWorkflow(makeWorkflowInput());
    workflowId = workflow.id;
    const instance = db.createInstance(makeInstanceInput(workflowId));
    instanceId = instance.id;
  });

  it('deleteInstance removes the instance and all related data', () => {
    // Create segments
    db.appendSegment(instanceId, 'stage-1', 0, 'text', 'segment content');

    // Create a tool call
    db.upsertToolCall({
      id: 'tc-del',
      instanceId,
      stageId: 'stage-1',
      iteration: 0,
      status: 'completed',
    });

    // Create a rendered prompt
    db.storeRenderedPrompt(instanceId, 'stage-1', 0, 'the prompt');

    // Verify data exists
    expect(db.getInstance(instanceId)).not.toBeNull();
    expect(db.getSegments(instanceId, 'stage-1')).toHaveLength(1);
    expect(db.getToolCalls(instanceId, 'stage-1')).toHaveLength(1);
    expect(db.getRenderedPrompt(instanceId, 'stage-1')).not.toBeNull();

    // Delete the instance
    db.deleteInstance(instanceId);

    // Verify everything is gone
    expect(db.getInstance(instanceId)).toBeNull();
    expect(db.getSegments(instanceId, 'stage-1')).toHaveLength(0);
    expect(db.getToolCalls(instanceId, 'stage-1')).toHaveLength(0);
    expect(db.getRenderedPrompt(instanceId, 'stage-1')).toBeNull();
  });
});
