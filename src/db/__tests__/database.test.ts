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
    trigger_event: makeEvent(),
    context: { trigger: { ref: 'main' }, stages: {} },
    current_stage_ids: [],
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
