/**
 * Shared status-to-color mappings used across instance view components.
 *
 * Tailwind class strings are kept whole (not interpolated) so the Tailwind
 * scanner can detect them during the build.
 */

/** Border + background classes for a status card (used by RunHistory). */
export function getStatusCardClasses(status: string): string {
  switch (status) {
    case 'completed':
      return 'border-green-300 dark:border-green-500/30 bg-status-success-muted';
    case 'failed':
      return 'border-red-300 dark:border-red-500/30 bg-status-error-muted';
    default:
      return 'border-blue-300 dark:border-blue-500/30 bg-status-info-muted';
  }
}

/** Border-only class for a stage data card (used by StageDataCard). */
export function getStageBorderClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'border-green-300 dark:border-green-800';
    case 'failed':
      return 'border-red-300 dark:border-red-500/30';
    case 'running':
      return 'border-blue-300 dark:border-blue-800';
    default:
      return 'border-border';
  }
}

/** Dot color classes for the execution timeline (used by OverviewSidebar). */
export function getTimelineDotClasses(status: string): { dot: string; line: string } {
  switch (status) {
    case 'completed':
      return {
        dot: 'border-green-500 bg-green-500',
        line: 'bg-green-300 dark:bg-green-800',
      };
    case 'failed':
      return {
        dot: 'border-red-500 bg-red-500',
        line: 'bg-red-300 dark:bg-red-800',
      };
    default:
      return {
        dot: 'border-blue-500 bg-blue-500',
        line: 'bg-blue-300 dark:bg-blue-800',
      };
  }
}
