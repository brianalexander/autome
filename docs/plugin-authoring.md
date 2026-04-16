# Plugin Authoring Guide

A **plugin** is a single object that registers custom node types, templates, API routes, and lifecycle hooks. Plugins are loaded at server boot and remain active for the lifetime of the process.

- [The Plugin Interface](#the-plugin-interface)
- [Where Plugins Come From](#where-plugins-come-from)
- [Custom Node Types](#custom-node-types)
- [Node Templates](#node-templates)
- [Custom API Routes](#custom-api-routes)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Distributing Your Plugin](#distributing-your-plugin)
- [Type Reference](#type-reference)

---

## The Plugin Interface

```typescript
import { definePlugin } from 'autome/plugin';

export default definePlugin({
  // Required
  name: 'acme-integrations',

  // Optional
  version: '1.0.0',
  apiVersion: 1,

  // Extension points
  nodeTypes: [/* NodeTypeSpec[] */],
  templates: [/* NodeTemplate[] */],
  registerRoutes: (app, deps, state) => { /* ... */ },
  onReady: (ctx) => { /* ... */ },
  onClose: () => { /* ... */ },
});
```

`definePlugin()` is a pass-through helper that gives you type checking without runtime cost. All fields are optional except `name`.

**Plugin identity**: `name` must be unique across all loaded plugins. Use a scope-style identifier (e.g. `acme-integrations`, `company/workflows`).

---

## Where Plugins Come From

On boot, autome looks for plugins in this order:

1. **`AUTOME_PLUGINS` env var** (highest priority) — path to a single plugin file
2. **`autome.plugins.ts`** or **`autome.plugins.js`** in `process.cwd()`
3. **`~/.autome/plugins/`** — each `.ts` / `.js` / `.mjs` file in this directory is loaded

Each file must default-export either a single plugin or an array of plugins.

```typescript
// Single plugin
export default definePlugin({ name: 'my-plugin', /* ... */ });

// Or an array
export default [
  definePlugin({ name: 'plugin-a', /* ... */ }),
  definePlugin({ name: 'plugin-b', /* ... */ }),
];
```

---

## Custom Node Types

A node type is the blueprint for a stage. Users drag a node type onto the canvas, configure it, and the executor runs when the workflow reaches that stage.

### Anatomy of a Node Type

```typescript
import type { NodeTypeSpec, StepExecutor } from 'autome/plugin';

const jiraExecutor: StepExecutor = {
  type: 'step',
  async execute({ ctx, config, input }) {
    // Access the durable execution context:
    // - ctx.instanceId, ctx.sleep, ctx.waitFor, ctx.abortSignal
    //
    // config = the user's stage config (shaped by configSchema below)
    // input = output from the upstream stage via the incoming edge

    const response = await fetch(`${config.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input.sourceOutput),
    });

    const ticket = await response.json();
    return { output: { ticketId: ticket.key, url: ticket.self } };
  },
};

export const jiraCreateTicketSpec: NodeTypeSpec = {
  id: 'jira-create-ticket',
  name: 'Jira: Create Ticket',
  category: 'step',
  description: 'Creates a ticket in Jira',
  icon: 'ticket',                      // any Lucide icon name
  color: { bg: '#eff6ff', border: '#3b82f6', text: '#2563eb' },
  configSchema: {                       // JSON Schema — drives the auto-form
    type: 'object',
    properties: {
      baseUrl: { type: 'string', title: 'Jira Base URL' },
      apiToken: { type: 'string', title: 'API Token', format: 'secret' },
      projectKey: { type: 'string', title: 'Project Key' },
    },
    required: ['baseUrl', 'apiToken', 'projectKey'],
  },
  defaultConfig: { baseUrl: '', apiToken: '', projectKey: '' },
  executor: jiraExecutor,
};
```

### Executor Contract

Step executors receive a `StepExecutorContext` with:

| Field | Purpose |
|---|---|
| `ctx` | `ExecutionContext` for durable waits, sleep, abort signal |
| `stageId` | Current stage ID in the workflow |
| `config` | The user's stage config object (matches your `configSchema`) |
| `definition` | Full workflow definition (for looking up other stages) |
| `workflowContext` | Runtime state: trigger payload, stage statuses, outputs |
| `input` | Upstream stage output via the incoming edge |
| `orchestratorUrl` | Base URL of the running API (for internal calls) |
| `iteration` | Current iteration number (for cycled stages) |

Return `{ output, logs?, stderr? }`. `output` flows to downstream stages.

Throw `TerminalError` to fail a stage permanently (no retry). Regular `Error` is retriable if the stage has `retry` config.

### Durable Waits

The `ctx.waitFor(key)` primitive is how a stage blocks for an external signal — a user approval, an HTTP callback, an agent finishing. These waits survive server restarts via the `gates` table in the DB.

```typescript
async execute({ ctx, stageId }) {
  // Signal key convention: 'gate-<stageId>' for approvals,
  // 'stage-complete-<stageId>' for agent callbacks
  const approval = await ctx.waitFor<{ approved: boolean }>(`gate-${stageId}`);
  if (!approval.approved) throw new TerminalError('Rejected');
  return { output: approval };
}
```

An external HTTP call to `/api/instances/:id/gates/:stageId/approve` resolves the wait and the workflow resumes.

### Trigger Executors

Trigger nodes start workflows. They implement `TriggerExecutor`:

```typescript
import type { TriggerExecutor } from 'autome/plugin';

const webhookListener: TriggerExecutor = {
  type: 'trigger',
  async activate(workflowId, stageId, config, emit) {
    const server = startListener((payload) => {
      emit({ provider: 'my-webhook', payload });
    });
    return () => server.close();  // cleanup function
  },
};
```

Set `category: 'trigger'` on the `NodeTypeSpec` and use `triggerMode: 'prompt' | 'immediate'` to control the UI "Run" button behavior.

### Config Schemas

The `configSchema` is a JSON Schema object. Autome auto-generates forms from it. Supported extensions:

- `"format": "code"` — renders a code editor instead of a text input
- `"format": "json"` — renders a JSON editor
- `"format": "secret"` — renders a password input
- `"format": "template"` — renders a template editor (for prompt templates)

Keep schemas flat and descriptive. Use `title` for the form label and `description` for help text.

### Edge Schemas

A node can declare schemas for edge-level config:

- `inEdgeSchema` — fields on incoming edges (e.g., agents declare `prompt_template`)
- `outEdgeSchema` — fields on outgoing edges (e.g., gates declare `condition`)

These render in the edge config panel.

---

## Node Templates

A template is a **named, preconfigured snapshot** of an existing node type. Templates are not new node types — they're starting points users can drop onto canvases.

```typescript
import type { NodeTemplate } from 'autome/plugin';

const jiraCreateTicketTemplate: NodeTemplate = {
  id: 'acme-jira-create-ticket',
  name: 'Jira: Create Bug',
  description: 'Preconfigured Jira node for filing bugs',
  nodeType: 'http-request',              // existing node type to clone
  icon: 'bug',
  category: 'Integrations',
  config: {
    url: 'https://acme.atlassian.net/rest/api/3/issue',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer {{ACME_JIRA_TOKEN}}',
      'Content-Type': 'application/json',
    },
    body: {
      fields: {
        project: { key: 'BUG' },
        issuetype: { name: 'Bug' },
      },
    },
  },
  exposed: ['body.fields.summary', 'body.fields.description'],
  locked: ['method', 'url'],
};

export default definePlugin({
  name: 'acme-templates',
  templates: [jiraCreateTicketTemplate],
});
```

**Key fields**:
- `id` — stable, unique across your plugin
- `nodeType` — must match an existing registered node type (built-in or from another plugin)
- `config` — the saved configuration; copied into a new stage when the user drags the template
- `exposed` — hint to the UI about which fields the user should customize
- `locked` — hint to the UI about which fields should not change

**Current behavior**: templates are copy-paste. When a user drags a template onto a canvas, its `config` is copied into a new stage. There is no live link back to the template (by design — simpler mental model, no orphan-link bugs).

### How Plugin Templates Sync

On every boot, autome syncs plugin templates into the DB:

- New plugin template → `INSERT` into `node_templates` with `source = 'plugin:<your-plugin-name>'`
- Existing template from the same plugin with **unchanged content** → no-op
- Existing template from the same plugin with **changed content** → `UPDATE` in place
- Existing template from a **different source** → skip (user's local customizations are protected)

This means you can ship updates to your plugin templates and they'll propagate on the next boot.

### Local Templates

Users can also save templates directly from the UI (Bookmark icon on a configured node). Those have `source = 'local'` and are fully user-owned.

---

## Custom API Routes

Plugins can register additional Fastify routes:

```typescript
import type { AutomePlugin } from 'autome/plugin';

export default definePlugin({
  name: 'acme-admin',
  registerRoutes: (app, deps, state) => {
    // app: Fastify instance
    // deps: { db, eventBus, runner, ... }
    // state: { acpPool, authorPool, authorDrafts, ... }

    app.get('/api/acme/status', async () => {
      const count = deps.db.listInstances({ status: 'running' }).length;
      return { runningInstances: count };
    });

    app.post<{ Body: { workflowId: string } }>('/api/acme/cron/fire-now', async (req) => {
      // You have access to the runner, event bus, DB — drive any core behavior
      deps.eventBus.emit('manual-trigger', { workflowId: req.body.workflowId });
      return { triggered: true };
    });
  },
});
```

**Available via `deps`**:

| Field | Type | What it does |
|---|---|---|
| `db` | `OrchestratorDB` | SQLite access via typed methods |
| `eventBus` | `EventBus` | Publish/subscribe to workflow events |
| `runner` | `WorkflowRunner` | Start, cancel, or resume instances |
| `manualTrigger` | Provider | Fire manual triggers |
| `acpPool`, `authorPool`, `assistantPool` | `AgentPool` | Manage ACP agent sessions |

**Namespacing**: prefix your routes with something unique (e.g. `/api/acme/*`) to avoid conflicts with future core routes.

---

## Lifecycle Hooks

### `onReady(ctx)`

Called after the core has initialized (routes registered, node registry populated, etc.) but **before `app.listen()`**. Use for one-time setup that needs access to the registry or event bus.

```typescript
export default definePlugin({
  name: 'acme-setup',
  async onReady({ nodeRegistry, eventBus }) {
    console.log('Loaded node types:', nodeRegistry.list().map(n => n.id));
    eventBus.on('workflow-finished', (event) => {
      // Send a metric to Datadog, etc.
    });
  },
});
```

### `onClose()`

Called during graceful shutdown (SIGINT, SIGTERM, or explicit `app.close()`). Use to flush buffers, close external connections, etc.

```typescript
export default definePlugin({
  name: 'acme-metrics',
  onClose: async () => {
    await datadogClient.flush();
  },
});
```

---

## Distributing Your Plugin

### Option 1: Project-Local File

The simplest — just put an `autome.plugins.ts` file at the root of your project.

```
my-company/
├── package.json          # depends on autome
├── autome.plugins.ts     # your plugins
├── src/
│   └── nodes/
│       └── jira.ts       # individual node specs
└── data/
    └── orchestrator.db   # runtime state
```

Run autome directly: `npx autome` (see [Bootstrapping Guide](./bootstrapping.md)).

### Option 2: npm Package

Ship your plugin as a reusable npm package:

```json
{
  "name": "@acme/autome-plugin",
  "version": "1.2.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "peerDependencies": {
    "autome": "^0.1.0"
  }
}
```

```typescript
// src/index.ts — your plugin package
import { definePlugin } from 'autome/plugin';
// ... your node types and templates

export default definePlugin({ name: '@acme/plugin', /* ... */ });
```

Consumers install and register:

```typescript
// consumer's autome.plugins.ts
import acmePlugin from '@acme/autome-plugin';
import { definePlugin } from 'autome/plugin';

