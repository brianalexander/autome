import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { formatDuration } from '../../lib/format';
import {
  ReactFlow,
  ConnectionMode,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  BackgroundVariant,
} from '@xyflow/react';
export interface WorkflowCanvasHandle {
  fitView: () => void;
  selectAll: () => void;
  deselectAll: () => void;
  relayout: () => void;
}
import '@xyflow/react/dist/style.css';
import { AgentStageNode } from './nodes/AgentStageNode';
import { GateNode } from './nodes/GateNode';
import { GenericStepNode } from './nodes/GenericStepNode';
import { WorkflowEdge } from './edges/WorkflowEdge';
import { CycleEdge } from './edges/CycleEdge';
import { ConnectionLine } from './ConnectionLine';
import { CanvasControls } from './CanvasControls';
import { layoutGraph } from '../../lib/layout';
import { useNodeTypes } from '../../hooks/queries';
import {
  isTriggerType,
  type WorkflowDefinition,
  type WorkflowInstance,
  type StageContext,
  type StageDefinition,
  type EdgeDefinition,
} from '../../lib/api';

const NODE_TYPE_MAP: Record<string, React.ComponentType<NodeProps>> = {
  agent: AgentStageNode,
  gate: GateNode,
  // All other node types (triggers + generic steps) use the generic renderer
  'manual-trigger': GenericStepNode,
  'webhook-trigger': GenericStepNode,
  'cron-trigger': GenericStepNode,
  'code-executor': GenericStepNode,
};

const edgeTypes = {
  workflow: WorkflowEdge,
  cycle: CycleEdge,
};

interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  instance?: WorkflowInstance | null;
  mode?: 'author' | 'runtime';
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  onStageClick?: (stageId: string | null) => void;
  onEdgeClick?: (edgeId: string | null) => void;
  onApproveGate?: (stageId: string) => void;
  onRejectGate?: (stageId: string) => void;
  onJumpIn?: (stageId: string) => void;
  // Editor controls (passed through to CanvasControls)
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  onShortcutsHelp?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  saveDisabled?: boolean;
  saveLabel?: string;
  /** Called once the ReactFlow instance is ready, with imperative canvas actions. */
  onCanvasReady?: (actions: WorkflowCanvasHandle) => void;
}

