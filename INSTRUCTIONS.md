# Agent pipeline orchestrator — MVP spec

## Vision

A local-first application that lets users build, run, and observe automation pipelines where **AI agents (via kiro-cli ACP) are the execution units**. Pipelines are triggered by events (Jira ticket assigned, GitHub PR opened, Slack message, cron, etc.), flow through agent stages connected by approval gates, and produce observable, replayable execution histories.

This is NOT a chatbot. It is an **automation pipeline platform with full visibility** — think CI/CD, but where every "step" is an AI agent with tools, and you can jump into any running agent's session in real time.

---

## Core concepts

### Primitives

There are 6 primitive types in the system:

1. **Event provider** — An adapter that normalizes external events into a common format. Examples: Jira webhook listener, GitHub webhook, Slack events API, cron scheduler, manual trigger, or a custom user-defined provider.

2. **Workflow definition** — A directed graph template (cycles are supported) describing: what event triggers it, what stages run, in what order, with what configuration. Stored as JSON. This is the "blueprint." Cycles enable iterative patterns like code-gen → review → revise → re-review. (Previously called "pipeline definition" in early docs; the type is `WorkflowDefinition` in `src/schemas/pipeline.ts`.)

3. **Workflow instance** — A single execution of a workflow definition, spawned when a matching event fires. Has its own state, context accumulator, and lifecycle. (Type: `WorkflowInstance` in `src/types/instance.ts`.)

4. **Agent stage** — A node in the workflow that spawns a `kiro-cli acp` process, creates a session, injects context, and lets the agent work. Configured by referencing a kiro agent by `agentId` (resolved from `.kiro/agents/<agentId>.json`); the canonical agent config (model, prompt, tools, MCP servers) comes from the agent definition, while the stage only defines workflow-specific fields (`max_iterations`, `max_turns`, `timeout_minutes`) and optional `overrides`.

5. **Gate** — A control flow node that pauses the pipeline until a condition is met. Types: `manual` (human clicks approve), `conditional` (expression evaluates to true), `auto` (always passes).

6. **Watcher** — An event listener attached to a running stage. When the watched event fires, it injects data into the stage's active ACP session. Example: a GitHub PR comment watcher that feeds new comments into a code review agent.

### Data flow between stages

This is a critical design decision. Here is how it works:

Each pipeline instance maintains a **context object** — a JSON document that accumulates outputs from every stage execution. Because the graph supports cycles, a stage can execute multiple times. The context tracks this with an **iteration-aware structure**:

- `context.stages[stageId].runs` — An array of all executions of this stage (most recent last).
- `context.stages[stageId].latest` — Shortcut alias for the most recent run's output.
- `context.stages[stageId].run_count` — How many times this stage has executed.

When a stage completes, its output is appended to the `runs` array and `latest` is updated. When the next stage starts, it receives the full context. Templates can reference `{{ stages.code-gen.latest }}` to get the most recent output, or `{{ stages.code-reviewer.runs[0].output }}` to get a specific iteration.

**How cycles work — the code-gen/review example:**

```
code-gen agent
  → produces { code: "...", tests: "..." }
  → edge to: code-reviewer

code-reviewer agent
  → reviews the code from context.stages.code-gen.latest
  → calls workflow_complete({ decision: "revise", notes: "..." })
  → edge conditions:
      output.decision === "revise"  → back to code-gen
      output.decision === "approved" → forward to code-pusher

code-gen agent (2nd iteration)
  → receives context showing:
      - its own prior output (context.stages.code-gen.latest)
      - the reviewer's notes (context.stages.code-reviewer.latest)
      - run_count: 2 (so it knows this is a revision)
  → produces improved { code: "...", tests: "..." }
  → edge to: code-reviewer (again)
```

The reviewer's decision drives the routing. No separate gate node is needed for this pattern — the conditional edges on the reviewer's output handle it. Gates are still useful for human-in-the-loop approval, but agent-driven routing uses conditional edges.

**Cycle safety**: Every stage has a `max_iterations` field (default: 5). If a stage has been executed `max_iterations` times in a single pipeline instance, the engine refuses to re-execute it and fails the instance. This prevents infinite loops. The agent is told its current iteration count via context, so it can be more aggressive about converging on later attempts.

**How an agent stage produces output:**

The orchestrator provides every agent with a special MCP tool called `workflow_control`. This is an MCP server run by the orchestrator itself (not by the user). It exposes these tools:

```
workflow_complete(output: JSON)
  — Agent calls this when it has finished its work.
  — The output must conform to the stage's declared output_schema (if one is set).
  — Calling this tool ends the stage and advances the pipeline.
  — The engine evaluates outgoing edge conditions against this output to determine
    which stage(s) to execute next (including potentially cycling back).

workflow_status(status: string, message: string)
  — Agent calls this to report progress without completing.
  — Status appears in the pipeline dashboard in real time.

workflow_get_context()
  — Agent calls this to read the accumulated context from prior stages.
  — Returns the full context object, including all prior iterations.

workflow_request_input(prompt: string)
  — Agent calls this to pause and ask the human operator a question.
  — The pipeline enters a "waiting for input" state visible in the dashboard.
  — When the human responds, the response is injected into the agent's session.
```

**Output schema enforcement:**

Each agent stage can declare an `output_schema` in its configuration. When the agent calls `workflow_complete`, the orchestrator validates the output against the schema. If it doesn't match, the orchestrator sends a message back into the ACP session telling the agent what's wrong, and the agent can retry. The *next* stage's system prompt can reference what shape of data it expects, so the upstream agent knows what to produce.

**Edges with conditions determine routing — including cycles:**

