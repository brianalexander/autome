# Wrapping Autome

This guide is for developers who want to publish an npm package that embeds autome under their own product name — with custom node types, providers, and branding — without requiring end-users to configure anything beyond `npm install -g my-product`.

---

## 1. Why Wrap?

Running autome directly (`npx autome start`) works fine for general use. Wrapping makes sense when:

- You want a **custom branded CLI** (`my-product start` instead of `autome start`)
- You ship **proprietary node types** (e.g. a Slack integration your customers shouldn't have to install separately)
- You want to lock in a **default configuration** (port, data directory, ACP provider)
- You are building an **internal tool** and want to embed autome as a library in an existing Node.js service

Wrapping is NOT required if you only want to add project-local plugins — those go in `./plugins/` and are discovered automatically at boot.

---

## 2. Minimal Wrapper

A wrapper is an npm package with a `bin` entry that calls `createCli` from `autome/cli`.

### `package.json` (your wrapper)

```json
{
  "name": "my-product",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "my-product": "./bin/my-product.js"
  },
  "dependencies": {
    "autome": "^0.1.0"
  }
}
```

### `bin/my-product.js`

```js
#!/usr/bin/env node
import { createCli } from 'autome/cli';

await createCli({
  name: 'my-product',
  version: '1.0.0',
}).run(process.argv);
```

That's it. `my-product --help` shows `my-product` branding. `my-product doctor` runs the standard checks.

---

## 3. Bundling Plugins into a Wrapper

Plugins are the primary way to ship custom node types and templates inside a wrapper.

### Authoring a node type in your wrapper source

```typescript
// src/nodes/slack-notify.ts
import { defineNodeType } from 'autome/plugin';
import type { StepExecutor } from 'autome/plugin';

const executor: StepExecutor = {
  type: 'step',
  async execute({ config, input }) {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: config.channel, text: String(input?.sourceOutput ?? '') }),
    });
    return { output: { sent: true } };
  },
};

export default defineNodeType({
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
      channel: { type: 'string', title: 'Channel' },
    },
    required: ['token', 'channel'],
  },
  defaultConfig: { token: '', channel: '' },
  executor,
});
```

### Bundling the plugin in your bin entry

```typescript
// bin/my-product.ts
import { createCli } from 'autome/cli';
import { definePlugin } from 'autome/plugin';
import slackNotifyNode from '../dist/nodes/slack-notify.js';

const slackPlugin = definePlugin(
  { id: 'slack', name: 'Slack Integration', version: '1.0.0' },
  { nodeTypes: [slackNotifyNode] },
);

await createCli({
  name: 'my-product',
  version: '1.0.0',
  plugins: [slackPlugin],
}).run(process.argv);
```

End-users see `slack-notify` in the node palette immediately after installing `my-product`. No manual plugin installation.

### Including templates

Templates can be bundled the same way:

```typescript
import { definePlugin, defineTemplate } from 'autome/plugin';

const alertTemplate = defineTemplate({
  id: 'slack-alert',
  name: 'Slack: Alert',
  nodeType: 'slack-notify',
  config: { channel: '#alerts' },
  exposed: ['config.channel'],
});

const slackPlugin = definePlugin(
  { id: 'slack', name: 'Slack', version: '1.0.0' },
  { nodeTypes: [slackNotifyNode], templates: [alertTemplate] },
);
```

---

## 4. Embedding in an Existing Node.js Application

If you already have a Node.js server and want to run autome in-process (not as a CLI), use `startServer` directly.

```typescript
import { startServer, loadConfig } from 'autome';
import { definePlugin } from 'autome/plugin';
import slackNotifyNode from './nodes/slack-notify.js';

const slackPlugin = definePlugin(
  { id: 'slack', name: 'Slack', version: '1.0.0' },
  { nodeTypes: [slackNotifyNode] },
);

// Load config (reads env vars + autome.config.ts in cwd)
const config = await loadConfig({
  port: 9999,
  dataDir: './data/autome',
});

// Start the server and get back the Fastify instance
const app = await startServer(config, {
  plugins: [slackPlugin],
});

// app is a Fastify instance — you can add routes, hooks, etc.
console.log('Autome running on port 9999');
```

`startServer` returns the Fastify instance. You can register additional routes on it or hook into its lifecycle.

### Graceful shutdown

```typescript
process.on('SIGINT', async () => {
  await app.close();
  process.exit(0);
});
```

---

## 5. Adding a Custom ACP Provider

To ship a custom ACP provider (e.g. your own agent CLI):

```typescript
// src/providers/my-agent.ts
import { defineProvider } from 'autome/plugin';

export default defineProvider({
  name: 'my-agent',
  displayName: 'My Agent',
  supportsSessionResume: false,
  tracksMcpReadiness: false,

  getCommand() { return 'my-agent-cli'; },
  getSpawnArgs({ agent }) {
    return agent ? ['run', '--agent', agent] : ['run'];
  },
  getSpawnEnv() { return {}; },

  async discoverAgents(opts) { return []; },
  async getAgentSpec(name) { return null; },
  getLocalAgentDir(workingDir) { return `${workingDir}/.my-agent`; },
  getGlobalAgentDir() { return `${process.env.HOME}/.my-agent`; },
  handleVendorNotification() { return null; },
});
```

Pass it in via `createCli` or `startServer`:

```typescript
import myAgentProvider from '../dist/providers/my-agent.js';

await createCli({
  name: 'my-product',
  version: '1.0.0',
  providers: [myAgentProvider],
  defaults: { acpProvider: 'my-agent' }, // use this provider by default
}).run(process.argv);
```

The provider can also be declared inside a plugin manifest's `providers` field so it gets discovered from the filesystem (useful for plugin authors who ship both a node type and its backing provider):

```json
{
  "id": "my-agent-plugin",
  "name": "My Agent Provider",
  "providers": ["./providers/my-agent.ts"]
}
```

---

## 6. Distribution

### Publishing to npm

```bash
npm publish --access public
```

### Global install

```bash
npm install -g my-product
my-product start
my-product --version
my-product doctor
```

### npx (no install)

```bash
npx my-product start
```

### Pointing to a specific port or data directory

Users can override via CLI flags or env vars:

```bash
my-product start --port 9000 --data-dir /var/lib/my-product
```

Or via a config file in their project directory (`autome.config.ts`):

```typescript
export default { port: 9000, dataDir: '/var/lib/my-product' };
```

---

## 7. Config Precedence

Config values are resolved in this order (highest wins):

1. **CLI flags** — `--port`, `--host`, `--data-dir`
2. **Environment variables** — `PORT`, `HOST`, `DATA_DIR`, `ACP_PROVIDER`, `NODE_ENV`
3. **Config file** — `autome.config.ts` (or `.js`, `.json`) in `process.cwd()`
4. **`defaults` in `createCli`** — the wrapper's bundled defaults
5. **Built-in defaults** — port `3001`, host `127.0.0.1`, etc.

The `defaults` option in `createCli` is applied beneath the config file but above the hard-coded defaults. This lets you set sensible defaults (e.g. `port: 9999`) that users can still override via env vars or config files.

```typescript
await createCli({
  name: 'my-product',
  version: '1.0.0',
  defaults: {
    port: 9999,
    dataDir: './my-product-data',
    acpProvider: 'my-agent',
  },
}).run(process.argv);
```

---

## 8. Doctor Command Branding

`my-product doctor` is automatically available because `createCli` wires up the `doctor` command with your branding. No extra work needed.

```
$ my-product doctor

  Environment
  ✓  Node.js >= 20 (found 22.x.x)
  ✓  Config loads without error
  ✓  DB dir writable (./my-product-data/orchestrator.db)

  Plugins (1 loaded)
  ✓  1 programmatic plugin(s) registered
  ✓  Slack Integration v1.0.0
         ✓  Node types (1): slack-notify

  Secrets
  ⚠  Master key stored in .master-key file — set AUTOME_MASTER_KEY env var for production

  ACP Providers
  ✓  my-agent (programmatic)

All checks passed.
```

The "programmatic" label distinguishes providers bundled into your wrapper from ones discovered from the filesystem.

---

## 9. Wrapper Project Layout

A complete wrapper project looks like this:

```
my-product/
├── package.json
├── tsconfig.json
├── bin/
│   └── my-product.ts          ← createCli entry point
├── src/
│   ├── nodes/
│   │   └── slack-notify.ts    ← defineNodeType(...)
│   ├── providers/
│   │   └── my-agent.ts        ← defineProvider(...)
│   └── templates/
│       └── slack-alert.ts     ← defineTemplate(...)
└── dist/                      ← compiled output
```

```json
// package.json (key fields)
{
  "name": "my-product",
  "type": "module",
  "bin": { "my-product": "./bin/my-product.js" },
  "scripts": {
    "build": "tsc",
    "start": "node --import tsx/esm bin/my-product.ts start"
  },
  "dependencies": {
    "autome": "^0.1.0"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "strict": true
  },
  "include": ["bin/**/*", "src/**/*"]
}
```
