import { connect } from '@restatedev/restate-sdk-clients';
import type { Ingress } from '@restatedev/restate-sdk-clients';
import { pipelineWorkflow } from './pipeline-workflow.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { Event } from '../types/events.js';
import { config } from '../config.js';

let restateClient: Ingress | null = null;

export function getRestateClient(ingressUrl?: string): Ingress {
  if (!restateClient) {
    restateClient = connect({
      url: ingressUrl || config.restate.ingressUrl,
    });
  }
  return restateClient;
}

export async function startWorkflow(instanceId: string, definition: WorkflowDefinition, triggerEvent: Event) {
  const client = getRestateClient();
  const handle = await client.workflowClient(pipelineWorkflow, instanceId).workflowSubmit({ definition, triggerEvent });
  return handle;
}

export async function approveGate(instanceId: string, stageId: string, data?: unknown) {
  const client = getRestateClient();
  return client.workflowClient(pipelineWorkflow, instanceId).approveGate({ stageId, data });
}

export async function rejectGate(instanceId: string, stageId: string, reason?: string) {
  const client = getRestateClient();
  return client.workflowClient(pipelineWorkflow, instanceId).rejectGate({ stageId, reason });
}

export async function injectMessage(instanceId: string, stageId: string, message: string) {
  const client = getRestateClient();
  return client.workflowClient(pipelineWorkflow, instanceId).injectMessage({ stageId, message });
}

export async function signalStageComplete(instanceId: string, stageId: string, output: unknown) {
  const client = getRestateClient();
  return client.workflowClient(pipelineWorkflow, instanceId).stageComplete({ stageId, output: output as Record<string, unknown> });
}

export async function signalStageFailed(instanceId: string, stageId: string, error: string) {
  const client = getRestateClient();
  return client.workflowClient(pipelineWorkflow, instanceId).stageFailed({ stageId, error });
}

export async function getWorkflowStatus(instanceId: string) {
  const client = getRestateClient();
  return client.workflowClient(pipelineWorkflow, instanceId).getStatus();
}

export async function cancelWorkflow(instanceId: string) {
  // Validate instanceId is a UUID to prevent SQL injection in the Restate admin query
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(instanceId)) {
    console.error(`[restate] Invalid instanceId format: ${instanceId}`);
    return { cancelled: false };
  }

  // Use the Restate admin API to cancel the invocation
  const adminUrl = config.restate.adminUrl;
  // Query for the invocation ID from the admin API
  const queryResp = await fetch(`${adminUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query: `SELECT id FROM sys_invocation WHERE target_service_name = 'pipeline' AND target_service_key = '${instanceId}' AND target_handler_name = 'run'`,
    }),
  });

  if (queryResp.ok) {
    const data = await queryResp.json().catch(() => null);
    if (data?.rows?.[0]?.id) {
      const invocationId = data.rows[0].id;
      await fetch(`${adminUrl}/invocations/${invocationId}`, {
        method: 'DELETE',
      });
      return { cancelled: true, invocationId };
    }
  }

  // Fallback: try direct delete (newer Restate versions)
  await fetch(`${adminUrl}/invocations`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service: 'pipeline',
      key: instanceId,
      handler: 'run',
    }),
  });
  return { cancelled: true };
}