When a stage completes, the engine evaluates all outgoing edges. Each edge can have a `condition` — a JS expression that receives `output` (the stage's workflow_complete output) and `context` (the full pipeline context). If multiple edges match, all their targets execute (fan-out). If no edges match, the pipeline fails with a routing error.

Example flow:
```
Deep dive agent (output_schema: { requirements: string[], acceptance_criteria: string[] })
  → calls workflow_complete({ requirements: [...], acceptance_criteria: [...] })
  → orchestrator validates, writes to context
  → Implementer agent receives context including the requirements
  → Its system prompt says: "You will receive requirements in context.stages.deep-dive.latest"
```

### Jumping into a running agent session

Every agent stage runs in a `kiro-cli acp` process with a live session. The orchestrator tracks the session ID and the subprocess handle. The UI can connect to this session at any time by:

1. Reading the ACP session's streaming output (the `session/update` notifications that contain `agent_message_chunk` events)
2. Injecting messages via `session/prompt`

When the user opens an agent node in the dashboard, they see the agent's conversation history (accumulated from the stream) and a text input to send messages. This is a real ACP session — the user is talking to the agent alongside its autonomous work. The agent sees both the orchestrator's injected context and the human's messages in the same conversation.

When the user is NOT watching, the agent runs autonomously. The stream is still captured and stored for later review.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Frontend (React)                      │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Pipeline      │  │ Pipeline     │  │ Agent session  │  │
│  │ author        │  │ dashboard    │  │ viewer         │  │
│  │ (React Flow + │  │ (React Flow  │  │ (ACP stream    │  │
│  │  AI chat)     │  │  + state)    │  │  + input)      │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
└────────────────────────┬─────────────────────────────────┘
                         │ WebSocket + REST
┌────────────────────────┴─────────────────────────────────┐
│                   Backend (Node.js)                        │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Restate       │  │ Event bus    │  │ ACP manager    │  │
│  │ workflow      │  │ + router     │  │ (process pool) │  │
│  │ (durable      │  │              │  │                │  │
│  │  execution)   │  │              │  │                │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Workflow      │  │ Event        │  │ AI author      │  │
│  │ control MCP   │  │ providers    │  │ service        │  │
│  │ server        │  │ (adapters)   │  │ (LLM calls)    │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │    kiro-cli acp     │
              │    (subprocesses)   │
              └─────────────────────┘
```

### Tech stack

- **Frontend**: React 18 + TypeScript, Vite 6, @xyflow/react v12 (React Flow) for canvas, Tailwind CSS v4
- **Routing/data**: TanStack Router (file-based) + TanStack Query (auto-invalidation via WebSocket). Zustand for UI-only state.
- **Backend**: Node.js + TypeScript, Express (REST + WebSocket)
- **Database**: SQLite (local-first, single file, zero setup) via better-sqlite3
- **Workflow engine**: Restate (durable execution — `ctx.run`, `ctx.promise`, crash recovery). Replaces the hand-rolled state machine in the original spec.
- **ACP communication**: kiro-cli ACP via `@agentclientprotocol/sdk` (`ClientSideConnection`), managed by `ACPProcessPool`
- **AI authoring**: kiro-cli ACP (pipeline-author agent), NOT direct Anthropic API. Streams via WebSocket.
- **Layout engine**: elkjs for auto-laying out workflow graphs (handles cycles, unlike dagre which is DAG-only)
- **Schema validation**: Zod v4 schemas in `src/schemas/pipeline.ts` — single source of truth for types, runtime validation, and OpenAPI generation
- **Node type registry**: Extensible registry (`src/nodes/registry.ts`) mapping stage types to `NodeTypeSpec` implementations. Built-in types include: `agent`, `gate`, `manual-trigger`, `webhook-trigger`, `cron-trigger`, `http-request`, `transform`, `code-executor`. New node types can be registered at startup.

---

## Data model

### Workflow definition (stored as JSON, authored in the UI)

> **Note:** All types are defined as Zod schemas in `src/schemas/pipeline.ts` and re-exported as TypeScript types from `src/types/pipeline.ts`. The schemas are the single source of truth — they drive both runtime validation and OpenAPI generation.

```typescript
// Defined via WorkflowDefinitionSchema in src/schemas/pipeline.ts
interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  active: boolean;

  trigger: {
    provider: string;       // "manual", "webhook"
    filter?: Record<string, any>;
  };

  stages: StageDefinition[];
  edges: EdgeDefinition[];   // Discriminated union by edge_type (agent-to-agent, trigger-to-agent, etc.)
}

interface StageDefinition {
  id: string;
  type: "agent" | "gate" | "transform" | "trigger";
  name?: string;                       // Human-readable name shown on the canvas
  position?: { x: number; y: number }; // React Flow position (auto-laid out if absent)

  // Trigger config (when type="trigger")
  trigger?: {
    provider: "manual" | "webhook";
    filter?: Record<string, any>;
    webhook?: { secret?: string; payload_filter?: string };
  };

  // Agent stage config (when type="agent")
  // References a kiro agent by agentId; canonical config (model, prompt, tools, MCP servers)
  // comes from .kiro/agents/<agentId>.json. Only workflow-specific fields live here.
  agent?: {
    agentId: string;                   // Agent name from .kiro/agents/ directory
    max_iterations?: number;           // max times this stage can re-execute in one instance (default: 5, cycle safety)
    max_turns?: number;                // safety limit on agent conversation turns per execution
    timeout_minutes?: number;
    overrides?: {                      // Optional overrides on the canonical agent spec
      model?: string;
      additional_prompt?: string;
      additional_tools?: string[];
      additional_mcp_servers?: MCPServerConfig[];
    };
  };

  // Gate config
  gate?: {
    type: "manual" | "conditional" | "auto";
    condition?: string;               // JS expression evaluated against context
    message?: string;                 // shown to human for manual gates
    timeout_minutes?: number;
    timeout_action?: "approve" | "reject";
  };

  // Watcher config (attached to agent stages)
  watchers?: WatcherDefinition[];
}

interface WatcherDefinition {
  id: string;
  provider: string;
  event: string;
  filter?: Record<string, any>;
  injection_template?: string;   // how to format the event data before injecting into the session
}

interface EdgeDefinition {
  id: string;
  source: string;   // stage id
  target: string;   // stage id (can be the same as a prior stage — this is a cycle)
  label?: string;    // human-readable label shown on the edge, e.g. "Approved", "Needs revision"
  condition?: string;  // JS expression evaluated against { output, context }
                       // Examples:
                       //   "output.decision === 'approved'"
                       //   "output.decision === 'revise'"
                       //   "context.stages['code-gen'].run_count < 3"
                       // If omitted, edge is unconditional (always taken).
                       // If multiple edges from same source match, all targets execute (fan-out).
                       // If no edges match, pipeline fails with routing error.
}

interface MCPServerConfig {
  name: string;           // display name
  command: string;        // e.g. "npx" or path to binary
  args: string[];         // e.g. ["-y", "@modelcontextprotocol/server-github"]
  env?: Record<string, string>;
}
```

### Workflow instance (runtime state)

```typescript
interface WorkflowInstance {
  id: string;
  definition_id: string;
  status: "running" | "waiting_gate" | "waiting_input" | "completed" | "failed" | "cancelled";
  trigger_event: Event;           // the event that spawned this instance
  created_at: string;
  updated_at: string;
  completed_at?: string;

  context: {
    trigger: any;                 // the raw event payload
    stages: Record<string, {
      status: "pending" | "running" | "completed" | "failed" | "skipped";
      run_count: number;          // how many times this stage has executed (supports cycles)
      runs: StageRun[];           // full history of all executions (most recent last)
      latest?: any;               // shortcut: runs[runs.length-1].output (most recent output)
      acp_session_id?: string;    // for connecting to live session (current/most recent run)
    }>;
  };

  current_stage_ids: string[];    // array — multiple stages can be active (fan-out/parallel)
}

interface StageRun {
  iteration: number;              // 1-indexed
  started_at: string;
  completed_at?: string;
  status: "running" | "completed" | "failed";
  output?: any;                   // the data from workflow_complete()
  error?: string;
  transcript?: ACPMessage[];      // full conversation history for this run
}
```

### Event (common format)

```typescript
interface Event {
  id: string;
  provider: string;
  type: string;               // "issue.assigned", "pr.comment.created", etc.
  timestamp: string;
  payload: any;               // provider-specific data
  metadata?: Record<string, any>;
}
```

---

## MVP scope — three workstreams

### Workstream 1: ACP integration layer

**Goal**: Reliably spawn, communicate with, and manage `kiro-cli acp` processes.

#### ACP client (`src/acp/client.ts`)

```typescript
class ACPClient extends EventEmitter {
  private process: ChildProcess;
  private sessionId: string | null = null;
  private messageBuffer: string = "";
  private pendingRequests: Map<number, { resolve, reject }>;

