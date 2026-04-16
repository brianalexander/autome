# Bootstrapping Guide

This guide walks through installing autome2 as a dependency and running your own branded instance with your plugins and templates bundled in.

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

Autome2 is designed to be embedded. You install it, drop an `autome.plugins.ts` file next to it, and run the server. Your plugins get registered at boot and the rest behaves identically to a stock autome2.

```
┌─────────────────────────────────────────────┐
│  Your Project                               │
│  ├── autome.plugins.ts   ← your plugins     │
│  ├── src/nodes/*.ts      ← custom node code │
│  ├── data/               ← runtime state    │
│  └── node_modules/                          │
│      └── autome2/        ← the core         │
└─────────────────────────────────────────────┘
```

The core (autome2) provides the server, workflow engine, UI, API, and DB layer. Your project provides extensions.

---

## Quick Start

### 1. Create a new project

```bash
mkdir my-autome
cd my-autome
npm init -y
npm install autome2
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
  "include": ["src/**/*", "autome.plugins.ts"]
}
```

### 3. Create your first plugin

```typescript
// autome.plugins.ts
import { definePlugin } from 'autome2/plugin';

export default definePlugin({
  name: 'my-autome',
  version: '1.0.0',
  templates: [
    {
      id: 'github-webhook-receiver',
      name: 'GitHub Webhook Receiver',
      nodeType: 'webhook-trigger',
      config: {
        output_schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            repository: { type: 'object' },
          },
          required: ['action', 'repository'],
        },
      },
    },
  ],
});
```

### 4. Add package.json scripts

```json
{
  "scripts": {
    "start": "tsx node_modules/autome2/src/server.ts",
    "dev": "tsx watch node_modules/autome2/src/server.ts",
    "dev:all": "concurrently -n api,web \"npm run dev\" \"npm --prefix node_modules/autome2/frontend run dev\""
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

A typical embedded autome2 project:

```
my-autome/
├── package.json
├── tsconfig.json
├── autome.plugins.ts              # Plugin registration
├── src/
│   ├── nodes/
│   │   ├── jira.ts                # Custom node type
│   │   └── slack.ts               # Another custom node type
│   ├── routes/
│   │   └── admin.ts               # Custom Fastify routes
│   └── templates/
│       ├── jira-bug.json          # Template definitions
│       └── slack-alert.json
├── data/                          # Runtime state (SQLite, workspaces)
│   ├── orchestrator.db
│   ├── workspaces/                # Code executor workspaces
│   └── agents/                    # ACP agent configs
└── .env                           # Environment config (optional)
```

### `autome.plugins.ts` (recommended pattern)

Keep the entry file small and delegate to modules:

```typescript
// autome.plugins.ts
import { definePlugin } from 'autome2/plugin';
import { jiraCreateTicketSpec } from './src/nodes/jira.js';
import { slackNotifySpec } from './src/nodes/slack.js';
import { registerAdminRoutes } from './src/routes/admin.js';
import jiraBugTemplate from './src/templates/jira-bug.json' assert { type: 'json' };
import slackAlertTemplate from './src/templates/slack-alert.json' assert { type: 'json' };

