# Plugin Authoring Guide

A **plugin** is a directory containing an `autome-plugin.json` manifest, node type files, and template JSON files. Plugins are discovered at server boot and remain active for the lifetime of the process.

- [Plugin Structure](#plugin-structure)
- [Manifest Reference](#manifest-reference)
- [Writing a Node Type](#writing-a-node-type)
- [Writing a Template](#writing-a-template)
- [Discovery](#discovery)
- [Example: A Complete Plugin](#example-a-complete-plugin)
- [Type Reference](#type-reference)

---

## Plugin Structure

```
plugins/
└── my-plugin/
    ├── autome-plugin.json        ← manifest (required)
    ├── nodes/
    │   ├── create-ticket.ts      ← default-exports a NodeTypeSpec
    │   └── search.ts
    └── templates/
        ├── bug-report.json       ← { id, name, nodeType, config, ... }
        └── feature-request.json
```

Each plugin is a subdirectory of `./plugins/` (or `~/.autome/plugins/` for user-global). The directory must contain an `autome-plugin.json` file.

---

## Manifest Reference

```json
{
  "id": "jira",
  "name": "Jira Integration",
  "version": "1.0.0",
  "description": "Custom Jira node types and templates",
  "nodeTypes": ["./nodes/create-ticket.ts", "./nodes/search.ts"],
  "templates": ["./templates/*.json"]
}
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique plugin identifier (used as the template `source` prefix) |
| `name` | yes | Human-readable name shown in `doctor` output |
| `version` | no | Semver string |
| `description` | no | Short description |
| `nodeTypes` | no | Array of paths to files that default-export a `NodeTypeSpec`. Relative to the plugin directory. |
| `templates` | no | Array of paths or globs to JSON template files. Relative to the plugin directory. Supports `*.json` style globs. |

All paths in `nodeTypes` and `templates` are resolved relative to the directory containing `autome-plugin.json`.

---

## Writing a Node Type

A node type file must **default-export** a `NodeTypeSpec`. No wrapper, no `definePlugin()` — just the spec.

```typescript
// plugins/jira/nodes/create-ticket.ts
import type { NodeTypeSpec, StepExecutor } from 'autome/plugin';

const executor: StepExecutor = {
  type: 'step',
  async execute({ config, input }) {
    const response = await fetch(`${config.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input?.sourceOutput),
    });
    const ticket = await response.json();
    return { output: { ticketId: ticket.key, url: ticket.self } };
  },
};

const spec: NodeTypeSpec = {
  id: 'jira-create-ticket',
  name: 'Jira: Create Ticket',
  category: 'step',
  description: 'Creates a ticket in Jira',
  icon: 'ticket',
  color: { bg: '#eff6ff', border: '#3b82f6', text: '#2563eb' },
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', title: 'Jira Base URL' },
      apiToken: { type: 'string', title: 'API Token', format: 'secret' },
      projectKey: { type: 'string', title: 'Project Key' },
    },
    required: ['baseUrl', 'apiToken', 'projectKey'],
  },
  defaultConfig: { baseUrl: '', apiToken: '', projectKey: '' },
  executor,
};

export default spec;
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
  const approval = await ctx.waitFor<{ approved: boolean }>(`gate-${stageId}`);
  if (!approval.approved) throw new TerminalError('Rejected');
  return { output: approval };
}
```

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
    return () => server.close(); // cleanup function
  },
};
```

Set `category: 'trigger'` on the `NodeTypeSpec` and use `triggerMode: 'prompt' | 'immediate'` to control the UI "Run" button behavior.

### Config Schemas

The `configSchema` is a JSON Schema object. Autome auto-generates forms from it. Supported extensions:

- `"format": "code"` — renders a code editor
- `"format": "json"` — renders a JSON editor
- `"format": "secret"` — renders a password input
- `"format": "template"` — renders a template editor (for prompt templates)

---

## Writing a Template

A template is a **named, preconfigured snapshot** of an existing node type. Templates are JSON files — no TypeScript needed.

```json
{
  "id": "acme-jira-create-bug",
  "name": "Jira: Create Bug",
  "description": "Preconfigured Jira node for filing bugs",
  "nodeType": "http-request",
  "icon": "bug",
  "category": "Integrations",
  "config": {
    "url": "https://acme.atlassian.net/rest/api/3/issue",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer {{ACME_JIRA_TOKEN}}",
      "Content-Type": "application/json"
    },
    "body": {
      "fields": {
        "project": { "key": "BUG" },
        "issuetype": { "name": "Bug" }
      }
    }
  },
  "exposed": ["body.fields.summary", "body.fields.description"],
  "locked": ["method", "url"]
}
```

**Key fields**:
- `id` — stable, unique across your plugin
- `nodeType` — must match a registered node type ID (built-in or from another plugin)
- `config` — copied into a new stage when the user drags the template onto a canvas
- `exposed` — hint to the UI about which fields the user should customize
- `locked` — hint to the UI about which fields should not change

A template file can export a single object or an array of objects.

### How Plugin Templates Sync

On every boot, autome syncs plugin templates into the DB:

- New plugin template → `INSERT` into `node_templates` with `source = 'plugin:<plugin-id>'`
- Existing template from the same plugin with **unchanged content** → no-op
- Existing template from the same plugin with **changed content** → `UPDATE` in place
- Existing template from a **different source** → skip (user's local customizations are protected)

---

## Discovery

On boot, autome scans for plugins in this order:

1. **`./plugins/*/autome-plugin.json`** in `process.cwd()` — project-local
2. **`~/.autome/plugins/*/autome-plugin.json`** — user-global
3. **Loose `.ts`/`.js` files** in `./plugins/` (not inside subdirectories) — legacy fallback for quick scripts that default-export an object with a `name` field
4. **`AUTOME_PLUGINS_DIR` env var** — overrides the project-local plugins directory path (instead of `./plugins/`)

Each plugin directory is only loaded once. Plugins from both project-local and user-global directories are merged (project-local first).

---

## Example: A Complete Plugin

Create a plugin that adds a custom "Slack Notify" node type and a starter template:

### Directory layout

```
plugins/
└── slack/
    ├── autome-plugin.json
    ├── nodes/
    │   └── notify.ts
    └── templates/
        └── alert.json
```

### `autome-plugin.json`

```json
{
  "id": "slack",
  "name": "Slack Integration",
  "version": "1.0.0",
  "description": "Slack node types and templates",
  "nodeTypes": ["./nodes/notify.ts"],
  "templates": ["./templates/*.json"]
}
```

### `nodes/notify.ts`

```typescript
import type { NodeTypeSpec, StepExecutor } from 'autome/plugin';

const executor: StepExecutor = {
  type: 'step',
  async execute({ config, input }) {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: config.channel,
        text: String(input?.sourceOutput ?? config.defaultMessage),
      }),
    });
    return { output: { sent: true } };
  },
};

const spec: NodeTypeSpec = {
  id: 'slack-notify',
  name: 'Slack: Notify',
  category: 'step',
  description: 'Posts a message to a Slack channel',
  icon: 'message-square',
  color: { bg: '#f0fdf4', border: '#22c55e', text: '#16a34a' },
  configSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', title: 'Bot Token', format: 'secret' },
      channel: { type: 'string', title: 'Channel (e.g. #alerts)' },
      defaultMessage: { type: 'string', title: 'Default Message' },
    },
    required: ['token', 'channel'],
  },
  defaultConfig: { token: '', channel: '', defaultMessage: '' },
  executor,
};

export default spec;
```

### `templates/alert.json`

```json
{
  "id": "slack-alert-template",
  "name": "Slack: Alert",
  "description": "Send an alert to #alerts",
  "nodeType": "slack-notify",
  "icon": "bell",
  "category": "Notifications",
  "config": {
    "channel": "#alerts",
    "defaultMessage": "Workflow completed"
  },
  "exposed": ["config.defaultMessage"],
  "locked": ["config.channel"]
}
```

### Verify

```bash
npx tsx src/cli/index.ts doctor
# Should show:
#   ✓ Slack Integration v1.0.0
#         ✓ Node types (1): slack-notify
#         ✓ Templates (1): slack-alert-template
```

---

## Type Reference

All types are exported from `autome/plugin`:

```typescript
import type {
  // Plugin types
  PluginManifest,
  LoadedPlugin,
  NodeTemplate,

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
} from 'autome/plugin';
```

### `PluginManifest` fields

```typescript
interface PluginManifest {
  id: string;           // required, unique plugin identifier
  name: string;         // required, human-readable name
  version?: string;     // semver
  description?: string; // short description
  nodeTypes?: string[]; // paths to NodeTypeSpec files (relative to plugin dir)
  templates?: string[]; // paths/globs to JSON template files (relative to plugin dir)
}
```

### Stability

The `autome/plugin` barrel export is the **stable public API surface**. Internal refactors will not break these types. Anything imported from deeper paths (e.g. `autome/src/db/database.js`) is not guaranteed stable.
