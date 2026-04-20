import type { ComponentType } from 'react';
import type { CardRendererProps } from './types';
import { HelpTextCard } from './HelpTextCard';
import { CopyUrlCard } from './CopyUrlCard';
import { CurlSnippetCard } from './CurlSnippetCard';
import { PreviewTemplateCard } from './PreviewTemplateCard';
import { ActivationStatusCard } from './ActivationStatusCard';
import { CycleBehaviorCard } from './CycleBehaviorCard';

export type { CardRendererProps, ConfigCard } from './types';
export { substituteTemplate } from './substitute';
export type { SubstituteVars } from './substitute';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CARD_REGISTRY: Record<string, ComponentType<CardRendererProps>> = {
  'help-text': HelpTextCard,
  'copy-url': CopyUrlCard,
  'curl-snippet': CurlSnippetCard,
  'preview-template': PreviewTemplateCard,
  'activation-status': ActivationStatusCard,
  'cycle-behavior': CycleBehaviorCard,
};