function buildNodes(
  definition: WorkflowDefinition,
  instance?: WorkflowInstance | null,
  callbacks?: {
    onApproveGate?: (stageId: string) => void;
    onRejectGate?: (stageId: string) => void;
    onJumpIn?: (stageId: string) => void;
    onDelete?: (id: string) => void;
    onEdit?: (id: string) => void;
  },
  nodeTypeSpecs?: import('../../lib/api').NodeTypeInfo[],
  isAuthor?: boolean,
  backEdgeIds?: Set<string>,
): Node[] {
  const nodes: Node[] = [];
  const specMap = new Map(nodeTypeSpecs?.map((s) => [s.id, s]) || []);

  // Compute which stages are targets of back-edges (cycle targets)
  if (!backEdgeIds) backEdgeIds = findBackEdgeIds(definition);
  const cycleTargetIds = new Set<string>();
  for (const edge of definition.edges) {
    if (backEdgeIds.has(edge.id)) {
      cycleTargetIds.add(edge.target);
    }
  }

  // Stage nodes
  for (const stage of definition.stages) {
    const runtimeStage: StageContext | undefined = instance?.context?.stages?.[stage.id];

    const cfg = (stage.config || {}) as Record<string, any>;
    const spec = specMap.get(stage.type);

    if (stage.type === 'agent') {
      const latestRun = runtimeStage?.runs?.[runtimeStage.runs.length - 1];
      const outputSummary = runtimeStage?.latest
        ? summarizeOutput(runtimeStage.latest)
        : undefined;
      const error = latestRun?.status === 'failed' ? latestRun.error : undefined;
      const duration =
        latestRun?.started_at && latestRun?.completed_at
          ? formatDuration(latestRun.started_at, latestRun.completed_at)
          : undefined;
      const startedAt = latestRun?.status === 'running' ? latestRun.started_at : undefined;

      const isInCycle = cycleTargetIds.has(stage.id);
      nodes.push({
        id: stage.id,
        type: 'agent',
        position: stage.position || { x: 0, y: 0 },
        data: {
          label: stage.label || stage.id,
          stageId: stage.id,
          hasReadme: !!stage.readme,
          agentId: cfg.agentId || 'unset',
          model: cfg.overrides?.model || undefined,
          status: runtimeStage?.status,
          runCount: runtimeStage?.run_count,
          maxIterations: cfg.max_iterations,
          onJumpIn: callbacks?.onJumpIn ? () => callbacks.onJumpIn!(stage.id) : undefined,
          outputSummary,
          error,
          duration,
          startedAt,
          isInCycle,
          cycleBehavior: isInCycle ? ((cfg.cycle_behavior as string) || 'fresh') : undefined,
          isAuthor,
          onDelete: callbacks?.onDelete,
          onEdit: callbacks?.onEdit,
        },
      });
    } else if (stage.type === 'gate') {
      const gateLatestRun = runtimeStage?.runs?.[runtimeStage.runs.length - 1];
      const gateDuration =
        gateLatestRun?.started_at && gateLatestRun?.completed_at
          ? formatDuration(gateLatestRun.started_at, gateLatestRun.completed_at)
          : undefined;

      nodes.push({
        id: stage.id,
        type: 'gate',
        position: stage.position || { x: 0, y: 0 },
        data: {
          label: stage.label || stage.id,
          gateType: cfg.type || 'manual',
          condition: cfg.condition,
          message: cfg.message,
          status: runtimeStage?.status,
          approved: (runtimeStage?.latest as Record<string, unknown> | undefined)?.approved,
          duration: gateDuration,
          onApprove: callbacks?.onApproveGate ? () => callbacks.onApproveGate!(stage.id) : undefined,
          onReject: callbacks?.onRejectGate ? () => callbacks.onRejectGate!(stage.id) : undefined,
          isAuthor,
          onDelete: callbacks?.onDelete,
          onEdit: callbacks?.onEdit,
        },
      });
    } else {
      // Generic step node (code-executor, triggers, custom nodes, etc.)
      const latestRun = runtimeStage?.runs?.[runtimeStage.runs.length - 1];
      const outputSummary = runtimeStage?.latest
        ? summarizeOutput(runtimeStage.latest)
        : undefined;
      const error = latestRun?.status === 'failed' ? latestRun.error : undefined;
      const duration =
        latestRun?.started_at && latestRun?.completed_at
          ? formatDuration(latestRun.started_at, latestRun.completed_at)
          : undefined;
      const startedAt = latestRun?.status === 'running' ? latestRun.started_at : undefined;

      nodes.push({
        id: stage.id,
        type: NODE_TYPE_MAP[stage.type] ? stage.type : 'code-executor',
        position: stage.position || { x: 0, y: 0 },
        data: {
          label: stage.label || stage.id,
          hasReadme: !!stage.readme,
          category: spec?.category,
          icon: spec?.icon,
          colorBg: spec?.color?.bg,
          colorBorder: spec?.color?.border,
          colorText: spec?.color?.text,
          status: runtimeStage?.status,
          outputSummary,
          error,
          duration,
          startedAt,
          isAuthor,
          onDelete: callbacks?.onDelete,
          onEdit: callbacks?.onEdit,
        },
      });
    }
  }

  return nodes;
}

/** Detect back-edges (cycle edges) via DFS. Returns set of edge IDs that form cycles. */
export function findBackEdgeIds(definition: WorkflowDefinition): Set<string> {
  const backEdgeIds = new Set<string>();
  const adjacency = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const edge of definition.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push({ target: edge.target, edgeId: edge.id });
  }
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function dfs(node: string) {
    visited.add(node);
    inStack.add(node);
    for (const { target, edgeId } of adjacency.get(node) || []) {
      if (inStack.has(target)) {
        backEdgeIds.add(edgeId);
      } else if (!visited.has(target)) {
        dfs(target);
      }
    }
    inStack.delete(node);
  }
  for (const stage of definition.stages) {
    if (!visited.has(stage.id)) dfs(stage.id);
  }
  return backEdgeIds;
}

