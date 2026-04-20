import type { ConfigCard } from '@autome/types/instance';
import type { StageDefinition, WorkflowDefinition } from '../../../lib/api';

export type { ConfigCard };

export interface CardRendererProps {
  card: ConfigCard;
  stage: StageDefinition;
  workflowId: string;
  apiOrigin: string;
  /** Full workflow definition — needed for graph-topology cards (e.g. cycle-behavior). */
  definition?: WorkflowDefinition;
  /**
   * Optional config update callback — used by cards that render editable fields
   * (e.g. cycle-behavior). If not provided, editable cards render in read-only mode.
   */
  onConfigChange?: (path: string, value: unknown) => void;
  readonly?: boolean;
}