  constructor(private config: { 
    kiroBin: string;        // path to kiro-cli binary
    workingDir: string;     // cwd for the agent
  }) {}

  async start(): Promise<void>
  // Spawns `kiro-cli acp` as a child process.
  // Sets up stdio pipes for JSON-RPC communication.
  // Sends `initialize` request with client capabilities:
  //   fs.readTextFile, fs.writeTextFile, terminal (all true)
  // Stores the agentCapabilities from the response.

  async createSession(name?: string): Promise<string>
  // Sends `session/new` request.
  // Returns sessionId.
  // Stores sessionId for subsequent calls.

  async prompt(content: string | ContentBlock[]): Promise<void>
  // Sends `session/prompt` with the given content.
  // Does NOT wait for the full response — streams via events.
  // Emits events as notifications come in:
  //   "chunk"       — agent_message_chunk (text streaming)
  //   "tool_call"   — agent is calling a tool
  //   "tool_result" — tool call completed
  //   "done"        — agent turn complete
  //   "error"       — something went wrong

  async handleToolRequest(method: string, params: any): Promise<any>
  // Handles requests FROM kiro-cli TO our client:
  //   fs/readTextFile  — read a file
  //   fs/writeTextFile — write a file
  //   terminal/execute — run a shell command
  // These are the capabilities we advertised in initialize.

  async kill(): Promise<void>
  // Gracefully terminate the process.

  getTranscript(): ACPMessage[]
  // Returns the full conversation history accumulated from streaming.
}
```

#### ACP process pool (`src/acp/pool.ts`)

```typescript
class ACPProcessPool {
  private processes: Map<string, ACPClient> = new Map();

  async spawn(stageId: string, config: AgentStageConfig): Promise<ACPClient>
  // Creates a new ACPClient for a pipeline stage.
  // Configures MCP servers by writing a .kiro/settings.json in the working dir.
  // Starts the process and initializes the session.

  async inject(stageId: string, message: string): Promise<void>
  // Sends a message into a running stage's ACP session.
  // Used by: human jumping in, watcher events, orchestrator commands.

  getClient(stageId: string): ACPClient | undefined
  // Returns the active client for a stage (for the UI to connect to).

  async terminate(stageId: string): Promise<void>
  // Kills a specific stage's process.

  async terminateAll(): Promise<void>
  // Cleanup on shutdown.
}
```

#### Kiro agent definition format (`.kiro/agents/<agentId>.json`)

Agent stage configs reference agents by `agentId`. The canonical agent definitions live in `.kiro/agents/` and are discovered at startup by the agent discovery module (`src/agents/discovery.ts`). Local agents (in the project) take precedence over global agents (in `~/.kiro/agents/`).

```json
{
  "name": "code-generator",
  "description": "Implements features based on requirements",
  "prompt": "You are a senior software engineer...",
  "model": "claude-sonnet-4",
  "tools": ["read", "write", "shell", "@github", "@filesystem"],
  "allowedTools": ["read", "write", "shell", "@github/*", "@filesystem/*"],
  "includeMcpJson": true
}
```

#### MCP server configuration

When spawning an agent, the orchestrator writes a `.kiro/settings.json` in the agent's working directory that configures its MCP servers. This includes both the user-configured MCP servers (jira, github, etc.) AND the orchestrator's own `workflow_control` MCP server.

```json
{
  "mcpServers": {
    "workflow_control": {
      "command": "node",
      "args": ["/path/to/orchestrator/workflow-control-mcp.js"],
      "env": {
        "PIPELINE_INSTANCE_ID": "inst_abc123",
        "STAGE_ID": "deep-dive",
        "ORCHESTRATOR_PORT": "3001"
      }
    },
    "jira": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-jira"],
      "env": { "JIRA_URL": "...", "JIRA_TOKEN": "..." }
    }
  }
}
```

#### Workflow control MCP server (`src/mcp/workflow-control-server.ts`)

A small MCP server that the orchestrator runs. It's added to every agent's MCP config automatically. It communicates back to the orchestrator via HTTP (localhost).

Tools it exposes:
- `workflow_complete(output: object)` — Validates output against schema, then calls the orchestrator API to advance the pipeline.
- `workflow_status(status: string, message: string)` — Reports progress to the orchestrator.
- `workflow_get_context()` — Fetches the accumulated context from the orchestrator.
- `workflow_request_input(prompt: string)` — Pauses the pipeline and requests human input.

Implementation: This is a standard MCP server using `@modelcontextprotocol/sdk`. It makes HTTP calls to the orchestrator's internal API at `localhost:${ORCHESTRATOR_PORT}`.

---

### Workstream 2: Pipeline author UI

**Goal**: A split-pane interface with an AI chat on the left and a live React Flow canvas on the right. The AI builds pipelines by manipulating a JSON document; the canvas renders it in real time.

#### React Flow custom node types

Define 4 custom React components registered as React Flow node types:

**TriggerNode** — Entry point of the pipeline.
- Displays: provider icon, event type, filter summary
- Config panel: provider dropdown, event type dropdown, filter builder
- Color: teal

**AgentStageNode** — An agent execution step.
- Displays: agent name, MCP server badges, model name, status indicator
- Config panel: model selector, system prompt editor, MCP server list (add/remove/configure), skill file paths, tool approval policy, output schema editor (JSON schema), context template editor, timeout
- Color: blue
- Runtime overlay: status badge (running/complete/failed), "jump in" button, token count, duration

**GateNode** — Approval/decision point.
- Displays: gate type (manual/conditional/auto), condition expression (if conditional)
- Config panel: type selector, condition editor, timeout config
- Shape: pill/rounded (distinct from rectangular agent nodes)
- Color: amber
- Runtime overlay: approve/reject buttons (for manual gates), condition result

**WatcherNode** — Event listener attached to a stage.
- Displays: provider, event type
- Config panel: provider dropdown, event type, filter, injection template
- Renders as a small satellite node connected to its parent stage with a dashed edge
- Color: coral

#### Canvas behavior

- **Author mode**: Nodes are draggable. Edges can be created by dragging from handle to handle. Clicking a node opens its config panel (slide-out from the right). The canvas supports undo/redo.
- **Auto-layout**: When the AI adds nodes, elkjs computes positions automatically (including for graphs with cycles). User can manually adjust after.
- **Serialization**: The React Flow state (nodes + edges) serializes to/from the `WorkflowDefinition` JSON format. React Flow positions are stored but optional — elkjs recalculates if absent.
- **Cycle visualization**: Back-edges (edges that form cycles) are rendered with a distinct curved path so the user can visually distinguish forward flow from feedback loops. Edge labels (e.g., "Approved", "Needs revision") display on the edge.

#### AI authoring integration

The left panel is a chat interface powered by kiro-cli ACP (using the `workflow-author` agent from `.kiro/agents/workflow-author.json`). The system prompt gives the AI:

1. The pipeline definition JSON schema
2. The list of available event providers and their event types
3. The list of available MCP servers
4. The current pipeline state (updated after every canvas change)

The AI has ONE tool:

```typescript
const updatePipelineTool = {
  name: "update_pipeline",
  description: "Add, remove, or modify nodes and edges in the pipeline definition. The canvas will re-render automatically after each call.",
  input_schema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                op: { const: "add_stage" },
                stage: { $ref: "#/definitions/StageDefinition" }
              }
            },
            {
              type: "object", 
              properties: {
                op: { const: "remove_stage" },
                stage_id: { type: "string" }
              }
            },
            {
              type: "object",
              properties: {
                op: { const: "update_stage" },
                stage_id: { type: "string" },
                changes: { type: "object" }  // partial StageDefinition
              }
            },
            {
              type: "object",
              properties: {
                op: { const: "add_edge" },
                edge: { $ref: "#/definitions/EdgeDefinition" }
              }
            },
            {
              type: "object",
              properties: {
                op: { const: "remove_edge" },
                edge_id: { type: "string" }
              }
            },
            {
              type: "object",
              properties: {
                op: { const: "set_trigger" },
                trigger: { type: "object" }
              }
            },
            {
              type: "object",
              properties: {
                op: { const: "set_metadata" },
                name: { type: "string" },
                description: { type: "string" }
              }
            }
          ]
        }
      }
    }
  }
};
```

**Bidirectional sync**: When the user manually edits the canvas (drags a node, changes config in a panel, deletes a node), the pipeline JSON is updated and the AI's next request includes the latest state. The AI and the human both edit the same document.

**AI system prompt** (draft):

```
You are a pipeline architect. You help users build automation 
pipelines by creating and modifying pipeline definitions.

