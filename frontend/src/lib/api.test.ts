import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workflows, instances, isTriggerType } from './api';

// ---------------------------------------------------------------------------
// isTriggerType — pure function, no fetch needed
// ---------------------------------------------------------------------------
describe('isTriggerType', () => {
  it('returns true for the legacy "trigger" type', () => {
    expect(isTriggerType('trigger')).toBe(true);
  });

  it('returns true for types ending with "-trigger"', () => {
    expect(isTriggerType('manual-trigger')).toBe(true);
    expect(isTriggerType('webhook-trigger')).toBe(true);
    expect(isTriggerType('cron-trigger')).toBe(true);
  });

  it('returns false for non-trigger types', () => {
    expect(isTriggerType('llm-agent')).toBe(false);
    expect(isTriggerType('gate')).toBe(false);
    expect(isTriggerType('http-request')).toBe(false);
  });

  it('uses specs when provided — prefers spec category over name convention', () => {
    const specs = [
      { id: 'custom-node', category: 'trigger', label: 'Custom', description: '' },
      { id: 'llm-agent', category: 'action', label: 'LLM', description: '' },
    ] as any;
    expect(isTriggerType('custom-node', specs)).toBe(true);
    expect(isTriggerType('llm-agent', specs)).toBe(false);
  });

  it('falls back to convention when the type is not in specs', () => {
    const specs = [{ id: 'known-node', category: 'action', label: 'Known', description: '' }] as any;
    // 'webhook-trigger' is not in specs, should fall back to endsWith check
    expect(isTriggerType('webhook-trigger', specs)).toBe(true);
    expect(isTriggerType('unknown-node', specs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API client — fetch-based
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob([JSON.stringify(body)])),
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workflows.list', () => {
  it('calls GET /api/workflows and returns parsed response', async () => {
    const payload = { data: [], total: 0, limit: 50, offset: 0 };
    vi.stubGlobal('fetch', mockFetch(payload));

    const result = await workflows.list();

    expect(fetch).toHaveBeenCalledOnce();
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/workflows');
    expect(result).toEqual(payload);
  });

  it('appends query params when provided', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [], total: 0, limit: 10, offset: 5 }));

    await workflows.list({ limit: 10, offset: 5 });

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=5');
  });
});

describe('workflows.get', () => {
  it('calls GET /api/workflows/:id', async () => {
    const wf = { id: 'wf-1', name: 'Test', stages: [], edges: [] };
    vi.stubGlobal('fetch', mockFetch(wf));

    const result = await workflows.get('wf-1');

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/workflows/wf-1');
    expect(result).toEqual(wf);
  });
});

describe('workflows.create', () => {
  it('calls POST /api/workflows with JSON body', async () => {
    const wf = { id: 'wf-new', name: 'New', stages: [], edges: [] };
    vi.stubGlobal('fetch', mockFetch(wf));

    const data = { name: 'New', stages: [], edges: [], trigger: { provider: 'manual' }, active: false };
    const result = await workflows.create(data);

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/workflows');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(data);
    expect(result).toEqual(wf);
  });
});

describe('workflows.delete', () => {
  it('calls DELETE /api/workflows/:id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: () => Promise.resolve(null),
    }));

    await workflows.delete('wf-1');

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/workflows/wf-1');
    expect(init.method).toBe('DELETE');
  });
});

describe('error handling', () => {
  it('throws with the server error message on a non-200 response', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Not Found' }, 404));

    await expect(workflows.get('missing')).rejects.toThrow('Not Found');
  });

  it('falls back to statusText when error body cannot be parsed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.reject(new Error('bad json')),
    }));

    await expect(workflows.get('x')).rejects.toThrow('Internal Server Error');
  });
});

describe('instances.list', () => {
  it('calls GET /api/instances', async () => {
    const payload = { data: [], total: 0, limit: 50, offset: 0 };
    vi.stubGlobal('fetch', mockFetch(payload));

    const result = await instances.list();

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/instances');
    expect(result).toEqual(payload);
  });

  it('appends status filter when provided', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [], total: 0, limit: 50, offset: 0 }));

    await instances.list({ status: 'running' });

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('status=running');
  });

  it('appends definitionId filter when provided', async () => {
    vi.stubGlobal('fetch', mockFetch({ data: [], total: 0, limit: 50, offset: 0 }));

    await instances.list({ definitionId: 'wf-abc' });

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('definitionId=wf-abc');
  });
});