function buildEdges(
  definition: WorkflowDefinition,
  instance?: WorkflowInstance | null,
  backEdgeIds?: Set<string>,
): Edge[] {
  const edges: Edge[] = [];
  if (!backEdgeIds) backEdgeIds = findBackEdgeIds(definition);

  // Workflow edges (including trigger edges — all edges are user-created)
  for (const edge of definition.edges) {
    const isBackEdge = backEdgeIds.has(edge.id);

    // Determine if this edge was "taken" in the current instance
    const stages = instance?.context?.stages;
    const sourceStage = stages?.[edge.source];
    const targetStage = stages?.[edge.target];

    // Source is "done" if it completed, OR if it's a trigger (triggers aren't in context.stages)
    const sourceDone = sourceStage?.status === 'completed'
      || (!sourceStage && !!instance); // trigger fired if instance exists

    // Target "started" if it's not pending anymore, OR if it's a map stage with iteration entries
    const targetStarted = (targetStage && targetStage.status !== 'pending')
      || (stages && Object.keys(stages).some(k => k.startsWith(`${edge.target}[`)));

    const taken = !!(sourceDone && targetStarted);

    // Edge animates only while its target is actively running (not after it completes)
    const targetRunning = targetStage?.status === 'running'
      || (stages && Object.keys(stages).some(k => k.startsWith(`${edge.target}[`) && stages[k]?.status === 'running'));

    // For cycle edges, include the target stage's cycle_behavior
    const cycleData: Record<string, unknown> = {};
    if (isBackEdge) {
      const targetStage = definition.stages.find((s) => s.id === edge.target);
      const targetConfig = (targetStage?.config || {}) as Record<string, unknown>;
      cycleData.cycleBehavior = (targetConfig.cycle_behavior as string) || 'fresh';
    }

    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: isBackEdge ? 'cycle' : 'workflow',
      animated: !!(sourceDone && targetStage?.status === 'running'),
      data: {
        label: edge.label,
        condition: edge.condition,
        trigger: edge.trigger,
        taken,
        targetRunning,
        ...cycleData,
      },
    });
  }

  return edges;
}

// --- Runtime data helpers ---

