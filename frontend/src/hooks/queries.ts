import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { workflows, instances, agents, nodeTypes, acpProviders, settings, approvals } from '../lib/api';
import type { PaginatedResponse } from '../lib/api';
import type { WorkflowDefinition } from '../lib/api';
import { useUIStore } from '../stores/uiStore';

// Workflow queries
export function useWorkflows(params?: { limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ['workflows', params],
    queryFn: () => workflows.list(params),
  });
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: ['workflow', id],
    queryFn: () => workflows.get(id!),
    enabled: !!id,
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<WorkflowDefinition, 'id'>) => workflows.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workflows'] }),
    onError: (err: Error) => toast.error(`Failed to create workflow: ${err.message}`),
  });
}

export function useUpdateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<WorkflowDefinition> }) => workflows.update(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      queryClient.invalidateQueries({ queryKey: ['workflow', id] });
      toast.success('Workflow saved');
    },
    onError: (err: Error) => toast.error(`Failed to save workflow: ${err.message}`),
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workflows.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workflows'] }),
    onError: (err: Error) => toast.error(`Failed to delete workflow: ${err.message}`),
  });
}

export function useTriggerWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload?: unknown }) => workflows.trigger(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast.success('Workflow triggered');
    },
    onError: (err: Error) => toast.error(`Failed to trigger workflow: ${err.message}`),
  });
}

export function useActivateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workflows.activate(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      queryClient.invalidateQueries({ queryKey: ['workflow', id] });
      toast.success('Workflow activated');
    },
    onError: (err: Error) => toast.error(`Failed to activate: ${err.message}`),
  });
}

export function useDeactivateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workflows.deactivate(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      queryClient.invalidateQueries({ queryKey: ['workflow', id] });
      toast.success('Workflow deactivated');
    },
    onError: (err: Error) => toast.error(`Failed to deactivate: ${err.message}`),
  });
}

// Workflow version queries
export function useWorkflowVersions(workflowId: string | undefined) {
  return useQuery({
    queryKey: ['workflow-versions', workflowId],
    queryFn: () => workflows.versions(workflowId!),
    enabled: !!workflowId,
  });
}

export function useWorkflowHealth(workflowId: string) {
  return useQuery({
    queryKey: ['workflow-health', workflowId],
    queryFn: () => workflows.health(workflowId),
    enabled: !!workflowId,
    staleTime: 60_000, // Re-check every 60s at most
    refetchOnWindowFocus: true,
  });
}

export function useWorkflowVersion(workflowId: string, version: number | null) {
  return useQuery({
    queryKey: ['workflow-version', workflowId, version],
    queryFn: () => workflows.getVersion(workflowId, version!),
    enabled: !!workflowId && version != null,
  });
}

// Instance queries
export function useInstances(filter?: { status?: string; definitionId?: string; limit?: number; offset?: number }) {
  const wsConnected = useUIStore((s) => s.wsConnected);
  return useQuery({
    queryKey: ['instances', filter],
    queryFn: () => instances.list(filter),
    refetchInterval: wsConnected ? false : 5000, // Poll every 5s as fallback when WS is down
  });
}

export function useInstance(id: string) {
  const wsConnected = useUIStore((s) => s.wsConnected);
  return useQuery({
    queryKey: ['instance', id],
    queryFn: () => instances.get(id),
    enabled: !!id,
    refetchInterval: wsConnected ? false : 3000, // Poll every 3s as fallback when WS is down
  });
}

export function useInstanceStatus(id: string) {
  const wsConnected = useUIStore((s) => s.wsConnected);
  return useQuery({
    queryKey: ['instance', id, 'status'],
    queryFn: () => instances.getStatus(id),
    enabled: !!id,
    refetchInterval: wsConnected ? false : 2000, // Poll every 2s as fallback when WS is down
  });
}

export function useInstanceDefinition(instanceId: string) {
  return useQuery({
    queryKey: ['instance-definition', instanceId],
    queryFn: () => instances.getDefinition(instanceId),
    enabled: !!instanceId,
  });
}

