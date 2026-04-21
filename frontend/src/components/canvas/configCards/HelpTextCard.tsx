import type { CardRendererProps } from './types';

/**
 * HelpTextCard — no longer renders inline.
 * Help-text content is now surfaced via the NodeDescriptionPopover info icon
 * in the ConfigPanel header. The `kind: 'help-text'` entries in node specs are
 * still valid and are picked up by the popover aggregator.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function HelpTextCard(_props: CardRendererProps) {
  return null;
}
