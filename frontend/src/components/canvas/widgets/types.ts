/**
 * Shared widget contract — every widget in the registry must satisfy this interface.
 */
export interface JSONSchemaFragment {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  const?: unknown;
  properties?: Record<string, JSONSchemaFragment>;
  items?: JSONSchemaFragment;
  required?: string[];
  additionalProperties?: JSONSchemaFragment | boolean;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  'x-widget'?: string;
  'x-show-if'?: {
    field: string;
    equals?: unknown;
    notEquals?: unknown;
  };
  /**
   * Human-readable labels for enum values, in the same order as `enum`.
   * If provided, SelectWidget renders these labels while storing the raw enum values.
   */
  'x-enum-labels'?: string[];
  /**
   * Injected at runtime by SchemaForm into nested/arrayOfObjects schemas so
   * those widgets can recursively render sub-forms without a circular import.
   * Not part of the JSON Schema spec — internal use only.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _SchemaForm?: import('react').ComponentType<any>;
}

export interface WidgetProps<T = unknown> {
  value: T;
  onChange: (value: T) => void;
  schema: JSONSchemaFragment;
  fieldName: string;
  required: boolean;
  disabled?: boolean;
}
