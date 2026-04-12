/**
 * Smoke tests for the ui_action MCP tool in workflow-author-server.
 * Verifies each action type is accepted and that the tool POSTs to /api/internal/ui-action.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  body: Record<string, unknown> | null;
}

function startCaptureServer(): Promise<{ server: HttpServer; requests: CapturedRequest[]; port: number }> {
  const requests: CapturedRequest[] = [];

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body: Record<string, unknown> | null = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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
// MCP client
// ---------------------------------------------------------------------------

function createMcpClient(port: number): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/workflow-author-server.ts'],
    env: {
      ...process.env,
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

describe('workflow-author MCP — ui_action tool', () => {
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
    try { await client.close(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
  });

  it('calls /api/internal/ui-action for show_test_run', async () => {
    const result = await client.callTool({
      name: 'ui_action',
      arguments: {
        workflow_id: 'wf-test',
        action: 'show_test_run',
        instanceId: 'inst-123',
        testWorkflowId: 'test-wf-123',
      },
    });

    const req = requests.find((r) => r.url === '/api/internal/ui-action');
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
    expect(req!.body).toMatchObject({
      workflowId: 'wf-test',
      action: 'show_test_run',
      instanceId: 'inst-123',
      testWorkflowId: 'test-wf-123',
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
  }, 15_000);

  it('calls /api/internal/ui-action for navigate action', async () => {
    const result = await client.callTool({
      name: 'ui_action',
      arguments: {
        workflow_id: 'wf-test',
        action: 'navigate',
        to: '/workflows',
      },
    });

    const req = requests.find((r) => r.url === '/api/internal/ui-action');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ action: 'navigate', to: '/workflows' });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  }, 15_000);

  it('calls /api/internal/ui-action for highlight_element action', async () => {
    const result = await client.callTool({
      name: 'ui_action',
      arguments: {
        workflow_id: 'wf-test',
        action: 'highlight_element',
        elementId: 'stage-step1',
        pulseMs: 2000,
      },
    });

    const req = requests.find((r) => r.url === '/api/internal/ui-action');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ action: 'highlight_element', elementId: 'stage-step1' });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  }, 15_000);

  it('calls /api/internal/ui-action for toast action', async () => {
    const result = await client.callTool({
      name: 'ui_action',
      arguments: {
        workflow_id: 'wf-test',
        action: 'toast',
        level: 'info',
        text: 'Test complete!',
      },
    });

    const req = requests.find((r) => r.url === '/api/internal/ui-action');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ action: 'toast', level: 'info', text: 'Test complete!' });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  }, 15_000);

  it('returns error when workflow_id is missing', async () => {
    const result = await client.callTool({
      name: 'ui_action',
      arguments: {
        action: 'show_test_run',
        instanceId: 'inst-123',
      },
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('workflow_id');
  }, 15_000);
});
