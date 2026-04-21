# Plugin Authoring Guide

A **plugin** is a directory containing an `autome-plugin.json` manifest, node type files, and template JSON files. Plugins are discovered at server boot and remain active for the lifetime of the process.

- [Plugin Structure](#plugin-structure)
- [Manifest Reference](#manifest-reference)
- [Writing a Node Type](#writing-a-node-type)
  - [Icons](#icons)
  - [Executor Contract](#executor-contract)
  - [Durable Waits](#durable-waits)
  - [Trigger Executors](#trigger-executors)
  - [Config Schemas](#config-schemas)
  - [Config UI — Widgets](#config-ui--widgets)
  - [Config UI — JSON Schema Extensions](#config-ui--json-schema-extensions)
  - [Config UI — Cards](#config-ui--cards)
- [Writing a Provider](#writing-a-provider)
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
  "templates": ["./templates/*.json"],
  "providers": ["./providers/my-provider.ts"]
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
| `providers` | no | Array of paths to files that default-export an `AcpProvider`. Relative to the plugin directory. |

All paths in `nodeTypes`, `templates`, and `providers` are resolved relative to the directory containing `autome-plugin.json`.

---

## Writing a Node Type

A node type file must **default-export** a `NodeTypeSpec`. Use the `defineNodeType` helper for TypeScript inference, or just write the spec directly.

```typescript
// plugins/jira/nodes/create-ticket.ts
import { defineNodeType } from 'autome/plugin';
import type { StepExecutor } from 'autome/plugin';

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

export default defineNodeType({
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
});
```

### Icons

The `icon` field accepts any Lucide icon name in kebab-case — the same names shown at **<https://lucide.dev/icons/>**. Common values:

| Name | Meaning |
|---|---|
| `'bot'` | AI / agent nodes |
| `'play'` | general trigger / run |
| `'clock'` | schedule / cron |
| `'globe'` | HTTP / webhook / external |
| `'shield-check'` | review gate / approval |
| `'code'` | code execution |
| `'plug'` | custom trigger / integration |
| `'message-square'` | chat / notification |

Use the catalog link above to find others. The registry is case-sensitive — `'AlertCircle'` will not resolve; use `'alert-circle'`.

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

A trigger is a long-running event source that starts workflow instances. The lifecycle engine spins it up when a workflow is activated and tears it down when deactivated. Trigger executors implement `TriggerExecutor`:

```typescript
export interface TriggerExecutor {
  type: 'trigger';
  activate?(ctx: TriggerActivateContext): Promise<() => void> | (() => void);
  sampleEvent?: (config: Record<string, unknown>) => Record<string, unknown>;
}
```

Set `category: 'trigger'` on the `NodeTypeSpec`. Use `triggerMode: 'prompt' | 'immediate'` to control how the UI "Run" button behaves — `'prompt'` opens a payload dialog; `'immediate'` launches the workflow directly with the trigger's sample event.

#### `activate` — the lifecycle function

`activate(ctx)` is called once when the workflow is activated. It should start whatever long-running work produces events (polling loop, interval, WebSocket, child process, etc.) and return a cleanup function. The cleanup is called when the workflow is deactivated.

The `TriggerActivateContext` contains:

| Field | Type | Purpose |
|---|---|---|
| `workflowId` | `string` | ID of the workflow being activated |
| `stageId` | `string` | ID of this trigger stage |
| `config` | `Record<string, unknown>` | The stage's user-configured values |
| `secrets` | `Record<string, string> \| undefined` | Decrypted secrets snapshot |
| `emit` | `(payload: Record<string, unknown>) => void` | Call to dispatch a trigger event into the workflow |
| `logger` | `TriggerLogger` | Structured logger (see below) |

#### Cleanup contract

The function returned by `activate` is invoked on deactivation. It must be fast and idempotent. Typical patterns:

- `setInterval` → `clearInterval(id)`
- Child process → `child.kill('SIGTERM')`
- WebSocket → `ws.close()`

If cleanup is async, wrap it: `return async () => { await ws.close(); }`.

#### `logger` — observable logging

The `logger` object (type `TriggerLogger`) writes structured, timestamped lines to a 200-line ring buffer that is surfaced in the `activation-status` config card and queryable via `GET /api/workflows/:id/triggers/:stageId/logs`.

```typescript
export interface TriggerLogger {
  info(msg: string): void;
  warn(msg: string): void;
  /** Also bumps errorCount and sets lastError in trigger status. */
  error(msg: string, err?: Error): void;
}
```

Log liberally: on start, on each emitted event, on errors, and on cleanup. This is the primary observability surface for live triggers.

#### `sampleEvent` — test run seed

```typescript
sampleEvent?: (config: Record<string, unknown>) => Record<string, unknown>
```

When present, `sampleEvent(config)` is called to generate the initial payload for test runs. The returned object flows into the workflow exactly as a real trigger event would. Recommended: return an event that matches the shape your `emit()` calls produce, so downstream nodes can be tested realistically.

If absent, the frontend falls back to a generic JSON dialog populated from the node's `output_schema` field.

#### `hasLifecycle` — derived flag

`hasLifecycle` is not a field you set — it is computed from `typeof executor.activate === 'function'` by the registry when it prepares the node type info sent to the frontend. When `true`, the Activate/Deactivate toggle appears on the workflow list for any workflow that uses this trigger type.

#### Worked example: polling trigger

```typescript
import { defineNodeType } from 'autome/plugin';
import type { TriggerExecutor, TriggerActivateContext } from 'autome/plugin';

const executor: TriggerExecutor = {
  type: 'trigger',

  sampleEvent: (config) => ({
    url: config.url,
    status: 200,
    body: { example: true },
    polled_at: new Date().toISOString(),
  }),

  activate(ctx: TriggerActivateContext) {
    const { workflowId, config, emit, logger } = ctx;
    const url = String(config.url);
    const intervalMs = Number(config.interval_seconds ?? 30) * 1000;
    let lastBody: string | null = null;

    logger.info(`Polling ${url} every ${config.interval_seconds ?? 30}s for workflow ${workflowId}`);

    const id = setInterval(async () => {
      try {
        const res = await fetch(url);
        const body = await res.text();
        if (body !== lastBody) {
          lastBody = body;
          logger.info(`Change detected at ${url}`);
          emit({ url, status: res.status, body: JSON.parse(body), polled_at: new Date().toISOString() });
        }
      } catch (err) {
        logger.error(`Fetch failed for ${url}`, err instanceof Error ? err : new Error(String(err)));
      }
    }, intervalMs);

    // Cleanup
    return () => {
      clearInterval(id);
      logger.info(`Polling stopped for workflow ${workflowId}`);
    };
  },
};

export default defineNodeType({
  id: 'http-poll-trigger',
  name: 'HTTP Poll Trigger',
  category: 'trigger',
  description: 'Emit an event whenever a polled URL returns new content',
  icon: 'globe',
  color: { bg: '#eff6ff', border: '#3b82f6', text: '#2563eb' },
  triggerMode: 'immediate',
  configSchema: {
    type: 'object',
    properties: {
      url:              { type: 'string', title: 'URL to poll' },
      interval_seconds: { type: 'number', title: 'Poll interval (s)', default: 30,
                          minimum: 5, maximum: 3600, 'x-widget': 'slider' },
    },
    required: ['url'],
  },
  defaultConfig: { url: '', interval_seconds: 30 },
  configCards: [
    { kind: 'activation-status', title: 'Trigger Status' },
    { kind: 'help-text', title: 'How it works',
      markdown: 'Polls the configured URL on the given interval. Emits an event only when the response body changes.' },
  ],
  executor,
});
```

### Config Schemas

The `configSchema` is a JSON Schema object. Autome auto-generates forms from it. Supported `format` values:

- `"format": "code"` — renders a code editor
- `"format": "json"` — renders a JSON editor
- `"format": "secret"` — renders a password input
- `"format": "template"` — renders a template editor (for prompt templates)
- `"format": "date"` — renders a date picker
- `"format": "date-time"` — renders a date+time picker
- `"format": "color"` — renders a color picker
- `"format": "textarea"` — renders a multi-line text area
- `"format": "dependencies"` — renders the npm-dependency manager (key = package name, value = version)

See [Config UI — Widgets](#config-ui--widgets) for the full inference rules that determine which input widget a field uses.

### Config UI — Widgets

Config forms are rendered by a closed widget registry. Authors describe fields declaratively in `configSchema`; the registry picks the right input component automatically. Every widget accepts a `value`, calls `onChange` on edit, and honours the `disabled` prop.

The registry contains 19 widgets (21 including the two live-data widgets reserved for built-in use):

| Widget key | Triggered by | Example schema snippet |
|---|---|---|
| `text` | Default fallback | `{ "type": "string" }` |
| `textarea` | `format: 'textarea'` | `{ "type": "string", "format": "textarea" }` |
| `code` | `format: 'code'`, `'json'`, or `'template'` | `{ "type": "string", "format": "code" }` |
| `secret` | `format: 'secret'` **or** field name matches `/(secret\|password\|token\|api[_-]?key)/i` | `{ "type": "string", "format": "secret" }` |
| `number` | `type: 'number'` or `type: 'integer'` | `{ "type": "number" }` |
| `slider` | `x-widget: 'slider'` (no auto-inference — must be explicit) | `{ "type": "number", "minimum": 0, "maximum": 100, "x-widget": "slider" }` |
| `checkbox` | `type: 'boolean'` | `{ "type": "boolean" }` |
| `select` | `enum` present on the schema | `{ "type": "string", "enum": ["a", "b", "c"] }` |
| `multiselect` | `type: 'array'` with `items.enum` | `{ "type": "array", "items": { "enum": ["x", "y"] } }` |
| `tags` | `type: 'array'` with scalar items (no `items.enum`) | `{ "type": "array", "items": { "type": "string" } }` |
| `arrayOfObjects` | `type: 'array'` with `items.type === 'object'` | `{ "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" } } } }` |
| `keyvalue` | `type: 'object'` with `additionalProperties` | `{ "type": "object", "additionalProperties": { "type": "string" } }` |
| `nested` | `type: 'object'` with `properties` | `{ "type": "object", "properties": { "host": { "type": "string" } } }` |
| `date` | `format: 'date'` | `{ "type": "string", "format": "date" }` |
| `date-time` | `format: 'date-time'` | `{ "type": "string", "format": "date-time" }` |
| `color` | `format: 'color'` | `{ "type": "string", "format": "color" }` |
| `dependencies` | `format: 'dependencies'` **or** field name exactly `'dependencies'` | `{ "type": "object", "format": "dependencies" }` |
| `agent-select` | `x-widget: 'agent-select'` (built-in use only) | — |
| `agent-overrides` | `x-widget: 'agent-overrides'` (built-in use only) | — |

**Inference priority** (highest wins):

1. **Explicit `x-widget`** — if the value is a registered widget key, use it.
2. **`format` keyword** — `date`, `date-time`, `color`, `textarea`, `code`/`json`/`template`, `dependencies`.
3. **Field name `=== 'dependencies'`** — resolves to the dependency manager widget.
4. **`enum` present** → `select`.
5. **`type === 'array'`**:
   - `items.enum` present → `multiselect` (checkbox list)
   - `items.type === 'object'` → `arrayOfObjects`
   - otherwise → `tags` (free-text chip input)
6. **`type === 'boolean'`** → `checkbox`.
7. **`type === 'number'` or `'integer'`** → `number`.
8. **`type === 'object'` with `additionalProperties`** → `keyvalue`.
9. **`type === 'object'` with `properties`** → `nested` (recursive sub-form).
10. **Field name matches `/(secret|password|token|api[_-]?key)/i`** → `secret`.
11. **Default** → `text`.

**Example A — inferred:** a plain string-array field gets the tags chip input automatically:

```json
{
  "tags": {
    "type": "array",
    "items": { "type": "string" },
    "title": "Labels"
  }
}
```

No `x-widget` needed. The inference sees `type: 'array'` with scalar items and picks `tags`.

**Example B — explicit override:** force a checkbox list even when the field stores an array of enum strings:

```json
{
  "notify_channels": {
    "type": "array",
    "items": { "enum": ["slack", "email", "pager"] },
    "title": "Notify via",
    "x-widget": "multiselect"
  }
}
```

Here the inference would also pick `multiselect` (because `items.enum` is present), so `x-widget` is redundant — but if you later changed `items` to a plain string type and forgot to add `x-widget`, inference would fall back to `tags`. Explicit is fine for self-documentation.

```json
{
  "temperature": {
    "type": "number",
    "title": "Temperature",
    "minimum": 0,
    "maximum": 2,
    "multipleOf": 0.1,
    "x-widget": "slider"
  }
}
```

`slider` has no auto-inference rule — it must always be declared explicitly via `x-widget`.

### Config UI — JSON Schema Extensions

Autome recognises several non-standard keywords on field schemas that control form rendering. All `x-` keywords are Autome-specific; `readOnly` is standard JSON Schema.

| Keyword | Purpose | Example |
|---|---|---|
| `x-widget` | Explicit widget selection, overrides all inference | `{ "x-widget": "slider" }` |
| `x-show-if` | Conditional field visibility | `{ "x-show-if": { "field": "mode", "equals": "advanced" } }` |
| `x-enum-labels` | Human-readable labels for enum values (in the same order as `enum`) | `{ "enum": ["async", "pause"], "x-enum-labels": ["Async", "Pause and wait"] }` |
| `x-placeholder` | Placeholder text for text / number / textarea / secret inputs | `{ "type": "number", "x-placeholder": "∞" }` |
| `readOnly` | Standard JSON Schema — disables the widget but keeps it visible in the form | `{ "format": "json", "readOnly": true }` |

**`x-show-if` details:** both `equals` and `notEquals` are supported as sibling keys in the condition object. The value is compared against the referenced field's current value, falling back to the field's `default` when no value is set. Fields with an unmatched condition are hidden entirely — they are not submitted to the form's output.

```json
{
  "mode":    { "type": "string", "enum": ["simple", "advanced"] },
  "retries": { "type": "number", "x-show-if": { "field": "mode", "equals": "advanced" } }
}
```

**`readOnly` priority:** `disabled = panelReadOnly || field.readOnly`. A field-level `readOnly: true` can only tighten (disable) relative to the panel default — it can never loosen a panel-level read-only constraint.

### Config UI — Cards

`configCards` is an optional array of `ConfigCard` objects on a `NodeTypeSpec`. Cards are declarative, data-only affordances rendered above the schema form in the config pane. No React code is needed from the plugin side — declare the card shape and the runtime renders it.

Cards are rendered in declaration order. Every `NodeTypeSpec` can declare them regardless of whether it is a trigger or a step.

#### Available card kinds

| Kind | Renders | When to use |
|---|---|---|
| `help-text` | Content is aggregated into the info popover in the config pane header | Descriptions, documentation links, usage notes |
| `copy-url` | A labelled URL field with a one-click copy button | Exposing a callback URL (webhook endpoint, redirect URI, etc.) |
| `curl-snippet` | A fenced markdown block containing a curl command | Quick-start instructions for HTTP-driven triggers |
| `preview-template` | A live nunjucks preview of a named config field | Prompt template fields where the user wants to see the rendered output |
| `activation-status` | Live trigger status: colored dot (active / errored / stopped), event count, last event time, expandable log viewer | Any trigger node that implements `activate`; should almost always be paired with one |
| `cycle-behavior` | An inline select for cycle detection behavior | Agent nodes in cycles — do not use in plugin triggers |

#### Template substitution

The `urlTemplate` (for `copy-url`) and `template` (for `curl-snippet`) fields support variable substitution at render time:

| Variable | Resolves to |
|---|---|
| `{apiOrigin}` | `window.location.origin` in the browser |
| `{workflowId}` | The current workflow's ID |
| `{stageId}` | This stage's ID |
| `{config.FIELD}` | `config[FIELD]` for the stage's current config; empty string if absent |

Example — the built-in `webhook-trigger` uses:

```typescript
configCards: [
  {
    kind: 'copy-url',
    title: 'Webhook URL',
    urlTemplate: '{apiOrigin}/api/webhooks/{workflowId}',
  },
]
```

The rendered card shows the full URL with a copy button. No code beyond the declaration is required.

#### Minimal example — plugin trigger with cards

```typescript
export default defineNodeType({
  id: 'my-poll-trigger',
  name: 'My Poll Trigger',
  category: 'trigger',
  // ...
  configCards: [
    {
      kind: 'help-text',
      title: 'How it works',
      markdown: 'Polls an external API on the configured interval and emits an event whenever the response changes.',
    },
    {
      kind: 'activation-status',
      title: 'Trigger Status',
    },
  ],
  executor,
});
```

The `help-text` content appears in the info popover (the ⓘ in the config pane header). The `activation-status` card renders the live state widget below the header — only populated when the workflow is active.

---

## Writing a Provider

An ACP provider file must **default-export** an object (or class instance) satisfying the `AcpProvider` interface. Use the `defineProvider` helper for TypeScript inference.

```typescript
// plugins/my-provider/providers/acme-cli.ts
import { defineProvider } from 'autome/plugin';

export default defineProvider({
  name: 'acme',
  displayName: 'Acme CLI',
  supportsSessionResume: false,
  tracksMcpReadiness: false,

  getCommand() { return 'acme'; },
  getSpawnArgs({ agent }) { return agent ? ['--agent', agent] : []; },
  getSpawnEnv() { return {}; },

  async discoverAgents() { return []; },
  async getAgentSpec() { return null; },
  getLocalAgentDir(workingDir) { return `${workingDir}/.acme/agents`; },
  getGlobalAgentDir() { return `${process.env.HOME}/.acme/agents`; },
  handleVendorNotification() { return null; },
});
```

Declare it in `autome-plugin.json`:

```json
{
  "id": "my-acme-plugin",
  "name": "Acme Provider Plugin",
  "providers": ["./providers/acme-cli.ts"]
}
```

Providers can also be registered programmatically without a filesystem plugin — see `docs/wrapping-autome.md`.

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
3. **`AUTOME_PLUGINS_DIR` env var** — overrides the project-local plugins directory path (instead of `./plugins/`)

Each plugin directory is only loaded once. Plugins from both project-local and user-global directories are merged (project-local first).

**Programmatic plugins** (passed via `createCli` or `startServer` options) are registered before filesystem discovery and take priority on ID collision.

> **Note:** Loose `.ts`/`.js` files dropped directly into `./plugins/` are no longer supported. Each plugin must be a subdirectory containing `autome-plugin.json`.

> **Note:** The `./nodes/` filesystem scanner has been removed. Custom node types must be delivered via a plugin manifest's `nodeTypes` field or programmatically via `startServer({ nodeTypes: [...] })`.

> **Note:** The `./providers/` filesystem scanner has been removed. Custom ACP providers must be declared in a plugin manifest's `providers` field or programmatically via `startServer({ providers: [...] })`.

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

All types and runtime helpers are exported from `autome/plugin`:

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
  TriggerActivateContext,
  TriggerLogger,
  StepExecutorContext,
  StageInput,
  NodeColor,
  ConfigCard,

  // Workflow types
  WorkflowDefinition,
  EdgeDefinition,
  NodeTypeInfo,

  // Provider type
  AcpProvider,
} from 'autome/plugin';

// Runtime authoring helpers (values, not just types)
import {
  definePlugin,
  defineNodeType,
  defineTemplate,
  defineProvider,
} from 'autome/plugin';
```

### `PluginManifest` fields

```typescript
interface PluginManifest {
  id: string;            // required, unique plugin identifier
  name: string;          // required, human-readable name
  version?: string;      // semver
  description?: string;  // short description
  nodeTypes?: string[];  // paths to NodeTypeSpec files (relative to plugin dir)
  templates?: string[];  // paths/globs to JSON template files (relative to plugin dir)
  providers?: string[];  // paths to AcpProvider files (relative to plugin dir)
}
```

### Authoring helpers

| Helper | Purpose |
|---|---|
| `defineNodeType(spec)` | Identity function — enables TypeScript inference for node types |
| `defineTemplate(tpl)` | Identity function — enables TypeScript inference for templates |
| `defineProvider(provider)` | Identity function — enables TypeScript inference for providers |
| `definePlugin(manifest, assets?)` | Constructs a `LoadedPlugin` for programmatic registration |

`definePlugin` is primarily used by wrappers that want to bundle plugins into a binary rather than discover them from the filesystem:

```typescript
import { definePlugin, defineNodeType } from 'autome/plugin';

const myNode = defineNodeType({ id: 'my-node', ... });

const myPlugin = definePlugin(
  { id: 'my-plugin', name: 'My Plugin', version: '1.0.0' },
  { nodeTypes: [myNode] },
);

// Then pass to createCli or startServer:
// createCli({ plugins: [myPlugin] }).run(process.argv);
```

### Stability

The `autome/plugin` barrel export is the **stable public API surface**. Internal refactors will not break these types. Anything imported from deeper paths (e.g. `autome/src/db/database.js`) is not guaranteed stable.
