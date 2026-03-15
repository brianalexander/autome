import { EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

export function CycleEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  style,
  selected,
}: EdgeProps) {
  const d = data as { label?: string; condition?: string; taken?: boolean; cycleBehavior?: string; targetRunning?: boolean; onEdgeClick?: (id: string) => void } | undefined;
  const isTaken = d?.taken;
  const isTargetRunning = d?.targetRunning;

  // Dynamic offset — routes to the LEFT of both nodes
  const OFFSET_MIN = 80;
  const OFFSET_MAX = 160;
  const CORNER_RADIUS = 20;
  const verticalDist = Math.abs(targetY - sourceY);
  const offset = Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, verticalDist * 0.3));
  const loopX = Math.min(sourceX, targetX) - offset;

  let path: string;
  let labelX: number;
  let labelY: number;

  if (sourceY >= targetY) {
    // Normal back-edge: source below target — exits down, loops left, goes up, enters target top
    const exitY = sourceY + CORNER_RADIUS;
    const enterY = targetY - CORNER_RADIUS;

    path = [
      `M ${sourceX} ${sourceY}`,
      `L ${sourceX} ${exitY}`,
      `Q ${sourceX} ${exitY + CORNER_RADIUS} ${sourceX - CORNER_RADIUS} ${exitY + CORNER_RADIUS}`,
      `L ${loopX + CORNER_RADIUS} ${exitY + CORNER_RADIUS}`,
      `Q ${loopX} ${exitY + CORNER_RADIUS} ${loopX} ${exitY}`,
      `L ${loopX} ${enterY}`,
      `Q ${loopX} ${enterY - CORNER_RADIUS} ${loopX + CORNER_RADIUS} ${enterY - CORNER_RADIUS}`,
      `L ${targetX - CORNER_RADIUS} ${enterY - CORNER_RADIUS}`,
      `Q ${targetX} ${enterY - CORNER_RADIUS} ${targetX} ${enterY}`,
      `L ${targetX} ${targetY}`,
    ].join(' ');

    labelX = loopX;
    labelY = (exitY + enterY) / 2;
  } else {
    // Unusual forward-cycle: source above target — route left and downward
    const exitY = sourceY - CORNER_RADIUS;
    const enterY = targetY + CORNER_RADIUS;

    path = [
      `M ${sourceX} ${sourceY}`,
      `L ${sourceX} ${exitY}`,
      `Q ${sourceX} ${exitY - CORNER_RADIUS} ${sourceX - CORNER_RADIUS} ${exitY - CORNER_RADIUS}`,
      `L ${loopX + CORNER_RADIUS} ${exitY - CORNER_RADIUS}`,
      `Q ${loopX} ${exitY - CORNER_RADIUS} ${loopX} ${exitY}`,
      `L ${loopX} ${enterY}`,
      `Q ${loopX} ${enterY + CORNER_RADIUS} ${loopX + CORNER_RADIUS} ${enterY + CORNER_RADIUS}`,
      `L ${targetX - CORNER_RADIUS} ${enterY + CORNER_RADIUS}`,
      `Q ${targetX} ${enterY + CORNER_RADIUS} ${targetX} ${enterY}`,
      `L ${targetX} ${targetY}`,
    ].join(' ');

    labelX = loopX;
    labelY = (exitY + enterY) / 2;
  }

  let stroke = 'var(--edge-stroke-cycle)';
  if (selected) stroke = 'var(--edge-stroke-selected)';
  else if (isTaken) stroke = 'var(--edge-stroke-taken)';

  const strokeWidth = selected ? 2.5 : 1.5;

  return (
    <>
      {/* Invisible wider path for click targeting (matches BaseEdge behavior) */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="react-flow__edge-interaction"
        style={{ cursor: 'pointer' }}
      />
      <path
        id={id}
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray="8 4"
        className="react-flow__edge-path cycle-edge-flow"
        style={{
          ...style,
          cursor: 'pointer',
          transition: 'stroke 0.2s, stroke-width 0.2s',
        }}
      />

      {/* Animated flow dot — only while workflow is still running */}
      {isTaken && isTargetRunning && (
        <circle r="3" fill="var(--edge-stroke-taken)" opacity="0.85">
          <animateMotion dur="2s" repeatCount="indefinite" path={path} />
        </circle>
      )}

      <EdgeLabelRenderer>
        <div
          className="absolute text-[10px] font-medium px-2 py-0.5 rounded-full border pointer-events-auto cursor-pointer whitespace-nowrap hover:opacity-100 transition-opacity"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: 'color-mix(in srgb, var(--color-surface-secondary) 95%, #f43f5e)',
            borderColor: 'var(--edge-stroke-cycle)',
            color: 'var(--edge-stroke-cycle)',
            opacity: 0.9,
          }}
          onClick={(e) => {
            e.stopPropagation();
            // Trigger edge selection by dispatching a click on the edge path
            const edgePath = document.getElementById(id);
            if (edgePath) {
              edgePath.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
          }}
        >
          ↻ {d?.cycleBehavior || 'fresh'}{d?.label ? ` · ${d.label}` : ''}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
