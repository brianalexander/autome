/**
 * ACP Spy — spawns a Claude Code ACP session, sends a prompt that triggers
 * parallel sub-agents, and logs ALL raw JSON-RPC messages to a file.
 *
 * Usage: npx tsx scripts/acp-spy.ts
 * Output: /tmp/acp-spy.jsonl
 */
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';

const OUTPUT_FILE = '/tmp/acp-spy.jsonl';
const log = createWriteStream(OUTPUT_FILE, { flags: 'w' });

function logEvent(label: string, data: unknown) {
  const line = JSON.stringify({ ts: new Date().toISOString(), label, data });
  log.write(line + '\n');
  // Also print a compact summary to console
  const summary = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
  console.log(`[${label}] ${summary}`);
}

// Spawn Claude Code via the ACP adapter (same as our provider uses)
const proc = spawn('npx', ['-y', '@agentclientprotocol/claude-agent-acp@^0.24.2'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buffer = '';
let nextId = 1;
let sessionId: string | null = null;

function sendRequest(method: string, params: Record<string, unknown>) {
  const id = String(nextId++);
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  logEvent('SEND', { id, method, params });
  proc.stdin!.write(msg + '\n');
  return id;
}

function sendResponse(id: string, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  logEvent('SEND_RESPONSE', { id, result });
  proc.stdin!.write(msg + '\n');
}

// Parse incoming newline-delimited JSON-RPC
proc.stdout!.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);

      if (msg.id && msg.result !== undefined) {
        // Response to our request
        logEvent('RESPONSE', msg);

        // After initialize, create session
        if (msg.id === '1') {
          sessionId = 'will-be-set';
          sendRequest('session/new', {
            cwd: process.cwd(),
            mcpServers: [],
          });
        }

        // After session/new, send the prompt
        if (msg.id === '2' && msg.result?.sessionId) {
          sessionId = msg.result.sessionId;
          console.log(`\nSession created: ${sessionId}\n`);

          // Wait a moment for MCP init, then send prompt
          setTimeout(() => {
            sendRequest('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text: `I need you to do TWO things IN PARALLEL using the Agent tool (launch both agents at the same time, don't wait for one to finish):

Agent 1: Use a "researcher" agent to fetch https://example.com and summarize what's there
Agent 2: Use a "researcher" agent to fetch https://httpbin.org/json and summarize what's there

IMPORTANT: Launch BOTH agents simultaneously using parallel tool calls. Do not run them sequentially.` }],
            });
          }, 3000);
        }

        // After prompt completes
        if (msg.id === '3') {
          logEvent('PROMPT_COMPLETE', msg.result);
          console.log('\n=== Prompt complete! ===');
          console.log(`Output saved to ${OUTPUT_FILE}`);
          setTimeout(() => {
            log.end();
            proc.kill();
            process.exit(0);
          }, 1000);
        }
      } else if (msg.method) {
        // Notification or request from the server
        logEvent('NOTIFICATION', msg);

        // Auto-approve any permission requests
        if (msg.method === 'session/request_permission' && msg.id) {
          const options = (msg.params?.options as Array<{ kind: string; optionId: string }>) ?? [];
          const allow = options.find(o => o.kind === 'allow_always')
            || options.find(o => o.kind === 'allow_session')
            || options.find(o => o.kind === 'allow_once')
            || options[0];
          if (allow) {
            sendResponse(msg.id, { optionId: allow.optionId });
          }
        }
      } else if (msg.error) {
        logEvent('ERROR', msg);
      }
    } catch (e) {
      logEvent('PARSE_ERROR', { raw: line, error: String(e) });
    }
  }
});

proc.stderr!.on('data', (chunk: Buffer) => {
  const text = chunk.toString().trim();
  if (text) logEvent('STDERR', text);
});

proc.on('close', (code) => {
  logEvent('CLOSE', { code });
  log.end();
  console.log(`\nProcess exited with code ${code}`);
  console.log(`Full log: ${OUTPUT_FILE}`);
  process.exit(0);
});

// Start with initialize handshake
sendRequest('initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'acp-spy', version: '0.1.0' },
  clientCapabilities: { terminal: true },
});

// Timeout safety
setTimeout(() => {
  console.log('\n=== Timeout after 120s ===');
  log.end();
  proc.kill();
  process.exit(1);
}, 120000);