function summarizeOutput(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 100);
  if (!output || typeof output !== 'object') return String(output).slice(0, 100);
  const o = output as Record<string, unknown>;
  if (o.summary) return String(o.summary).slice(0, 100);
  if (o.decision) return `Decision: ${o.decision}`;
  if (o.message) return String(o.message).slice(0, 100);
  const keys = Object.keys(o);
  return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''}}`;
}

export function generateStageId(type: string, existingIds: string[], label?: string): string {
  const existing = new Set(existingIds);

  if (label) {
    // Slugify label to snake_case
    let base = label.toLowerCase().trim()
      .replace(/[^a-z0-9\s_]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (!base) base = type.replace(/-/g, '_');
    let candidate = base;
    let counter = 2;
    while (existing.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter++;
    }
    return candidate;
  }

  // Fallback: type-based with underscores
  const base = type.replace(/-/g, '_');
  let counter = 1;
  while (existing.has(`${base}_${counter}`)) {
    counter++;
  }
  return `${base}_${counter}`;
}

export function createDefaultStage(
  type: string,
  id: string,
  position: { x: number; y: number },
  nodeTypeSpecs?: import('../../lib/api').NodeTypeInfo[],
): StageDefinition {
  const spec = nodeTypeSpecs?.find((s) => s.id === type);
  const label =
    spec?.name ||
    type
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  return { id, type, position, label, config: spec?.defaultConfig || {} };
}

/** Inner component rendered inside <ReactFlow> that exposes imperative canvas actions. */
function CanvasActions({
  onReady,
  onRelayout,
}: {
  onReady?: (actions: WorkflowCanvasHandle) => void;
  onRelayout: () => void;
}) {
  const { fitView, setNodes, setEdges } = useReactFlow();
  useEffect(() => {
    if (!onReady) return;
    onReady({
      fitView: () => fitView({ padding: 0.3, maxZoom: 1.5 }),
      selectAll: () => setNodes((nds) => nds.map((n) => ({ ...n, selected: true }))),
      deselectAll: () => {
        setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
        setEdges((eds) => eds.map((e) => ({ ...e, selected: false })));
      },
      relayout: onRelayout,
    });
  }, [fitView, setNodes, setEdges, onReady, onRelayout]);
  return null;
}

export function WorkflowCanvas({
  definition,
  instance,
  mode = 'runtime',
  onDefinitionChange,
  onStageClick,
  onEdgeClick,
  onApproveGate,
  onRejectGate,
  onJumpIn,
  onUndo,
  onRedo,
  onSave,
  onShortcutsHelp,
  canUndo,
  canRedo,
  saveDisabled,
  saveLabel,
  onCanvasReady,
}: WorkflowCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { data: nodeTypeSpecs } = useNodeTypes();

  // True after the first elkjs layout has been applied. Never reset automatically
  // so that drag positions are not overwritten when the definition changes.
  const initialLayoutDoneRef = useRef(false);

  const isAuthor = mode === 'author';

  // Author-mode node toolbar callbacks
  const onNodeDelete = useCallback(
    (id: string) => {
      if (!onDefinitionChange) return;
      onDefinitionChange({
        ...definition,
        stages: definition.stages.filter((s) => s.id !== id),
        edges: definition.edges.filter((e) => e.source !== id && e.target !== id),
      });
      onStageClick?.(null);
    },
    [definition, onDefinitionChange, onStageClick],
  );

  const onNodeEdit = useCallback(
    (id: string) => {
      onStageClick?.(id);
    },
    [onStageClick],
  );

  // Memoised callbacks object — stable reference so the effect dep list is clean
  const callbacks = useMemo(
    () => ({ onApproveGate, onRejectGate, onJumpIn, onDelete: onNodeDelete, onEdit: onNodeEdit }),
    [onApproveGate, onRejectGate, onJumpIn, onNodeDelete, onNodeEdit],
  );

  // Build and layout nodes/edges. On the first render we run elkjs; on
  // subsequent updates we preserve existing positions so drags are not undone.
  const layoutPendingRef = useRef(false);
  useEffect(() => {
    if (!nodeTypeSpecs) return; // Wait for node type specs before rendering
    const backEdgeIds = findBackEdgeIds(definition);
    const newNodes = buildNodes(definition, instance, callbacks, nodeTypeSpecs, isAuthor, backEdgeIds);
    const newEdges = buildEdges(definition, instance, backEdgeIds);

    // Always update edges immediately so they never go stale
    setEdges(newEdges);

    if (!initialLayoutDoneRef.current) {
      // Initial load — check if all stages already have saved positions.
      // If so, use them directly; otherwise run elkjs for unpositioned stages.
      const allHavePositions = definition.stages.length > 0 &&
        definition.stages.every((s) => s.position != null);

      if (allHavePositions) {
        // All positions are saved — use them directly, skip elkjs
        setNodes(newNodes);
        initialLayoutDoneRef.current = true;
      } else if (!layoutPendingRef.current) {
        layoutPendingRef.current = true;
        layoutGraph(newNodes, newEdges).then((layoutedNodes) => {
          // For stages that already have saved positions, keep them instead of elkjs output
          const finalNodes = layoutedNodes.map((ln) => {
            const stage = definition.stages.find((s) => s.id === ln.id);
            if (stage?.position != null) {
              return { ...ln, position: stage.position };
            }
            return ln;
          });
          setNodes(finalNodes);
          initialLayoutDoneRef.current = true;
          layoutPendingRef.current = false;

          // Persist computed positions back to the definition for stages that lacked them.
          if (mode === 'author' && onDefinitionChange) {
            const posMap = new Map(finalNodes.map((n) => [n.id, n.position]));
            const needsUpdate = definition.stages.some((s) => !s.position && posMap.has(s.id));
            if (needsUpdate) {
              onDefinitionChange({
                ...definition,
                stages: definition.stages.map((s) =>
                  s.position ? s : { ...s, position: posMap.get(s.id) || s.position }
                ),
              });
            }
          }
        });
      }
    } else {
      // Subsequent updates (definition edits, instance status changes) —
      // update node data/styles but keep the positions the user set by dragging.
      setNodes((currentNodes) => {
        const positionMap = new Map(currentNodes.map((n) => [n.id, n.position]));
        return newNodes.map((n) => ({
          ...n,
          position: positionMap.get(n.id) ?? n.position,
        }));
      });
    }
  }, [definition, instance, callbacks, nodeTypeSpecs, setNodes, setEdges]);

  // Expose a manual re-layout trigger (used by the toolbar Re-layout button).
  // Writes new positions to both React Flow state AND the workflow definition.
  const onRelayout = useCallback(() => {
    setNodes((currentNodes) => {
      const currentEdges = edges;
      layoutGraph(currentNodes, currentEdges).then((layoutedNodes) => {
        setNodes(layoutedNodes);
        // Persist relayout positions to the definition so they can be saved
        if (onDefinitionChange) {
          const posMap = new Map(layoutedNodes.map((n) => [n.id, n.position]));
          onDefinitionChange({
            ...definition,
            stages: definition.stages.map((s) => ({
              ...s,
              position: posMap.get(s.id) || s.position,
            })),
          });
        }
      });
      return currentNodes;
    });
  }, [edges, setNodes, definition, onDefinitionChange]);

  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      // Shift+Click = multi-select — let React Flow handle it, don't open config panel
      if (event.shiftKey) return;
      if (onStageClick) {
        onStageClick(node.id);
      }
    },
    [onStageClick],
  );

  const handleEdgeClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (event.shiftKey) return;
      onEdgeClick?.(edge.id);
    },
    [onEdgeClick],
  );

  // Author mode: clicking the pane deselects the stage and edge
  const onPaneClick = useCallback(() => {
    if (mode === 'author') {
      onStageClick?.(null);
      onEdgeClick?.(null);
    }
  }, [mode, onStageClick, onEdgeClick]);

  // Author mode: connect two nodes with a new edge
  const onConnect = useCallback(
    (connection: Connection) => {
      if (mode !== 'author' || !onDefinitionChange) return;
      if (!connection.source || !connection.target) return;

      // Don't allow edges INTO trigger nodes (triggers are source-only)
      const targetStage = definition.stages.find((s) => s.id === connection.target);
      if (targetStage && isTriggerType(targetStage.type)) return;

      const edgeId = `edge_${connection.source}_${connection.target}`;

      // Detect if this edge creates a cycle (for validation and UI purposes)
      const adj = new Map<string, string[]>();
      for (const e of definition.edges) {
        if (!adj.has(e.source)) adj.set(e.source, []);
        adj.get(e.source)!.push(e.target);
      }
      function canReach(from: string, to: string, visited = new Set<string>()): boolean {
        if (from === to) return true;
        if (visited.has(from)) return false;
        visited.add(from);
        for (const next of adj.get(from) || []) {
          if (canReach(next, to, visited)) return true;
        }
        return false;
      }
      const createsCycle = canReach(connection.target, connection.source);

      // Validate: block any_success targets from being cycle targets
      if (createsCycle) {
        const cycleTargetStage = definition.stages.find((s) => s.id === connection.target);
        if (cycleTargetStage?.trigger_rule === 'any_success') {
          // Could show a toast/notification here, but for now just block silently
          console.warn('Cannot create cycle to a stage with trigger_rule "any_success"');
          return;
        }
      }

      const newEdgeDef: EdgeDefinition = {
        id: edgeId,
        source: connection.source,
        target: connection.target,
      };

      // Guard against duplicate edges
      if (definition.edges.some((e) => e.id === edgeId)) return;

      setEdges((eds) => addEdge({ ...connection, id: edgeId, type: 'workflow', data: {} }, eds));
      onDefinitionChange({
        ...definition,
        edges: [...definition.edges, newEdgeDef],
      });
    },
    [mode, definition, onDefinitionChange, setEdges],
  );

  // Author mode: handle keyboard Delete / Backspace on selected edges
  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      if (mode !== 'author' || !onDefinitionChange) return;
      const deletedIds = new Set(deletedEdges.map((e) => e.id));
      onDefinitionChange({
        ...definition,
        edges: definition.edges.filter((e) => !deletedIds.has(e.id)),
      });
    },
    [mode, definition, onDefinitionChange],
  );

  // Author mode: handle keyboard Delete / Backspace on selected nodes
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      if (mode !== 'author' || !onDefinitionChange) return;
      const deletedIds = new Set(deletedNodes.map((n) => n.id));
      onDefinitionChange({
        ...definition,
        stages: definition.stages.filter((s) => !deletedIds.has(s.id)),
        edges: definition.edges.filter((e) => !deletedIds.has(e.source) && !deletedIds.has(e.target)),
      });
      // Deselect if the selected node was deleted
      if (onStageClick) {
        onStageClick(null);
      }
    },
    [mode, definition, onDefinitionChange, onStageClick],
  );

  // Author mode: track pre-drag position to avoid phantom history entries on click
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);

  const onNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    dragStartPos.current = { ...node.position };
  }, []);

  // Author mode: persist node positions after drag (only if position actually changed)
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (mode !== 'author' || !onDefinitionChange) return;
      // Skip if no actual movement (React Flow fires dragStop on click too)
      if (
        dragStartPos.current &&
        Math.abs(node.position.x - dragStartPos.current.x) < 1 &&
        Math.abs(node.position.y - dragStartPos.current.y) < 1
      ) {
        dragStartPos.current = null;
        return;
      }
      dragStartPos.current = null;
      onDefinitionChange({
        ...definition,
        stages: definition.stages.map((s) => (s.id === node.id ? { ...s, position: node.position } : s)),
      });
    },
    [mode, definition, onDefinitionChange],
  );

  // Author mode: add a new stage from the toolbar
  const onAddStage = useCallback(
    (type: string) => {
      if (!onDefinitionChange) return;
      const existingIds = definition.stages.map((s) => s.id);
      const spec = nodeTypeSpecs?.find((s) => s.id === type);
      const label = spec?.name || type.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const id = generateStageId(type, existingIds, label);
      const lowestY = nodes.length > 0 ? Math.max(...nodes.map((n) => n.position.y)) : 0;
      const position = { x: 200, y: lowestY + 150 };
      const newStage = createDefaultStage(type, id, position, nodeTypeSpecs);
      onDefinitionChange({
        ...definition,
        stages: [...definition.stages, newStage],
      });
    },
    [definition, nodes, nodeTypeSpecs, onDefinitionChange],
  );

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPE_MAP}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={onPaneClick}
        onConnect={isAuthor ? onConnect : undefined}
        onEdgesDelete={isAuthor ? onEdgesDelete : undefined}
        onNodesDelete={isAuthor ? onNodesDelete : undefined}
        onNodeDragStart={isAuthor ? onNodeDragStart : undefined}
        onNodeDragStop={isAuthor ? onNodeDragStop : undefined}
        nodesDraggable={isAuthor}
        nodesConnectable={isAuthor}
        elementsSelectable={isAuthor}
        multiSelectionKeyCode="Shift"
        deleteKeyCode={isAuthor ? ['Delete', 'Backspace'] : null}
        connectionMode={ConnectionMode.Strict}
        isValidConnection={(connection) => {
          // Only allow source→target (output→input), not same-type connections
          if (connection.sourceHandle === connection.targetHandle) return false;
          // Don't allow self-connections
          if (connection.source === connection.target) return false;
          return true;
        }}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1.5 }}
        defaultEdgeOptions={{
          type: 'workflow',
          animated: false,
          style: { strokeWidth: 1.5 },
        }}
        snapToGrid
        snapGrid={[20, 20]}
        connectionLineComponent={ConnectionLine}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={2} color="#9ca3af" style={{ opacity: 0.35 }} />
        <CanvasControls
          onUndo={onUndo}
          onRedo={onRedo}
          onSave={onSave}
          onRelayout={isAuthor ? onRelayout : undefined}
          onShortcutsHelp={onShortcutsHelp}
          canUndo={canUndo}
          canRedo={canRedo}
          saveDisabled={saveDisabled}
          saveLabel={saveLabel}
          isAuthor={isAuthor}
        />
        <CanvasActions onReady={onCanvasReady} onRelayout={onRelayout} />
        <MiniMap
          pannable
          zoomable
          style={{
            background: 'var(--color-surface-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
          }}
          maskColor="rgba(0,0,0,0.6)"
          nodeColor={(node) => {
            const status = (node.data as Record<string, unknown>)?.status as string | undefined;
            if (status === 'running') return 'var(--status-running)';
            if (status === 'completed') return 'var(--status-completed)';
            if (status === 'failed') return 'var(--status-failed)';
            if (status === 'skipped') return 'var(--status-skipped)';
            if (node.type === 'agent') return '#3b82f6';
            if (node.type === 'gate') return '#f59e0b';
            return '#64748b';
          }}
        />
      </ReactFlow>
    </div>
  );
}
