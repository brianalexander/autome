# Bootstrapping Guide

This guide walks through installing autome as a dependency and running your own branded instance with your plugins and templates bundled in.

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Install Options](#install-options)
- [Project Layout](#project-layout)
- [Configuration](#configuration)
- [Running the Server](#running-the-server)
- [Deploying](#deploying)
- [Upgrades](#upgrades)
- [Troubleshooting](#troubleshooting)

---

## Overview

Autome is designed to be embedded. You install it, point it at a plugins directory, and run the server. Your plugins get discovered and registered at boot — the rest behaves identically to a stock autome.

> **Looking for the programmatic API?** If you're publishing a branded npm package that bundles plugins as part of its dist, see [Wrapping Autome](./wrapping-autome.md) — that guide covers `createCli` and `startServer`.

```
┌─────────────────────────────────────────────┐
│  Your Project                               │
│  ├── my-plugin/          ← your plugins     │
│  │   ├── autome-plugin.json                 │
│  │   └── nodes/...                          │
│  ├── autome.config.json  ← optional         │
│  ├── data/               ← runtime state    │
│  └── node_modules/                          │
│      └── autome/        ← the core         │
└─────────────────────────────────────────────┘
```

The core (autome) provides the server, workflow engine, UI, API, and DB layer. Your project provides extensions via one or more plugin directories.

---

## Quick Start

```bash
mkdir my-autome && cd my-autome
npm init -y
npm i <autome-source>           # see Install Options section
npx autome start                # UI + API on http://127.0.0.1:3001
```

### First plugin

```bash
mkdir -p my-plugin/nodes
```

`my-plugin/autome-plugin.json`:
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "nodeTypes": ["./nodes/reverse.ts"]
}
```

`my-plugin/nodes/reverse.ts`:
```typescript
import { defineNodeType } from 'autome/plugin';

export default defineNodeType({
  id: 'reverse',
  name: 'Reverse String',
  category: 'step',
  configSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', title: 'Text to reverse' },
    },
  },
  defaultConfig: { text: '' },
  executor: {
    type: 'step',
    async execute({ config }) {
      const text = (config.text as string) ?? '';
      return { output: { reversed: text.split('').reverse().join('') } };
    },
  },
});
```

`autome.config.json`:
```json
{
  "plugins": ["./my-plugin"]
}
```

```bash
npx autome start
```

Open http://127.0.0.1:3001 — the `reverse` node is in the node palette.

**No `"type": "module"` in the consumer `package.json` and no `package.json` in `my-plugin/`.** Autome loads plugin `.ts` files through a transpiler that's insensitive to your project's module type.

---

## Install Options

| Source | Command | Use when |
|---|---|---|
| npm registry | `npm i autome` | After publish (not available yet). |
| GitHub | `npm i github:YourOrg/autome-repo` | Easiest pre-publish sharing. npm clones, runs `prepare` (which builds), packs with the `files` allowlist, and installs. |
| Local tarball | `npm pack` in the autome source → `npm i ./autome-0.1.0.tgz` in the consumer | Same bytes as a registry install. No git needed. |
| Local symlink | `npm i /path/to/autome-source` (requires `npm run build:all` first) | Fastest re-installs during active development. `prepare` does NOT run — you must build manually. |
| Global symlink | `cd autome && npm link` then `cd consumer && npm link autome` | Same semantics as local symlink, different ergonomics. |

---

## Project Layout

A minimal embedded autome project — no `tsconfig.json`, no `src/`:

```
my-autome/
├── package.json
├── autome.config.json         ← optional
├── my-plugin/
│   ├── autome-plugin.json
│   ├── nodes/
│   │   └── reverse.ts
│   └── templates/
│       └── starter.json       ← optional
└── data/                      ← created at boot
    ├── orchestrator.db
    ├── workspaces/
    └── agents/                ← provider-specific configs
```

### Plugin manifest (`autome-plugin.json`)

The manifest declares everything autome needs to load your plugin:

```json
{
  "id": "jira",
  "name": "Jira Integration",
  "version": "1.0.0",
  "description": "Custom Jira node types and templates",
  "nodeTypes": ["./nodes/create-ticket.ts", "./nodes/search.ts"],
  "templates": ["./templates/*.json"],
  "providers": ["./providers/jira-provider.ts"]
}
```

Node type files must default-export a `NodeTypeSpec`. Template files are plain JSON. Provider files must default-export a class or object implementing `AcpProvider` (with `name` and `getCommand`). The `providers` field is optional — omit it if your plugin has no custom ACP providers.

---

## Configuration

Autome reads config from environment variables. Create a `.env` file or pass them directly. You can also declare everything in `autome.config.json` (or `.ts` / `.js`) in your project root — env vars take precedence, but the config file is often more convenient.

### Core settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP API port |
| `HOST` | `127.0.0.1` | Interface to bind to; use `0.0.0.0` to expose on LAN |
| `DATA_DIR` | `./data` | Root data directory (DB, workspaces, etc.) |
| `DATABASE_PATH` | `./data/orchestrator.db` | SQLite file location (overrides DATA_DIR for DB only) |
| `NODE_ENV` | `development` | `production` enables caching/logging changes |

### Plugin discovery

The recommended way to register plugins is via the `plugins` array in your config file:

```json
{
  "plugins": ["./my-plugin", "./another-plugin"]
}
```

Discovery is additive and runs in this order:

1. **`plugins: []` array in `autome.config.*`** — recommended; explicit and visible.
2. **`./plugins/*/autome-plugin.json`** in `process.cwd()` — directory auto-scan. Override the directory with `AUTOME_PLUGINS_DIR`.
3. **`~/.autome/plugins/*/autome-plugin.json`** — user-global, always scanned.

Plugins from all sources are merged (earlier sources take priority on ID collision). Each plugin must live in its own subdirectory and have an `autome-plugin.json` manifest — loose `.ts`/`.js` files at the top of a plugin directory are not picked up.

### ACP provider settings

Autome supports multiple LLM backends via ACP providers. Configure via env vars OR via the Settings page in the UI (the UI settings take precedence):

| Variable | Purpose |
|---|---|
| `ACP_PROVIDER` | Default provider: `kiro`, `opencode`, or `claude-code` |

Any API keys required by the underlying ACP provider (e.g. `ANTHROPIC_API_KEY` for claude-code) should be set in your environment before starting the server — autome passes them through to the provider process.

---

## Running the Server

```bash
npx autome start
```

One process. UI + API on port 3001 (configurable via `PORT`, `--port`, or `autome.config`). The frontend is served from the same port — no separate asset server needed.

For development with hot-reload on the frontend, clone the autome source repo and run its own `npm run dev:all` — that is an autome-monorepo-internal workflow and not intended for consumer projects.

---

## Deploying

### Dockerfile (example)

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3001
CMD ["npx", "autome", "start"]
```

### State persistence

The `data/` directory contains all runtime state:

- `orchestrator.db` — SQLite database (workflows, instances, templates)
- `workspaces/` — code executor working directories with installed npm packages
- `agents/` — provider-specific agent configs

Mount this as a persistent volume in production. Backups are just `sqlite3 orchestrator.db .dump` + the `workspaces/` directory.

---

## Upgrades

### Updating autome

```bash
npm update autome
```

Autome follows semver. Breaking changes bump the major version. Your plugins survive minor and patch updates because they depend only on the `autome/plugin` barrel.

### Database migrations

Autome runs migrations automatically on boot. New columns and tables are added in place; existing data is preserved. You don't need to manage the migration process yourself.

If you need to roll back, keep a backup of `data/orchestrator.db` before upgrading.

### Plugin template updates

Template changes propagate automatically:

- Plugin ships updated `templates/bug-report.json` with a new name
- Next boot, autome detects the change and updates the DB row
- Users see the new name on the Templates page

Your users' local (non-plugin) templates are never overwritten.

---

## Troubleshooting

### `npx autome: command not found`

Confirm autome installed correctly:

```bash
ls node_modules/autome/bin/autome.js
```

If the file is missing, re-install: `npm i autome` (or whichever install source you used).

### Plugin doesn't appear to load

Check the boot logs for:

```
[plugins] Loaded "your-plugin-name" v1.0.0 (1 node type(s), 2 template(s), 0 provider(s))
```

If the load message is missing:
- Confirm the plugin directory path is listed in `autome.config.json`'s `plugins` array, or that `autome-plugin.json` exists under `plugins/your-plugin/` in `process.cwd()`
- Run `npx autome doctor` to see load failures
- Ensure the `autome-plugin.json` has both `id` and `name` fields

### `Failed to parse autome-plugin.json`

Your manifest has a JSON syntax error. Validate it with `node -e "JSON.parse(require('fs').readFileSync('my-plugin/autome-plugin.json','utf8'))"`.

### Node type file fails to import

The file must default-export a `NodeTypeSpec`. Common issues:
- Named export instead of default export (use `export default spec`, not `export { spec }`)
- Missing `id` field on the exported object
- TypeScript syntax error visible in the boot logs

### Templates not showing

- Confirm the `nodeType` in the template JSON matches a registered node type ID
- Check `[plugins] Registered template: ...` in boot logs
- Query the DB directly: `sqlite3 data/orchestrator.db "SELECT id, name, source FROM node_templates"`

### `Unknown tool: my-tool` in agent runs

An agent tried to call an MCP tool that isn't registered. Check that your plugin includes any MCP servers it needs via the ACP agent config.

### Workflow stages hang on cancel

Rare, but the execution context has a 5s timeout on cancel. If it fires, the DB is force-updated and the instance removed from active — subsequent operations work fine. Check logs for `[runner.cancel] ... did not settle within 5000ms`.

---

## Further Reading

- [Plugin Authoring Guide](./plugin-authoring.md) — full reference for node types, templates, and discovery
- [Documentation Index](./README.md)