You can see the current pipeline state below. When the user 
describes what they want, call the update_pipeline tool with 
the necessary operations. The visual canvas updates automatically.

Be proactive:
- Suggest appropriate MCP servers for each agent stage
- Set reasonable output schemas so data flows cleanly between stages
- Use conditional edges for routing decisions (e.g., reviewer approves
  vs requests revision). The agent's workflow_complete output drives
  the routing — include a "decision" field in the output schema.
- Create iterative cycles when natural (code-gen → review → revise).
  Always set max_iterations on stages that can cycle (default: 5).
  Write context_templates that give the agent its prior output and
  the feedback from the stage that sent it back.
- Add gates where human oversight is valuable
- Suggest watchers when an agent might need to react to external events
- Write clear system prompts for each agent that reference the 
  context they'll receive from prior stages
- Add descriptive labels to conditional edges so the graph is readable

Available event providers:
{{ list of registered providers and their event types }}

Available MCP servers:
{{ list of registered MCP servers with descriptions }}

Current pipeline definition:
{{ current_pipeline_json }}
```

---

### Workstream 3: Pipeline engine

**Goal**: Execute pipeline instances — advance through stages, manage gates, handle events, track state.

#### Workflow engine (implemented via Restate, not the hand-rolled engine below)

> **Note:** The spec below described a hand-rolled `PipelineEngine` state machine. The actual implementation uses **Restate** for durable workflow execution (`src/restate/pipeline-workflow.ts`). The core logic (stage execution, edge routing, cycle detection, gate promises) is the same, but Restate provides `ctx.run` for durable side effects, `ctx.promise` for gate suspension, and crash recovery for free. The `PipelineEngine` class was never built — Restate replaced it.

```typescript
// Original spec (for reference — actual impl is in src/restate/pipeline-workflow.ts)
class PipelineEngine extends EventEmitter {
  constructor(
    private db: Database,
    private acpPool: ACPProcessPool,
    private eventBus: EventBus
  ) {}

  async spawnInstance(definition: WorkflowDefinition, triggerEvent: Event): Promise<WorkflowInstance>
  // Creates a new pipeline instance in the database.
  // Initializes the context with the trigger event payload.
  // Initializes all stage entries with run_count: 0, runs: [].
  // Starts executing the first stage.

  async executeStage(instanceId: string, stageId: string): Promise<void>
  // For agent stages:
  //   1. Check cycle safety: if run_count >= max_iterations, fail the instance.
  //   2. Increment run_count, create a new StageRun entry with the current iteration.
  //   3. Resolve the context template — inject prior stage outputs (including prior
  //      iterations of THIS stage if it's a cycle) into the prompt.
  //      The agent receives:
  //        - Its own prior output (if cycling): "This is iteration N. Your previous output was: ..."
  //        - The reviewing stage's feedback (if cycling back from a reviewer):
  //          "The reviewer sent this back with notes: ..."
  //        - The full context for anything else it needs.
  //   4. Write the .kiro/settings.json with MCP servers (including workflow_control).
  //   5. Spawn a kiro-cli ACP process via the pool.
  //   6. Send the initial prompt with system message + context.
  //   7. Register any watchers for this stage.
  //   8. Listen for the workflow_complete callback from the workflow_control MCP server.
  //   9. When complete: validate output, store in context, route via edges.
  //
  // For gate stages:
  //   1. Evaluate the condition (if conditional gate).
  //   2. If manual: emit a "waiting_gate" event for the UI.
  //   3. Wait for approval signal (from UI) or timeout.

  async approveGate(instanceId: string, stageId: string): Promise<void>
  // Human clicked approve in the UI. Advance past the gate.

  async rejectGate(instanceId: string, stageId: string, reason?: string): Promise<void>
  // Human clicked reject. Fail the instance or route to a fallback edge.

  async injectHumanMessage(instanceId: string, stageId: string, message: string): Promise<void>
  // Human typed a message while "jumped in" to an agent session.
  // Forwards to the ACP process pool.

  async handleWatcherEvent(instanceId: string, watcherId: string, event: Event): Promise<void>
  // A watcher detected an event (e.g., new PR comment).
  // Formats the event using the injection template.
  // Injects it into the running agent's ACP session.

  async handleWorkflowComplete(instanceId: string, stageId: string, output: any): Promise<void>
  // Called by the workflow_control MCP server when an agent calls workflow_complete().
  // 1. Validates output against the stage's output_schema.
  //    If invalid: sends error message back into the agent's session for retry.
  // 2. If valid: stores output in context (appends to runs[], updates latest).
  // 3. Evaluates outgoing edges:
  //    - For each edge from this stage, evaluate edge.condition against { output, context }.
  //    - Collect all edges where condition is true (or condition is absent).
  //    - If no edges match: check if this stage has no outgoing edges (terminal node → complete pipeline).
  //      Otherwise: fail with routing error.
  //    - If edges match: execute all target stages (supports fan-out AND cycles).
  //      If a target is a stage that already ran, this is a cycle — executeStage handles the iteration check.
  // 4. If all terminal stages are complete, mark the pipeline instance as completed.

  private evaluateEdgeCondition(edge: EdgeDefinition, output: any, context: any): boolean
  // Evaluates the edge's JS condition expression in a sandboxed context.
  // The expression receives: `output` (the completing stage's output) and `context` (full pipeline context).
  // Returns true if the edge should be followed.
  // If edge.condition is undefined/null, returns true (unconditional edge).

