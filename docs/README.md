# Autome Documentation

Autome is an AI Agent Workflow Orchestrator. Users design workflows as graphs of typed stages (agents, HTTP requests, gates, code, etc.), trigger them, and watch them run to completion with full durable execution.

## Extending Autome

Autome ships as a framework that **downstream applications embed and extend**. You install it as a dependency, add your own plugins in a `plugins/` directory, and ship your own branded workflow platform.

The two main extension points:

| Extension | What it does | When to use it |
|---|---|---|
| **Plugins** | Add custom node types | "My company has a proprietary Jira integration and we need a Jira node type" |
| **Templates** | Pre-configured snapshots of existing node types | "We have a standard HTTP node config for calling our internal APIs — share it across workflows" |

Both plugins and templates can be:
- Created ad-hoc in your application's `plugins/` directory
- Bundled and distributed (ship a plugin directory)
- Imported/exported as JSON (templates only)

## Documentation

- **[Plugin Authoring Guide](./plugin-authoring.md)** — write custom node types, bundle templates, plugin structure
- **[Bootstrapping Guide](./bootstrapping.md)** — install autome as a dependency and run your own branded instance

## Quick Reference

**Plugin directory** (autome discovers this on boot):

```
plugins/
└── my-plugin/
    ├── autome-plugin.json    ← manifest
    ├── nodes/
    │   └── my-node.ts        ← default-exports a NodeTypeSpec
    └── templates/
        └── my-template.json  ← { id, name, nodeType, config, ... }
```

**Plugin manifest** (`autome-plugin.json`):

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "nodeTypes": ["./nodes/my-node.ts"],
  "templates": ["./templates/*.json"]
}
```

**Node type file** (default-exports a `NodeTypeSpec`):

```typescript
// nodes/my-node.ts
import type { NodeTypeSpec } from 'autome/plugin';

export default {
  id: 'my-node',
  name: 'My Node',
  category: 'step',
  description: 'Does something useful',
  icon: 'zap',
  color: { bg: '#fafafa', border: '#64748b', text: '#334155' },
  configSchema: { type: 'object', properties: {} },
  defaultConfig: {},
  executor: {
    type: 'step',
    async execute({ config }) {
      return { output: { done: true } };
    },
  },
} satisfies NodeTypeSpec;
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
- **`PluginManifest`** — the manifest shape declared in `autome-plugin.json`
- **`LoadedPlugin`** — a fully resolved plugin (manifest + loaded node types + loaded templates)
- **`NodeTemplate`** — a preconfigured node snapshot

All are exported from `autome/plugin`. See [Plugin Authoring](./plugin-authoring.md) for full reference.
