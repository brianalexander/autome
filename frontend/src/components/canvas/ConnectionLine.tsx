import type { ConnectionLineComponentProps } from '@xyflow/react';
import { getBezierPath } from '@xyflow/react';

export function ConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });

  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke="var(--handle-color-agent)"
        strokeWidth={2}
        strokeDasharray="6 3"
        className="animate-[dash_0.5s_linear_infinite]"
      />
      <circle
        cx={toX}
        cy={toY}
        r={4}
        fill="var(--handle-color-agent)"
        opacity={0.7}
      />
    </g>
  );
}
