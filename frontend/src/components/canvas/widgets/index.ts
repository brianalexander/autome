import type { ComponentType } from 'react';
import type { WidgetProps, JSONSchemaFragment } from './types';

// Moved widgets (previously inline in SchemaForm)
import { CheckboxWidget } from './CheckboxWidget';
import { SelectWidget } from './SelectWidget';
import { NumberWidget } from './NumberWidget';
import { TextWidget } from './TextWidget';
import { TextareaWidget } from './TextareaWidget';
import { CodeWidget } from './CodeWidget';
import { DependenciesWidget } from './DependenciesWidget';
import { NestedObjectWidget } from './NestedObjectWidget';

// New widgets
import { MultiSelectWidget } from './MultiSelectWidget';
import { TagsWidget } from './TagsWidget';
import { DateWidget } from './DateWidget';
import { DatetimeWidget } from './DatetimeWidget';
import { SecretWidget } from './SecretWidget';
import { SliderWidget } from './SliderWidget';
import { KeyValueWidget } from './KeyValueWidget';
import { ArrayOfObjectsWidget } from './ArrayOfObjectsWidget';
import { ColorWidget } from './ColorWidget';

export type { WidgetProps, JSONSchemaFragment } from './types';
export { CheckboxWidget } from './CheckboxWidget';
export { SelectWidget } from './SelectWidget';
export { NumberWidget } from './NumberWidget';
export { TextWidget } from './TextWidget';
export { TextareaWidget } from './TextareaWidget';
export { CodeWidget } from './CodeWidget';
export { DependenciesWidget } from './DependenciesWidget';
export { NestedObjectWidget } from './NestedObjectWidget';
export { MultiSelectWidget } from './MultiSelectWidget';
export { TagsWidget } from './TagsWidget';
export { DateWidget } from './DateWidget';
export { DatetimeWidget } from './DatetimeWidget';
export { SecretWidget } from './SecretWidget';
export { SliderWidget } from './SliderWidget';
export { KeyValueWidget } from './KeyValueWidget';
export { ArrayOfObjectsWidget } from './ArrayOfObjectsWidget';
export { ColorWidget } from './ColorWidget';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WIDGET_REGISTRY: Record<string, ComponentType<WidgetProps<any>>> = {
  checkbox: CheckboxWidget,
  select: SelectWidget,
  number: NumberWidget,
  text: TextWidget,
  textarea: TextareaWidget,
  code: CodeWidget,
  dependencies: DependenciesWidget,
  nested: NestedObjectWidget,
  multiselect: MultiSelectWidget,
  tags: TagsWidget,
  date: DateWidget,
  'date-time': DatetimeWidget,
  color: ColorWidget,
  secret: SecretWidget,
  slider: SliderWidget,
  keyvalue: KeyValueWidget,
  arrayOfObjects: ArrayOfObjectsWidget,
};

/**
 * Resolves the widget key for a given schema fragment and field name.
 * Priority order (highest to lowest):
 *  1. explicit x-widget keyword (if registered)
 *  2. format: 'date' | 'date-time' | 'color' | 'textarea' | 'code' | 'json' | 'template' | 'dependencies'
 *  3. fieldName === 'dependencies'
 *  4. schema.enum present → select
 *  5. schema.type === 'array':
 *       items.enum → multiselect
 *       items.type === 'object' → arrayOfObjects
 *       otherwise → tags
 *  6. schema.type === 'boolean' → checkbox
 *  7. schema.type === 'number' | 'integer' → number
 *  8. schema.type === 'object' with additionalProperties → keyvalue
 *  9. schema.type === 'object' with properties → nested
 * 10. fieldName matches /(secret|password|token|api[_-]?key)/i → secret
 * 11. default → text
 */
export function resolveWidget(schema: JSONSchemaFragment, fieldName: string): string {
  // 1. Explicit x-widget override
  const explicit = schema['x-widget'];
  if (explicit && typeof explicit === 'string' && explicit in WIDGET_REGISTRY) {
    return explicit;
  }

  // 2. Format-based dispatch
  const fmt = schema.format;
  if (fmt === 'date') return 'date';
  if (fmt === 'date-time') return 'date-time';
  if (fmt === 'color') return 'color';
  if (fmt === 'textarea') return 'textarea';
  if (fmt === 'code' || fmt === 'json' || fmt === 'template') return 'code';
  if (fmt === 'dependencies') return 'dependencies';

  // 3. Field name === 'dependencies'
  if (fieldName === 'dependencies') return 'dependencies';

  // 4. enum → select
  if (schema.enum) return 'select';

  // 5. array types
  if (schema.type === 'array') {
    if (schema.items?.enum) return 'multiselect';
    if (schema.items?.type === 'object') return 'arrayOfObjects';
    return 'tags';
  }

  // 6. boolean
  if (schema.type === 'boolean') return 'checkbox';

  // 7. number / integer
  if (schema.type === 'number' || schema.type === 'integer') return 'number';

  // 8. object with additionalProperties → keyvalue
  if (schema.type === 'object' && schema.additionalProperties) return 'keyvalue';

  // 9. object with properties → nested
  if (schema.type === 'object' && schema.properties) return 'nested';

  // 10. secret-like field names
  if (/(secret|password|token|api[_-]?key)/i.test(fieldName)) return 'secret';

  // 11. default
  return 'text';
}
