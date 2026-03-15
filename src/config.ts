/**
 * Centralized configuration — all ports, URLs, and env-derived settings live here.
 * Import `config` instead of reading process.env / hardcoding values in each file.
 */
export const config: {
  port: number;
  orchestratorUrl: string;
  restate: { ingressUrl: string; adminUrl: string };
  /** ACP provider env-var fallback. undefined means "not configured via env". */
  acpProvider: string | undefined;
} = {
  port: parseInt(process.env.PORT || '3001', 10),
  orchestratorUrl: process.env.ORCHESTRATOR_URL || `http://localhost:${process.env.PORT || '3001'}`,
  restate: {
    ingressUrl: process.env.RESTATE_INGRESS_URL || 'http://localhost:8080',
    adminUrl: process.env.RESTATE_ADMIN_URL || 'http://localhost:9070',
  },
  acpProvider: process.env.ACP_PROVIDER || undefined,
};