  private isTerminalStage(definition: WorkflowDefinition, stageId: string): boolean
  // Returns true if the stage has no outgoing edges (it's a leaf node / exit point).

  // Query methods for the dashboard
  listInstances(filter?: { status?, definitionId? }): WorkflowInstance[]
  getInstance(id: string): WorkflowInstance
  getStageTranscript(instanceId: string, stageId: string, iteration?: number): ACPMessage[]
  // If iteration is omitted, returns the most recent run's transcript.
}
```

#### Event bus (`src/events/bus.ts`)

```typescript
class EventBus extends EventEmitter {
  private providers: Map<string, EventProvider> = new Map();
  private subscriptions: EventSubscription[] = [];

  registerProvider(provider: EventProvider): void
  // Adds a provider and starts it.
  // The provider calls bus.emit() when events occur.

  registerSubscription(sub: EventSubscription): void
  // Links an event pattern to a pipeline definition.
  // When a matching event fires, the engine spawns an instance.

  async emit(event: Event): Promise<void>
  // Routes the event:
  //   1. Check subscriptions — if matches a pipeline trigger, spawn an instance.
  //   2. Check active watchers — if matches a watcher on a running stage, inject.
}
```

#### Event provider interface (`src/events/provider.ts`)

```typescript
interface EventProvider {
  id: string;
  name: string;
  
  // List the event types this provider can emit
  getEventTypes(): EventTypeDescriptor[];

  // Start listening (webhooks, polling, etc.)
  start(emitCallback: (event: Event) => void): Promise<void>;

  // Stop listening
  stop(): Promise<void>;

  // Validate provider-specific config
  validateConfig(config: any): { valid: boolean; errors?: string[] };
}

// Built-in providers to implement for MVP:
// - ManualTriggerProvider (user clicks "run" in the UI)
// - WebhookProvider (generic HTTP endpoint that normalizes incoming payloads)
// - CronProvider (schedule-based)
//
// User can register custom providers by implementing this interface.
```

#### Custom event provider registration

Users need to be able to create custom event providers. For MVP, support two mechanisms:

1. **Webhook-based**: The orchestrator exposes a generic webhook endpoint at `/api/webhooks/:providerId`. The user creates a provider config that maps incoming JSON payloads to the Event format using a JSONPath or template expression. This covers Jira, GitHub, Slack, and most SaaS tools that support outgoing webhooks.

2. **Script-based**: The user provides a Node.js/TypeScript file that exports an EventProvider implementation. The orchestrator dynamically imports it. This handles polling-based sources, file watchers, database listeners, etc.

Provider config stored in the database:
```typescript
interface CustomProviderConfig {
  id: string;
  name: string;
  type: "webhook" | "script";
  
  // For webhook type:
  webhook?: {
    path: string;                    // URL path suffix
    secret?: string;                 // for HMAC verification
    event_type_field: string;        // JSONPath to extract event type from payload
    payload_transform?: string;      // optional JS expression to transform payload
  };
  
  // For script type:
  script?: {
    path: string;                    // path to the provider script
    config: Record<string, any>;     // passed to the provider's constructor
  };
}
```

---

## API surface

### REST API

```
# Pipeline definitions
GET    /api/pipelines                    — List all definitions
POST   /api/pipelines                    — Create a new definition
GET    /api/pipelines/:id                — Get a definition
PUT    /api/pipelines/:id                — Update a definition
DELETE /api/pipelines/:id                — Delete a definition
POST   /api/pipelines/:id/activate       — Activate (start listening for trigger events)
POST   /api/pipelines/:id/deactivate     — Deactivate

# Pipeline instances
GET    /api/instances                    — List instances (filterable by status, definition)
GET    /api/instances/:id                — Get instance with full state
POST   /api/instances/:id/cancel         — Cancel a running instance
POST   /api/instances/:id/retry/:stageId — Retry a failed stage

# Gates
POST   /api/instances/:id/gates/:stageId/approve
POST   /api/instances/:id/gates/:stageId/reject

# Human input
POST   /api/instances/:id/stages/:stageId/message  — Inject message into agent session

# Event providers
GET    /api/providers                    — List registered providers
POST   /api/providers                    — Register a custom provider
DELETE /api/providers/:id                — Remove a custom provider

# Webhooks (for event providers)
POST   /api/webhooks/:providerId         — Incoming webhook endpoint

# AI authoring
POST   /api/author/chat                  — Send message to AI author, returns pipeline updates

# MCP servers (registry of available servers)
GET    /api/mcp-servers                  — List available MCP server configs
POST   /api/mcp-servers                  — Register a new MCP server config
```

### WebSocket events

The frontend connects via WebSocket to receive real-time updates:

```
# Instance state changes
instance:created        { instanceId, definitionId, triggerEvent }
instance:stage_started  { instanceId, stageId, iteration }
instance:stage_completed { instanceId, stageId, iteration, output }
instance:stage_failed   { instanceId, stageId, iteration, error }
instance:stage_cycling  { instanceId, fromStageId, toStageId, iteration, reason }
instance:gate_waiting   { instanceId, stageId, message }
instance:completed      { instanceId }
instance:failed         { instanceId, error }

# Agent streaming (when user is viewing a stage)
agent:chunk             { instanceId, stageId, iteration, text }
agent:tool_call         { instanceId, stageId, iteration, tool, args }
agent:status            { instanceId, stageId, iteration, status, message }
agent:input_requested   { instanceId, stageId, iteration, prompt }