export function useApproveGate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ instanceId, stageId, data }: { instanceId: string; stageId: string; data?: unknown }) =>
      instances.approveGate(instanceId, stageId, data),
    onSuccess: (_, { instanceId }) => {
      queryClient.invalidateQueries({ queryKey: ['instance', instanceId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      toast.success('Gate approved');
    },
    onError: (err: Error) => toast.error(`Failed to approve gate: ${err.message}`),
  });
}

export function useRejectGate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ instanceId, stageId, reason }: { instanceId: string; stageId: string; reason?: string }) =>
      instances.rejectGate(instanceId, stageId, reason),
    onSuccess: (_, { instanceId }) => {
      queryClient.invalidateQueries({ queryKey: ['instance', instanceId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast.success('Gate rejected');
    },
    onError: (err: Error) => toast.error(`Failed to reject gate: ${err.message}`),
  });
}

export function useCancelInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => instances.cancel(instanceId),
    onSuccess: (_, instanceId) => {
      queryClient.invalidateQueries({ queryKey: ['instance', instanceId] });
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast.success('Instance cancelled');
    },
    onError: (err: Error) => toast.error(`Failed to cancel instance: ${err.message}`),
  });
}

export function useDeleteInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => instances.delete(instanceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
    },
    onError: (err: Error) => toast.error(`Failed to delete instance: ${err.message}`),
  });
}

export function useInjectMessage() {
  return useMutation({
    mutationFn: ({ instanceId, stageId, message }: { instanceId: string; stageId: string; message: string }) =>
      instances.injectMessage(instanceId, stageId, message),
    onError: (err: Error) => toast.error(`Failed to send message: ${err.message}`),
  });
}

// Segments queries
export function useSegments(instanceId: string, stageId: string, iteration?: number) {
  return useQuery({
    queryKey: ['segments', instanceId, stageId, iteration],
    queryFn: () => instances.getSegments(instanceId, stageId, iteration),
    enabled: !!instanceId && !!stageId,
  });
}

export function useStagePrompt(instanceId: string, stageId: string, iteration?: number) {
  return useQuery({
    queryKey: ['stage-prompt', instanceId, stageId, iteration],
    queryFn: () => instances.getPrompt(instanceId, stageId, iteration),
    enabled: !!instanceId && !!stageId,
    retry: false,
  });
}

export function useCancelStage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ instanceId, stageId }: { instanceId: string; stageId: string }) =>
      instances.cancelStage(instanceId, stageId),
    onSuccess: (_, { instanceId }) => queryClient.invalidateQueries({ queryKey: ['instance', instanceId] }),
    onError: (err: Error) => toast.error(`Failed to cancel stage: ${err.message}`),
  });
}

// Agent discovery queries
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: agents.list,
    staleTime: 30000, // agents don't change often
  });
}

export function useAgent(name: string) {
  return useQuery({
    queryKey: ['agent', name],
    queryFn: () => agents.get(name),
    enabled: !!name,
  });
}

export function useNodeTypes() {
  return useQuery({
    queryKey: ['node-types'],
    queryFn: nodeTypes.list,
    staleTime: 60000, // node types rarely change at runtime
  });
}

export function useAcpProviders() {
  return useQuery({
    queryKey: ['acp-providers'],
    queryFn: acpProviders.list,
    staleTime: 60000, // providers don't change often
  });
}

export function useActiveProvider() {
  return useQuery({
    queryKey: ['active-provider'],
    queryFn: acpProviders.active,
    staleTime: 60000,
  });
}

export function useSetSystemProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      await settings.set('acpProvider', provider);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['active-provider'] });
      toast.success('Default provider updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useApprovals() {
  return useQuery({
    queryKey: ['approvals'],
    queryFn: () => approvals.list(),
    refetchInterval: 10000, // poll every 10s for pending approvals
  });
}