export default definePlugin({
  name: '@mycompany/autome-plugin',
  version: '1.0.0',
  nodeTypes: [jiraCreateTicketSpec, slackNotifySpec],
  templates: [jiraBugTemplate, slackAlertTemplate],
  registerRoutes: registerAdminRoutes,
  onReady: async ({ nodeRegistry }) => {
    console.log(`[mycompany] Loaded ${nodeRegistry.list().length} node types total`);
  },
});
```

---

## Configuration

Autome2 reads config from environment variables. Create a `.env` file or pass them directly.

### Core settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP API port |
| `DATABASE_PATH` | `./data/orchestrator.db` | SQLite file location |
| `NODE_ENV` | `development` | `production` enables caching/logging changes |

### Plugin loading

| Variable | Default | Purpose |
|---|---|---|
| `AUTOME_PLUGINS` | _unset_ | Path to a plugin file. Overrides `autome.plugins.ts` discovery. |

Plugin discovery order when `AUTOME_PLUGINS` is unset:

1. `./autome.plugins.ts` (or `.js`) in `process.cwd()`
2. `~/.autome/plugins/*.{ts,js,mjs}` (alphabetical)

Plugins from both sources are merged (project plugins first).

### ACP provider settings

Autome2 supports multiple LLM backends via ACP providers. Configure via env vars OR via the Settings page in the UI (the UI settings take precedence):

| Variable | Purpose |
|---|---|
| `ACP_PROVIDER` | Default provider: `kiro`, `opencode`, or `claude-code` |
| `OPENAI_API_KEY` | If using opencode |
| `ANTHROPIC_API_KEY` | If using claude-code |

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
npm --prefix node_modules/autome2/frontend run build

# Start the API in production mode
NODE_ENV=production npm start
```

The frontend assets end up in `node_modules/autome2/frontend/dist/`. Serve them with any static host (Nginx, Caddy, Cloudflare Pages, etc.) and point them at the API.

### Single-process production (simpler)

If you don't need separate deployment:

```bash
# Build once
npm --prefix node_modules/autome2/frontend run build

# Run — the API can serve the frontend static files if desired
NODE_ENV=production tsx node_modules/autome2/src/server.ts
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
RUN npm --prefix node_modules/autome2/frontend run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app .
ENV NODE_ENV=production
EXPOSE 3001
CMD ["npx", "tsx", "node_modules/autome2/src/server.ts"]
```

### State persistence

The `data/` directory contains all runtime state:

- `orchestrator.db` — SQLite database (workflows, instances, templates)
- `workspaces/` — code executor working directories with installed npm packages
- `agents/` — provider-specific agent configs

Mount this as a persistent volume in production. Backups are just `sqlite3 orchestrator.db .dump` + the `workspaces/` directory.

---

## Upgrades

### Updating autome2

```bash
npm update autome2
```

Autome2 follows semver. Breaking changes bump the major version. Your plugins survive minor and patch updates because they depend only on the `autome2/plugin` barrel.

If a breaking plugin API change lands, bump the `apiVersion` field on your plugin to match.

### Database migrations

Autome2 runs migrations automatically on boot. New columns and tables are added in place; existing data is preserved. You don't need to manage the migration process yourself.

If you need to roll back, keep a backup of `data/orchestrator.db` before upgrading.

### Plugin template updates

Template changes propagate automatically:

- Plugin ships `templates: [{ id: 'acme-jira', name: 'New Name', ... }]`
- Next boot, autome2 detects the change and updates the DB row
- Users see the new name on the Templates page

Your users' local (non-plugin) templates are never overwritten.

---

## Troubleshooting

### `[plugins] AUTOME_PLUGINS path not found`

The `AUTOME_PLUGINS` env var points to a path that doesn't exist. Check the path is absolute or relative to `process.cwd()`.

### `Unknown tool: my-tool` in agent runs

An agent tried to call an MCP tool that isn't registered. Check that your plugin includes any MCP servers it needs via the ACP agent config.

### Plugin doesn't appear to load

Check the boot logs for:

```
[plugins] Loading "your-plugin-name" v1.0.0
[plugins]   Registered node type: your-node-id
```

If the load message is missing:
- Confirm `autome.plugins.ts` exists in `process.cwd()`
- Check `tsx` is installed and can resolve `autome2/plugin`
- Make sure you `export default` (not named export)

### `Cannot find module 'autome2/plugin'`

The `exports` field in `package.json` requires Node 16+ resolution. If you're using older tooling, import from `autome2/dist/plugin/index.js` directly. But the recommended setup uses `tsx` which handles this natively.

### Templates not showing

- Confirm the `nodeType` in the template matches a registered node type ID
- Check `[plugins]   Registered template: ...` in boot logs
- Query the DB directly: `sqlite3 data/orchestrator.db "SELECT id, name, source FROM node_templates"`

### Workflow stages hang on cancel

Rare, but the execution context has a 5s timeout on cancel. If it fires, the DB is force-updated and the instance removed from active — subsequent operations work fine. Check logs for `[runner.cancel] ... did not settle within 5000ms`.

---

## Further Reading

- [Plugin Authoring Guide](./plugin-authoring.md) — full reference for node types, templates, routes, hooks
- [Documentation Index](./README.md)