export default [
  acmePlugin,
  definePlugin({ name: 'my-local', /* ... */ }),
];
```

### Option 3: Global Plugin Directory

Drop plugin files in `~/.autome/plugins/`. Useful for machine-wide tooling not tied to a specific project.

```
~/.autome/plugins/
├── 01-acme.ts        # loaded first (alphabetical)
└── 02-company.ts
```

---

## Type Reference

All types are exported from `autome/plugin`:

```typescript
import {
  // Core plugin API
  definePlugin,
  AutomePlugin,
  NodeTemplate,
  PluginContext,

  // Node type system
  NodeTypeSpec,
  StepExecutor,
  TriggerExecutor,
  StepExecutorContext,
  StageInput,
  NodeColor,

  // Workflow types
  WorkflowDefinition,
  EdgeDefinition,
  NodeTypeInfo,

  // Route-level access
  RouteDeps,
  SharedState,
} from 'autome/plugin';
```

### `AutomePlugin` contract

```typescript
interface AutomePlugin {
  name: string;                  // required, unique
  version?: string;              // your plugin version (semver)
  apiVersion?: number;           // current: 1
  nodeTypes?: NodeTypeSpec[];
  templates?: NodeTemplate[];
  registerRoutes?: (app, deps, state) => void | Promise<void>;
  onReady?: (ctx) => void | Promise<void>;
  onClose?: () => void | Promise<void>;
}
```

### Stability

The `autome/plugin` barrel export is the **stable public API surface**. Internal refactors of autome will not break these types. Anything imported from deeper paths (e.g. `autome/src/db/database.js`) is not guaranteed stable.

If a breaking change to the plugin API is needed, the `apiVersion` field lets the core reject incompatible plugins gracefully.

---

## Common Patterns

### Secrets handling

Don't hardcode secrets in templates. Use placeholder syntax and have the user fill them via env vars or an external secrets source:

```typescript
config: {
  headers: {
    'Authorization': 'Bearer {{MY_API_TOKEN}}',
  },
}
```

Users can reference env vars in configs at runtime via templating (handled by the core).

### Iterative agents

For agents that should be re-invoked in cycles, set `cycle_behavior` in the stage config and model the loop as an edge that points back to the agent. The core handles iteration counting and session continuation.

### Error paths

Add an `on_error` outgoing edge from a stage to route failures to a cleanup stage. This is configured in the UI — your executor just throws errors normally.

---

Next: see [Bootstrapping Guide](./bootstrapping.md) for how to install autome as a dependency and wire it up in your own app.