# Watcher events
watcher:fired           { instanceId, stageId, watcherId, event }
```

---

## Project structure

```
autome/
├── package.json
├── tsconfig.json
├── README.md
│
├── src/
│   ├── server.ts                    — Express + WebSocket server entry point
│   │
│   ├── acp/
│   │   ├── client.ts                — ACPClient class (JSON-RPC over stdio)
│   │   ├── pool.ts                  — ACPProcessPool (manages multiple agents)
│   │   └── types.ts                 — ACP protocol types
│   │
│   ├── mcp/
│   │   ├── workflow-control-server.ts  — MCP server for workflow_complete etc.
│   │   └── pipeline-author-server.ts   — MCP server for AI author (update_pipeline tool)
│   │
│   ├── schemas/
│   │   └── pipeline.ts              — Zod v4 schemas (single source of truth for types + validation + OpenAPI)
│   │
│   ├── nodes/
│   │   ├── registry.ts              — NodeTypeRegistry singleton (maps stage type → NodeTypeSpec)
│   │   ├── types.ts                 — NodeTypeSpec, StepExecutor, TriggerExecutor interfaces
│   │   └── builtin/                 — Built-in node types (agent, gate, triggers, http-request, transform, code-executor)
│   │
│   ├── engine/
│   │   ├── context-resolver.ts      — Template resolution + prompt building (Handlebars-style)
│   │   ├── edge-router.ts           — Evaluates edge conditions, detects cycles, enforces max_iterations
│   │   └── schema-validator.ts      — JSON Schema validation for stage outputs
│   │
│   ├── events/
│   │   ├── bus.ts                   — EventBus
│   │   ├── provider.ts              — EventProvider interface
│   │   └── providers/
│   │       ├── manual.ts            — ManualTriggerProvider
│   │       ├── webhook.ts           — WebhookProvider
│   │       └── cron.ts              — CronProvider
│   │
│   ├── author/
│   │   ├── service.ts               — AI authoring service (LLM calls + tool handling)
│   │   ├── system-prompt.ts         — System prompt template for the author AI
│   │   └── tools.ts                 — update_pipeline tool definition
│   │
│   ├── db/
│   │   ├── database.ts              — SQLite setup and migrations
│   │   └── migrations/
│   │       └── 001_initial.sql
│   │
│   ├── api/
│   │   ├── routes.ts                — REST API routes
│   │   └── websocket.ts             — WebSocket event broadcasting
│   │
│   ├── restate/
│   │   ├── pipeline-workflow.ts     — Restate workflow definition (durable execution)
│   │   ├── client.ts                — Restate client helpers
│   │   └── services.ts              — Restate service endpoint
│   │
│   ├── schemas/
│   │   └── pipeline.ts              — Zod schemas (single source of truth)
│   │
│   ├── nodes/
│   │   ├── registry.ts              — NodeTypeRegistry singleton
│   │   ├── types.ts                 — NodeTypeSpec interfaces
│   │   └── builtin/                 — Built-in node types
│   │
│   ├── agents/
│   │   └── discovery.ts             — Scans .kiro/agents/ for available agents
│   │
│   └── types/
│       ├── pipeline.ts              — WorkflowDefinition, StageDefinition, etc. (re-exports from schemas)
│       ├── instance.ts              — WorkflowInstance, StageRun, NodeTypeInfo, etc.
│       └── events.ts                — Event, EventProvider types
│
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   │
│   ├── src/
│   │   ├── App.tsx                  — Main app with routing
│   │   ├── main.tsx                 — Entry point
│   │   │
│   │   ├── components/
│   │   │   ├── canvas/
│   │   │   │   ├── PipelineCanvas.tsx      — React Flow wrapper
│   │   │   │   ├── nodes/
│   │   │   │   │   ├── TriggerNode.tsx
│   │   │   │   │   ├── AgentStageNode.tsx
│   │   │   │   │   ├── GateNode.tsx
│   │   │   │   │   └── WatcherNode.tsx
│   │   │   │   ├── edges/
│   │   │   │   │   ├── PipelineEdge.tsx    — custom edge with animation + condition label
│   │   │   │   │   └── CycleEdge.tsx       — curved back-edge for cycle paths (visually distinct)
│   │   │   │   └── ConfigPanel.tsx         — slide-out config editor (includes edge condition editor)
│   │   │   │
│   │   │   ├── author/
│   │   │   │   └── AuthorChat.tsx          — AI chat panel for pipeline building
│   │   │   │
│   │   │   ├── dashboard/
│   │   │   │   ├── InstanceList.tsx         — sidebar list of pipeline instances
│   │   │   │   ├── InstanceDetail.tsx       — detail view of a single instance
│   │   │   │   ├── StageTimeline.tsx        — timeline of stage executions (shows iterations)
│   │   │   │   └── IterationHistory.tsx     — expandable history of a stage's repeated runs
│   │   │   │
│   │   │   └── session/
│   │   │       └── AgentSessionViewer.tsx   — ACP session stream + input
│   │   │
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts             — WebSocket connection + events
│   │   │   ├── usePipeline.ts              — pipeline CRUD operations
│   │   │   └── useAgentSession.ts          — connect to a running agent's stream
│   │   │
│   │   ├── stores/
│   │   │   ├── pipelineStore.ts            — Zustand store for pipeline definitions
│   │   │   └── instanceStore.ts            — Zustand store for runtime state
│   │   │
│   │   └── lib/
│   │       ├── api.ts                      — REST API client
│   │       ├── layout.ts                   — elkjs auto-layout for React Flow (handles cycles)
│   │       └── types.ts                    — shared types
│   │
│   └── index.html
│
└── scripts/
    └── seed-providers.ts           — seed default event providers and MCP server configs
