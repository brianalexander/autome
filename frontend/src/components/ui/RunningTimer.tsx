import { useElapsedSeconds } from '../../hooks/useElapsedSeconds';

/** Live elapsed timer — ticks every second while mounted */
export function RunningTimer({ startedAt, className }: { startedAt: string; className?: string }) {
  const elapsed = useElapsedSeconds(startedAt);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return (
    <span className={className ?? 'text-[11px] text-orange-300 font-mono tabular-nums'}>
      {m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`}
    </span>
  );
}
