import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  const d = data as { label?: string; condition?: string; taken?: boolean; trigger?: string; targetRunning?: boolean } | undefined;
  const isError = d?.trigger === 'on_error';
  const isTaken = d?.taken;
  const isTargetRunning = d?.targetRunning;
  const hasCondition = !!d?.condition;

  let stroke = 'var(--edge-stroke)';
  if (selected) stroke = 'var(--edge-stroke-selected)';
  else if (isTaken) stroke = 'var(--edge-stroke-taken)';
  else if (isError) stroke = 'var(--edge-stroke-error)';

  const strokeWidth = selected ? 2.5 : 1.5;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke,
          strokeWidth,
          strokeDasharray: isError ? '6 3' : undefined,
          transition: 'stroke 0.3s ease, stroke-width 0.2s ease',
          cursor: 'pointer',
        }}
        markerEnd={markerEnd}
      />

      {/* Animated flow dot — only while the target stage is actively running */}
      {isTaken && isTargetRunning && (
        <circle r="3" fill="var(--edge-stroke-taken)" opacity="0.85">
          <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}

      {/* Label */}
      {d?.label && (
        <EdgeLabelRenderer>
          <div
            className="absolute text-[10px] font-medium px-2 py-0.5 rounded-full border pointer-events-auto cursor-pointer whitespace-nowrap hover:opacity-100 transition-opacity"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: 'var(--color-surface-secondary)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
            onClick={(e) => {
              e.stopPropagation();
              const edgePath = document.getElementById(id);
              if (edgePath) {
                edgePath.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }
            }}
          >
            {hasCondition && <span className="mr-1 text-amber-400">⚡</span>}
            {isError && <span className="mr-1 text-orange-400">⚠</span>}
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
