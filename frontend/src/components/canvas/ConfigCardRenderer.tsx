import { CARD_REGISTRY } from './configCards/index';
import type { CardRendererProps } from './configCards/index';

/**
 * ConfigCardRenderer — dispatches a ConfigCard to its registered renderer.
 * Cards that have no registered renderer are silently skipped.
 */
export function ConfigCardRenderer(props: CardRendererProps) {
  const Component = CARD_REGISTRY[props.card.kind];
  if (!Component) return null;
  return <Component {...props} />;
}
