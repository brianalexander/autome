export interface Event {
  id: string;
  provider: string;
  type: string;
  timestamp: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

export interface EventTypeDescriptor {
  type: string;
  description: string;
  payload_schema?: Record<string, unknown>;
}

export interface EventProvider {
  id: string;
  name: string;
  getEventTypes(): EventTypeDescriptor[];
  start(emitCallback: (event: Event) => void): Promise<void>;
  stop(): Promise<void>;
  validateConfig(config: unknown): { valid: boolean; errors?: string[] };
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  type: 'webhook' | 'script';

  webhook?: {
    path: string;
    secret?: string;
    event_type_field: string;
    payload_transform?: string;
  };

  script?: {
    path: string;
    config: Record<string, unknown>;
  };
}