```

---

## Implementation order (MVP phases)

### Phase 1: Foundation (week 1)

Build the core plumbing that everything else depends on.

1. **Project setup** — monorepo with backend + frontend, TypeScript config, build tooling (vite for frontend, tsx for backend dev)
2. **Database schema** — SQLite tables for pipeline definitions, instances, provider configs, MCP server registry
3. **ACP client** — The `ACPClient` class that spawns `kiro-cli acp` and communicates via JSON-RPC. Test it standalone: spawn a process, create a session, send a prompt, receive streaming response.
4. **Workflow control MCP server** — The MCP server that exposes `workflow_complete`, `workflow_status`, `workflow_get_context`, `workflow_request_input`. Test it standalone with a manual kiro-cli session.
5. **Basic REST API** — CRUD for pipeline definitions, list/get for instances

**Milestone**: Can spawn a kiro-cli agent process, send it a prompt, and have it call `workflow_complete` with structured output.

### Phase 2: Pipeline engine (week 2)

Build the state machine that orchestrates pipeline execution.

1. **Pipeline engine** — The core `PipelineEngine` class. Given a pipeline definition and a trigger event, it: creates an instance, resolves the first stage, spawns the agent, handles `workflow_complete` callbacks, evaluates outgoing edge conditions, and routes to the next stage(s).
2. **Context accumulator** — Handles template resolution with iteration awareness: `{{ stages.deep-dive.latest }}` gets replaced with actual data. Tracks `run_count` and `runs[]` per stage for cycle support.
3. **Edge router** — Evaluates edge conditions against `{ output, context }`. Handles fan-out (multiple edges match) and cycles (target is a previously-executed stage). Enforces `max_iterations` safety limit.
4. **Gate handling** — Manual gates pause and wait for API call. Conditional gates evaluate JS expressions against context.
5. **Event bus + manual trigger** — The EventBus that routes events to pipeline triggers. Start with just ManualTriggerProvider so pipelines can be kicked off from the API.
6. **WebSocket broadcasting** — Real-time state change events pushed to connected clients, including cycle/iteration events.

**Milestone**: Can define a multi-stage pipeline with cycles (e.g., code-gen ↔ reviewer), trigger it manually, watch agents execute with iterative feedback loops and gates, and see the full execution with iteration history in the database.

### Phase 3: Frontend — Dashboard (week 3)

Build the observability layer first (it's useful even before the author UI).

1. **React Flow setup** — Install xyflow, register custom node types, set up the canvas component. Register a `CycleEdge` type for back-edges that renders with a distinct curved path and a condition label.
2. **Runtime mode canvas** — Render a pipeline instance's graph with live state overlaid. Nodes show status colors, active stage pulses. Nodes in a cycle show an iteration badge (e.g., "2/4" meaning iteration 2 of max 4).
3. **Instance list sidebar** — List all instances with status filters. Click to load into the canvas.
4. **Agent session viewer** — Click an agent node to open a panel showing the ACP session transcript. If the stage has run multiple times (cycle), show an iteration picker to view any run's transcript. If the agent is still running, stream chunks in real time. Include a text input to inject messages.
5. **Gate approval UI** — Approve/reject buttons rendered directly on gate nodes.
6. **Edge condition labels** — Display the label ("Approved", "Needs revision") on conditional edges. In runtime mode, highlight which edge was actually taken.

**Milestone**: Can watch a pipeline execute in real time in the browser, jump into agent sessions, approve gates, and review completed executions.

### Phase 4: Frontend — Author mode (week 4)

Build the pipeline authoring experience.

1. **Author mode canvas** — Drag-and-drop node creation, edge drawing, node config panels.
2. **Config panels** — Forms for each node type: agent config (model, MCP servers, system prompt, output schema), gate config, trigger config, watcher config.
3. **AI authoring chat** — Split-pane layout with chat on the left, canvas on the right. AI uses `update_pipeline` tool to modify the pipeline JSON. Canvas re-renders after each tool call.
4. **Bidirectional sync** — Manual canvas edits update the pipeline JSON that the AI sees on its next turn.
5. **Save/activate** — Save pipeline definitions, activate to start listening for trigger events.

**Milestone**: Can describe a pipeline in natural language, watch the AI build it on the canvas, make manual adjustments, and activate it.

### Phase 5: Event providers + watchers (week 5)

1. **Webhook provider** — Generic webhook endpoint with payload mapping.
2. **Cron provider** — Schedule-based triggers.
3. **Custom provider registration** — API to register webhook-based or script-based custom providers.
4. **Watcher implementation** — Attach watchers to running stages, inject events into ACP sessions.

**Milestone**: Can trigger pipelines from external webhooks (Jira, GitHub), and have watchers react to events on running stages.

---

## Key design decisions and rationale

### Why kiro-cli ACP (not direct Anthropic API calls)?

kiro-cli provides MCP server management, tool approval, session persistence, and the full agent loop (tool calls → results → more thinking) out of the box. Building this from raw API calls would require reimplementing all of that. ACP also means the agent has access to filesystem and terminal tools, which is essential for the implementer agent.

### Why a workflow_control MCP server (not parsing agent output)?

Parsing natural language output to extract structured data is fragile. By giving the agent an explicit `workflow_complete` tool, the agent *decides* when it's done and *structures* its output intentionally. The schema validation ensures data contracts between stages are honored. This is the same pattern used by function calling — you don't parse the response, you let the model call a function.

### Why SQLite (not Postgres)?

This is a local-first tool. Zero setup, single file, ships with the app. If it needs to scale later, the schema is simple enough to migrate to Postgres.

### Why React Flow (not building canvas from scratch)?

React Flow handles: node rendering, edge drawing, drag-and-drop, zoom/pan, minimap, connection validation, selection, undo/redo helpers, keyboard shortcuts, and touch support. Building any of this from scratch would consume the entire MVP timeline.

### Why separate MCP server process (not in-process tools)?

The `workflow_control` MCP server needs to be a separate process because kiro-cli manages MCP servers as child processes. The orchestrator can't inject tools into kiro-cli's process — it can only configure MCP servers that kiro-cli spawns. The workflow_control MCP server communicates back to the orchestrator via HTTP on localhost, which is simple and reliable.

### Why directed graph with cycles (not a DAG)?

Real agent workflows are inherently iterative. A code reviewer might reject code and send it back. A requirements analyst might need to go back to stakeholders. Forcing these into a DAG means either: (a) the user flattens the iteration into a single mega-agent that does generate-review-revise internally (losing visibility into each step), or (b) the user creates N copies of the same stage to simulate N iterations (ugly and rigid). Cycles let the graph express what's actually happening. The `max_iterations` safety valve prevents runaway loops, and the iteration-aware context gives each re-execution full history of prior attempts.

### Why conditional edges (not separate router nodes)?

The decision of "where to go next" is best expressed as conditions on the edges leaving a stage, not as a separate decision node. The completing agent's `workflow_complete` output is the natural place for routing data — `{ decision: "approved" }` vs `{ decision: "revise", notes: "..." }`. Edge conditions evaluate against this output directly. This keeps the graph clean: fewer nodes, and the routing logic is visible as labels on the edges in the UI.

---

## Open questions for implementation

1. **kiro-cli MCP server configuration**: Verify that kiro-cli reads `.kiro/settings.json` from the working directory (not just `~/.kiro/settings.json`). If not, we may need to use `--mcp-config` flag or environment variables.

2. **Session persistence across restarts**: If the orchestrator process restarts, running ACP sessions are lost. For MVP this is acceptable (mark running instances as failed), but eventually we need session recovery or checkpointing.

3. **Concurrent stages and cycles**: The engine supports fan-out (multiple stages executing in parallel) and cycles (a stage re-executing after receiving feedback from a downstream stage). The ACP pool needs to handle multiple concurrent kiro-cli processes. When a cycle triggers, the previous ACP process for that stage is terminated and a new one is spawned with updated context. Test how many concurrent agents a typical machine can support.

4. **Agent cost tracking**: kiro-cli sends `_kiro.dev/metadata` events with credit usage. The engine should capture these and store per-stage cost data for the dashboard.

5. **Working directory per stage**: Each agent stage should get its own working directory (temp dir or a subdirectory of the project). The implementer agent needs filesystem access scoped to the right place.

6. **Prompt size limits**: The context object can grow large across many stages and iterations. May need to summarize prior stage outputs rather than passing them raw. The `context_template` on each stage helps here — users can reference only the specific fields they need. For iterative cycles, consider only injecting the latest run's output plus a summary of prior iterations, rather than the full history.

7. **Cycle detection in author mode**: The UI should visually distinguish back-edges (edges that create cycles) from forward edges. When the user draws an edge that would create a cycle, show a confirmation and auto-suggest adding a `max_iterations` value to the target stage. The AI author should also set `max_iterations` when it creates cycles.

---

## Appendix: Example pipeline with cycles

This is the concrete definition for a Jira-to-merged pipeline with an iterative code-gen/review loop.

```json
{
  "id": "pipe_jira_to_merged",
  "name": "Jira ticket to merged PR",
  "description": "Deep dive → implement → review (iterative) → push",
  "active": true,

  "trigger": {
    "provider": "jira",
    "event": "issue.assigned",
    "filter": { "project": "PROJ", "assignee": "$me" }
  },

  "stages": [
    {
      "id": "deep-dive",
      "type": "agent",
      "agent": {
        "name": "Requirements analyst",
        "model": "claude-sonnet-4-20250514",
        "system_prompt": "You are a senior requirements analyst. Read the Jira ticket and all linked documents. Produce a structured requirements document with acceptance criteria. Call workflow_complete with your output when done.",
        "mcp_servers": [
          { "name": "jira", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-jira"] },
          { "name": "confluence", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-confluence"] }
        ],
        "tool_approval": "all_trusted",
        "context_template": "Jira ticket: {{ trigger.payload }}",
        "output_schema": {
          "type": "object",
          "properties": {
            "summary": { "type": "string" },
            "requirements": { "type": "array", "items": { "type": "string" } },
            "acceptance_criteria": { "type": "array", "items": { "type": "string" } },
            "files_to_modify": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["summary", "requirements", "acceptance_criteria"]
        },
        "max_turns": 50,
        "timeout_minutes": 30
      }
    },

    {
      "id": "gate-requirements",
      "type": "gate",
      "gate": {
        "type": "manual",
        "message": "Review the requirements before implementation begins.",
        "timeout_minutes": 1440,
        "timeout_action": "reject"
      }
    },

    {
      "id": "code-gen",
      "type": "agent",
      "agent": {
        "name": "Code generator",
        "model": "claude-sonnet-4-20250514",
        "system_prompt": "You are a senior software engineer. Implement the requirements provided in the context. If this is a revision (iteration > 1), pay close attention to the reviewer's feedback and address every point. Call workflow_complete with your output when done.",
        "mcp_servers": [
          { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
          { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }
        ],
        "tool_approval": "all_trusted",
        "context_template": "Requirements:\n{{ stages.deep-dive.latest }}\n\n{% if stages.code-reviewer.latest %}Reviewer feedback (address ALL points):\n{{ stages.code-reviewer.latest }}\n\nYour previous implementation:\n{{ stages.code-gen.latest }}{% endif %}\n\nThis is iteration {{ stages.code-gen.run_count + 1 }}.",
        "output_schema": {
          "type": "object",
          "properties": {
            "files_changed": { "type": "array", "items": {
              "type": "object",
              "properties": {
                "path": { "type": "string" },
                "action": { "type": "string", "enum": ["created", "modified", "deleted"] }
              }
            }},
            "summary": { "type": "string" },
            "tests_added": { "type": "boolean" }
          },
          "required": ["files_changed", "summary"]
        },
        "max_turns": 100,
        "max_iterations": 4,
        "timeout_minutes": 60
      }
    },

    {
      "id": "code-reviewer",
      "type": "agent",
      "agent": {
        "name": "Code reviewer",
        "model": "claude-sonnet-4-20250514",
        "system_prompt": "You are a senior code reviewer. Review the implementation against the requirements. Check for: correctness, edge cases, test coverage, code style, and security. You MUST call workflow_complete with decision='approved' or decision='revise'. If revising, provide specific, actionable feedback.",
        "mcp_servers": [
          { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
          { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }
        ],
        "tool_approval": "all_trusted",
        "context_template": "Requirements:\n{{ stages.deep-dive.latest }}\n\nImplementation:\n{{ stages.code-gen.latest }}\n\nThis is review iteration {{ stages.code-reviewer.run_count + 1 }}. {% if stages.code-reviewer.run_count > 0 %}Your prior review feedback was:\n{{ stages.code-reviewer.latest.notes }}\nCheck whether the developer addressed your points.{% endif %}",
        "output_schema": {
          "type": "object",
          "properties": {
            "decision": { "type": "string", "enum": ["approved", "revise"] },
            "notes": { "type": "string" },
            "issues": { "type": "array", "items": {
              "type": "object",
              "properties": {
                "severity": { "type": "string", "enum": ["critical", "major", "minor", "nit"] },
                "file": { "type": "string" },
                "description": { "type": "string" }
              }
            }}
          },
          "required": ["decision", "notes"]
        },
        "max_turns": 50,
        "max_iterations": 4,
        "timeout_minutes": 30
      }
    },

    {
      "id": "code-pusher",
      "type": "agent",
      "agent": {
        "name": "PR publisher",
        "model": "claude-sonnet-4-20250514",
        "system_prompt": "Create a pull request with the implemented changes. Write a clear PR description referencing the Jira ticket. Call workflow_complete when the PR is created.",
        "mcp_servers": [
          { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
        ],
        "tool_approval": "all_trusted",
        "context_template": "Jira ticket: {{ trigger.payload.key }}\nImplementation summary: {{ stages.code-gen.latest.summary }}\nReview: {{ stages.code-reviewer.latest.decision }}\nFiles changed: {{ stages.code-gen.latest.files_changed }}",
        "output_schema": {
          "type": "object",
          "properties": {
            "pr_url": { "type": "string" },
            "pr_number": { "type": "number" }
          },
          "required": ["pr_url", "pr_number"]
        },
        "max_turns": 20,
        "timeout_minutes": 10
      }
    }
  ],

  "edges": [
    { "id": "e1", "source": "deep-dive",        "target": "gate-requirements" },
    { "id": "e2", "source": "gate-requirements",  "target": "code-gen" },
    { "id": "e3", "source": "code-gen",           "target": "code-reviewer" },
    {
      "id": "e4-revise",
      "source": "code-reviewer",
      "target": "code-gen",
      "label": "Needs revision",
      "condition": "output.decision === 'revise'"
    },
    {
      "id": "e4-approved",
      "source": "code-reviewer",
      "target": "code-pusher",
      "label": "Approved",
      "condition": "output.decision === 'approved'"
    }
  ]
}
```

**How the cycle executes at runtime:**

```
Instance spawned by jira.issue.assigned

1. deep-dive agent runs
   → output: { requirements: [...], acceptance_criteria: [...] }
   → edge e1 (unconditional) → gate-requirements

2. gate-requirements waits for human approval
   → human clicks approve
   → edge e2 (unconditional) → code-gen

3. code-gen agent runs (iteration 1)
   → context includes: requirements from deep-dive
   → output: { files_changed: [...], summary: "Implemented feature X" }
   → edge e3 (unconditional) → code-reviewer

4. code-reviewer agent runs (iteration 1)
   → context includes: requirements + code-gen output
   → output: { decision: "revise", notes: "Missing error handling in auth.ts" }
   → edge e4-revise matches (decision === "revise") → back to code-gen
   → edge e4-approved does NOT match

5. code-gen agent runs (iteration 2, max_iterations=4 so OK)
   → context includes: requirements + its own prior output + reviewer feedback
   → system prompt reminds it: "This is iteration 2. Address the reviewer's points."
   → output: { files_changed: [...], summary: "Added error handling" }
   → edge e3 → code-reviewer

6. code-reviewer agent runs (iteration 2)
   → context includes: updated code + its own prior feedback
   → output: { decision: "approved", notes: "LGTM" }
   → edge e4-approved matches (decision === "approved") → code-pusher
   → edge e4-revise does NOT match

7. code-pusher agent runs
   → creates PR
   → output: { pr_url: "https://github.com/...", pr_number: 42 }
   → no outgoing edges → pipeline complete
```

The dashboard shows all 7 steps with the cycle clearly visible: code-gen shows "2 iterations", code-reviewer shows "2 iterations", and clicking either expands to show the transcript for each run.

---

## Getting started

Prerequisites:
- Node.js 20+
- kiro-cli installed and authenticated (`kiro-cli auth login`)
- An Anthropic API key (for the AI authoring feature)

```bash
# Clone and install
git clone <repo>
cd agent-pipeline-orchestrator
npm install

# Set environment
cp .env.example .env
# Edit .env with:
#   ANTHROPIC_API_KEY=sk-...
#   KIRO_CLI_PATH=/path/to/kiro-cli  (or just "kiro-cli" if on PATH)

# Start development
npm run dev     # starts backend on :3001 and frontend on :5173
```
