# Autome Documentation

Autome is an AI Agent Workflow Orchestrator. Users design workflows as graphs of typed stages (agents, HTTP requests, gates, code, etc.), trigger them, and watch them run to completion with full durable execution.

## Extending Autome

Autome ships as a framework that **downstream applications embed and extend**. You install it as a dependency, add your own plugins and templates, and ship your own branded workflow platform.

The two main extension points:

| Extension | What it does | When to use it |
|---|---|---|
| **Plugins** | Add custom node types, API routes, lifecycle hooks | "My company has a proprietary Jira integration and we need a Jira node type" |
| **Templates** | Pre-configured snapshots of existing node types | "We have a standard HTTP node config for calling our internal APIs — share it across workflows" |

Both plugins and templates can be:
- Created ad-hoc in your application
- Bundled for distribution (plugin ships a `templates` array)
- Imported/exported as JSON (templates only)

## Documentation

- **[Plugin Authoring Guide](./plugin-authoring.md)** — write custom node types, register routes, bundle templates
- **[Bootstrapping Guide](./bootstrapping.md)** — install autome as a dependency and run your own branded instance

## Quick Reference

**Plugin entry point** (autome loads this on boot):

```typescript
// autome.plugins.ts in your project root
import { definePlugin } from 'autome/plugin';

export default definePlugin({
  name: 'my-company',
  version: '1.0.0',
  nodeTypes: [/* custom node specs */],
  templates: [/* preconfigured node snapshots */],
  registerRoutes: (app, deps, state) => { /* custom Fastify routes */ },
  onReady: (ctx) => { /* init hook */ },
  onClose: () => { /* shutdown hook */ },
});
```

**Template shape** (either bundled in a plugin or saved from the UI):

```json
{
  "id": "jira-create-ticket",
  "name": "Jira Create Ticket",
  "nodeType": "http-request",
  "config": { "url": "...", "method": "POST", "headers": {} },
  "exposed": ["body.fields.summary"],
  "locked": ["method", "url"]
}
```

## Architecture

Autome's extensibility is built on a small number of stable interfaces:

- **`NodeTypeSpec`** — describes a node type: metadata (name, icon, color), config schema, executor
- **`StepExecutor`** / **`TriggerExecutor`** — the runtime behavior
- **`ExecutionContext`** — durable execution primitives (wait for signals, sleep, abort)
- **`AutomePlugin`** — the plugin shape, produced by `definePlugin()`
- **`NodeTemplate`** — a preconfigured node snapshot

All are exported from `autome/plugin`. See [Plugin Authoring](./plugin-authoring.md) for full reference.
