import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { Server as HttpServer } from 'http';

// ---------------------------------------------------------------------------
// Minimal HTTP capture server
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  body: any;
}

function startCaptureServer(): Promise<{ server: HttpServer; requests: CapturedRequest[]; port: number }> {
  const requests: CapturedRequest[] = [];

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body: any = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }

        requests.push({ method: req.method ?? '', url: req.url ?? '', body });

        // Route-specific responses
        if (req.url?.startsWith('/api/internal/workflow-context/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ trigger: { event: 'push' }, stages: { stage1: { output: 'done' } } }));
        } else if (req.url === '/api/internal/workflow-signal') {
          const status = body?.status;
          const message =
            status === 'completed'
              ? 'Stage completed successfully. Output has been recorded.'
              : status === 'failed'
                ? 'Stage marked as failed.'
                : status === 'in_progress'
                  ? 'Status updated.'
                  : status === 'waiting_input'
                    ? 'Input request broadcast. Waiting for human response.'
                    : 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected server address format'));
        return;
      }
      resolve({ server, requests, port: addr.port });
    });

    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// MCP client helpers
// ---------------------------------------------------------------------------

function createMcpClient(port: number): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/workflow-control-server.ts'],
    env: {
      ...process.env,
      WORKFLOW_INSTANCE_ID: 'test-instance',
      STAGE_ID: 'test-stage',
      ORCHESTRATOR_PORT: String(port),
    },
    cwd: process.cwd(),
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

  return { client, transport };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('workflow-control MCP server', () => {
  let httpServer: HttpServer;
  let requests: CapturedRequest[];
  let port: number;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ server: httpServer, requests, port } = await startCaptureServer());
    ({ client, transport } = createMcpClient(port));
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 15_000);

  // -------------------------------------------------------------------------

  it('list_tools returns 2 tools: workflow_signal and workflow_get_context', async () => {
    const tools = await client.listTools();

    expect(tools.tools).toHaveLength(2);
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['workflow_get_context', 'workflow_signal']);
  });

  it('workflow_signal schema requires status field', async () => {
    const tools = await client.listTools();
    const signal = tools.tools.find((t) => t.name === 'workflow_signal');
    expect(signal?.inputSchema.required).toContain('status');
    expect((signal?.inputSchema.properties?.status as any)?.enum).toEqual([
      'completed',
      'failed',
      'in_progress',
      'waiting_input',
    ]);
  });

  it('workflow_signal with status=completed POSTs to /api/internal/workflow-signal', async () => {
    const output = { summary: 'all tests passed', count: 42 };

    const result = await client.callTool({
      name: 'workflow_signal',
      arguments: { status: 'completed', output },
    });

    const captured = requests.find((r) => r.url === '/api/internal/workflow-signal' && r.body?.status === 'completed');
    expect(captured).toBeDefined();
    expect(captured!.body).toMatchObject({
      instanceId: 'test-instance',
      stageId: 'test-stage',
      status: 'completed',
      output,
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('completed successfully');
  });

  it('workflow_signal with status=failed POSTs error reason', async () => {
    const result = await client.callTool({
      name: 'workflow_signal',
      arguments: { status: 'failed', error: 'Missing config file' },
    });

    const captured = requests.find((r) => r.url === '/api/internal/workflow-signal' && r.body?.status === 'failed');
    expect(captured).toBeDefined();
    expect(captured!.body).toMatchObject({
      instanceId: 'test-instance',
      stageId: 'test-stage',
      status: 'failed',
      error: 'Missing config file',
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('failed');
  });

  it('workflow_signal with status=in_progress POSTs progress update', async () => {
    const result = await client.callTool({
      name: 'workflow_signal',
      arguments: { status: 'in_progress', message: 'Reviewing PR diff' },
    });

    const captured = requests.find(
      (r) => r.url === '/api/internal/workflow-signal' && r.body?.status === 'in_progress',
    );
    expect(captured).toBeDefined();
    expect(captured!.body).toMatchObject({
      instanceId: 'test-instance',
      stageId: 'test-stage',
      status: 'in_progress',
      message: 'Reviewing PR diff',
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Status updated');
  });

  it('workflow_signal with status=waiting_input POSTs prompt', async () => {
    const result = await client.callTool({
      name: 'workflow_signal',
      arguments: { status: 'waiting_input', prompt: 'Should I proceed?' },
    });

    const captured = requests.find(
      (r) => r.url === '/api/internal/workflow-signal' && r.body?.status === 'waiting_input',
    );
    expect(captured).toBeDefined();
    expect(captured!.body).toMatchObject({
      instanceId: 'test-instance',
      stageId: 'test-stage',
      status: 'waiting_input',
      prompt: 'Should I proceed?',
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Waiting for human response');
  });

  it('workflow_signal validates missing required fields', async () => {
    // completed without output
    const result = await client.callTool({
      name: 'workflow_signal',
      arguments: { status: 'completed' },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Validation error');
    expect(text).toContain('output');
  });

  it('workflow_signal validates extra fields', async () => {
    // completed with error field (not allowed)
    const result = await client.callTool({
      name: 'workflow_signal',
      arguments: { status: 'completed', output: {}, error: 'oops' },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Validation error');
    expect(text).toContain('Unexpected field');
  });

  it('workflow_signal validates invalid status', async () => {
    const result = await client.callTool({
      name: 'workflow_signal',
      arguments: { status: 'unknown_status' },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Validation error');
    expect(text).toContain('Invalid status');
  });

  it('workflow_get_context GETs /api/internal/workflow-context/:instanceId/:stageId', async () => {
    const result = await client.callTool({ name: 'workflow_get_context', arguments: {} });

    const captured = requests.find((r) => r.url === '/api/internal/workflow-context/test-instance/test-stage');
    expect(captured).toBeDefined();
    expect(captured!.method).toBe('GET');

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ trigger: { event: 'push' }, stages: { stage1: { output: 'done' } } });
  });
}, 60_000);
