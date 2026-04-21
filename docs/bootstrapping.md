# Bootstrapping Guide

This guide walks through installing autome as a dependency and running your own branded instance with your plugins and templates bundled in.

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Project Layout](#project-layout)
- [Configuration](#configuration)
- [Running the Server](#running-the-server)
- [Deploying](#deploying)
- [Upgrades](#upgrades)
- [Troubleshooting](#troubleshooting)

---

## Overview

Autome is designed to be embedded. You install it, create a `plugins/` directory next to it, and run the server. Your plugins get discovered and registered at boot — the rest behaves identically to a stock autome.

> **Looking for the programmatic API?** If you're publishing a branded npm package that bundles plugins as part of its dist, see [Wrapping Autome](./wrapping-autome.md) — that guide covers `createCli` and `startServer`.

```
┌─────────────────────────────────────────────┐
│  Your Project                               │
│  ├── plugins/            ← your plugins     │
│  │   └── my-plugin/                         │
│  │       ├── autome-plugin.json             │
│  │       └── nodes/...                      │
│  ├── data/               ← runtime state    │
│  └── node_modules/                          │
│      └── autome/        ← the core         │
└─────────────────────────────────────────────┘
```

The core (autome) provides the server, workflow engine, UI, API, and DB layer. Your project provides extensions via the `plugins/` directory.

---

## Quick Start

### 1. Create a new project

```bash
mkdir my-autome
cd my-autome
npm init -y
npm install autome
npm install -D typescript tsx @types/node
```

### 2. Add a `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*", "plugins/**/*"]
}
```

### 3. Create your first plugin

```bash
mkdir -p plugins/my-plugin/templates
```

```json
// plugins/my-plugin/autome-plugin.json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "templates": ["./templates/*.json"]
}
```

```json
// plugins/my-plugin/templates/github-webhook.json
{
  "id": "github-webhook-receiver",
  "name": "GitHub Webhook Receiver",
  "nodeType": "webhook-trigger",
  "config": {
    "output_schema": {
      "type": "object",
      "properties": {
        "action": { "type": "string" },
        "repository": { "type": "object" }
      },
      "required": ["action", "repository"]
    }
  }
}
```

### 4. Add package.json scripts

```json
{
  "scripts": {
    "start": "tsx node_modules/autome/src/server.ts",
    "dev": "tsx watch node_modules/autome/src/server.ts",
    "dev:all": "concurrently -n api,web \"npm run dev\" \"npm --prefix node_modules/autome/frontend run dev\""
  }
}
```

### 5. Run it

```bash
npm run dev:all
```

Open http://localhost:5173. Your custom template appears in the Templates page and the Node Palette.

---

## Project Layout

A typical embedded autome project:

```
my-autome/
├── package.json
├── tsconfig.json
├── plugins/
│   ├── jira/
│   │   ├── autome-plugin.json
│   │   ├── nodes/
│   │   │   ├── create-ticket.ts    ← default-exports a NodeTypeSpec
│   │   │   └── search.ts
│   │   └── templates/
│   │       ├── bug-report.json
│   │       └── feature-request.json
│   └── slack/
│       ├── autome-plugin.json
│       └── nodes/
│           └── notify.ts
├── data/                           ← runtime state (SQLite, workspaces)
│   ├── orchestrator.db
│   ├── workspaces/
│   └── agents/
└── .env                            ← environment config (optional)
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

Autome reads config from environment variables. Create a `.env` file or pass them directly.

### Core settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP API port |
| `HOST` | `127.0.0.1` | Interface to bind to; use `0.0.0.0` to expose on LAN |
| `DATA_DIR` | `./data` | Root data directory (DB, workspaces, etc.) |
| `DATABASE_PATH` | `./data/orchestrator.db` | SQLite file location (overrides DATA_DIR for DB only) |
| `NODE_ENV` | `development` | `production` enables caching/logging changes |

You can also configure autome via a `autome.config.ts` (or `.js` / `.json`) file in your project root. It is merged with env vars (env takes precedence). See `src/config/types.ts` for all available keys.

### Plugin discovery

| Variable | Default | Purpose |
|---|---|---|
| `AUTOME_PLUGINS_DIR` | `./plugins` | Override the project-local plugins directory path |

Plugin discovery order:

1. `./plugins/*/autome-plugin.json` (or `$AUTOME_PLUGINS_DIR/*/autome-plugin.json`)
2. `~/.autome/plugins/*/autome-plugin.json` (user-global, always scanned)

Plugins from both sources are merged (project-local first). Each plugin must live in its own subdirectory and have an `autome-plugin.json` manifest — loose `.ts`/`.js` files at the top of the plugins directory are not picked up.

### ACP provider settings

Autome supports multiple LLM backends via ACP providers. Configure via env vars OR via the Settings page in the UI (the UI settings take precedence):

| Variable | Purpose |
|---|---|
| `ACP_PROVIDER` | Default provider: `kiro`, `opencode`, or `claude-code` |

Any API keys required by the underlying ACP provider (e.g. `ANTHROPIC_API_KEY` for claude-code) should be set in your environment before starting the server — autome passes them through to the provider process.

---

## Running the Server

### Development

```bash
npm run dev:all
```

Starts the API server on port 3001 and the frontend dev server on 5173. Hot reload is enabled for both.

### Production

```bash
# Build the frontend static assets
npm --prefix node_modules/autome/frontend run build

# Start the API in production mode
NODE_ENV=production npm start
```

The frontend assets end up in `node_modules/autome/frontend/dist/`. Serve them with any static host (Nginx, Caddy, Cloudflare Pages, etc.) and point them at the API.

### Single-process production (simpler)

If you don't need separate deployment:

```bash
# Build once
npm --prefix node_modules/autome/frontend run build

# Run — the API can serve the frontend static files if desired
NODE_ENV=production tsx node_modules/autome/src/server.ts
```

---

## Deploying

### Dockerfile (example)

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm --prefix node_modules/autome/frontend run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["npx", "tsx", "node_modules/autome/src/server.ts"]
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

### Plugin doesn't appear to load

Check the boot logs for:

```
[plugins] Loaded "your-plugin-name" v1.0.0 (1 node type(s), 2 template(s), 0 provider(s))
```

If the load message is missing:
- Confirm `plugins/your-plugin/autome-plugin.json` exists in `process.cwd()`
- Run `npx autome doctor` to see load failures
- Ensure the `autome-plugin.json` has both `id` and `name` fields

### `Failed to parse autome-plugin.json`

Your manifest has a JSON syntax error. Validate it with `node -e "JSON.parse(require('fs').readFileSync('plugins/my-plugin/autome-plugin.json','utf8'))"`.

### Node type file fails to import

The file must default-export a `NodeTypeSpec`. Common issues:
- Named export instead of default export (use `export default spec`, not `export { spec }`)
- Missing `id` field on the exported object
- TypeScript compilation error (check `npx tsc --noEmit`)

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
