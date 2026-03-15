/**
 * schema-to-zod.ts
 *
 * Converts a JSON Schema (draft 7) object into a Zod schema at runtime.
 * Used to validate node configs and edge configs defined via configSchema /
 * inEdgeSchema / outEdgeSchema on NodeTypeSpec without having authors
 * maintain a separate Zod schema alongside their JSON Schema.
 *
 * Supported subset (covers every feature used by built-in nodes):
 *   - Scalar types: string, number, integer, boolean, null
 *   - Object types: properties, required, additionalProperties, passthrough
 *   - Array types: items
 *   - enum (string-only → z.enum; mixed → z.union of z.literal)
 *   - const → z.literal
 *   - nullable / type: ["T", "null"] → .nullable()
 *   - description → .describe()
 *   - default → .default()
 *   - format → ignored (UI-only metadata)
 *
 * Unsupported keywords ($ref, allOf, anyOf, oneOf, not, if/then/else,
 * patternProperties) produce a console.warn and fall back to z.unknown().
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema (draft 7) object into a Zod schema at runtime.
 * Supports the subset of JSON Schema features used by node type configSchemas.
 *
 * Unsupported features ($ref, allOf/anyOf/oneOf, patternProperties, if/then/else)
 * produce console.warn messages and fall back to z.unknown().
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  return convertSchema(schema);
}

// ---------------------------------------------------------------------------
// Core converter
// ---------------------------------------------------------------------------

function convertSchema(schema: Record<string, unknown>): z.ZodType {
  // Warn early and bail out for keywords we cannot model faithfully.
  // We check these before type-based dispatch so authors see the warning
  // even when the schema also has a type field.
  for (const keyword of [
    '$ref',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'patternProperties',
  ]) {
    if (keyword in schema) {
      console.warn(
        `[schema-to-zod] Unsupported JSON Schema keyword "${keyword}" — falling back to z.unknown(). ` +
          'Consider using a simpler schema or contributing support for this keyword.',
      );
      return z.unknown();
    }
  }

  // -------------------------------------------------------------------------
  // const: a single fixed value
  // -------------------------------------------------------------------------
  if ('const' in schema) {
    const constVal = schema.const as string | number | boolean | null;
    return applyMeta(z.literal(constVal as string | number | boolean), schema);
  }

  // -------------------------------------------------------------------------
  // enum: a fixed set of allowed values
  // -------------------------------------------------------------------------
  if ('enum' in schema) {
    return convertEnum(schema);
  }

  // -------------------------------------------------------------------------
  // Nullable type shorthand: type can be a two-element array like
  // ["string", "null"] — extract the real type and apply .nullable() later.
  // -------------------------------------------------------------------------
  let nullable = (schema.nullable as boolean | undefined) === true;
  let resolvedType = schema.type as string | string[] | undefined;

  if (Array.isArray(resolvedType)) {
    const types = resolvedType as string[];
    if (types.includes('null')) {
      nullable = true;
      const nonNull = types.filter((t) => t !== 'null');
      // If there's exactly one non-null type, unwrap to a plain string.
      // If there are multiple non-null types we can't represent faithfully —
      // warn and fall back.
      if (nonNull.length === 1) {
        resolvedType = nonNull[0];
      } else if (nonNull.length === 0) {
        // type: ["null"] — equivalent to z.null()
        resolvedType = 'null';
      } else {
        console.warn(
          `[schema-to-zod] type array ${JSON.stringify(types)} with multiple non-null types — falling back to z.unknown()`,
        );
        return z.unknown();
      }
    } else {
      console.warn(
        `[schema-to-zod] type array ${JSON.stringify(types)} without null — falling back to z.unknown()`,
      );
      return z.unknown();
    }
  }

  const type = resolvedType as string | undefined;

  // If no type but properties are present, treat as object (common shorthand).
  if (!type && schema.properties) {
    const base = convertObject(schema);
    return nullable ? applyMeta(base.nullable(), schema) : applyMeta(base, schema);
  }

  // -------------------------------------------------------------------------
  // Type-based dispatch
  // -------------------------------------------------------------------------
  let base: z.ZodType;

  switch (type) {
    case 'string':
      base = z.string();
      break;

    case 'number':
      base = z.number();
      break;

    case 'integer':
      // .int() adds an integer refinement on top of z.number()
      base = z.number().int();
      break;

    case 'boolean':
      base = z.boolean();
      break;

    case 'null':
      // Explicit null type — rarely used standalone but valid JSON Schema.
      // applyMeta handles description/default; skip the extra .nullable() wrap.
      return applyMeta(z.null(), schema);

    case 'object':
      base = convertObject(schema);
      break;

    case 'array':
      base = convertArray(schema);
      break;

    default:
      if (type) {
        console.warn(`[schema-to-zod] Unknown type "${type}" — using z.unknown()`);
      }
      // No type, no properties, no enum, no const → open-ended unknown.
      return z.unknown();
  }

  if (nullable) {
    return applyMeta((base as z.ZodType & { nullable(): z.ZodType }).nullable(), schema);
  }

  return applyMeta(base, schema);
}

// ---------------------------------------------------------------------------
// Object converter
// ---------------------------------------------------------------------------

function convertObject(schema: Record<string, unknown>): z.ZodTypeAny {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const requiredFields = (schema.required as string[] | undefined) ?? [];

  // If no properties but additionalProperties is present (or just type: "object"
  // with no properties), emit a z.record to capture arbitrary key/value pairs.
  if (!properties) {
    return z.record(z.string(), z.unknown());
  }

  // Build the shape, marking non-required fields as optional.
  const shape: Record<string, z.ZodType> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const fieldZod = convertSchema(propSchema);
    shape[key] = requiredFields.includes(key) ? fieldZod : fieldZod.optional();
  }

  // passthrough() lets unknown extra keys flow through without stripping them.
  // This mirrors the permissive runtime behaviour expected when configs carry
  // UI-only metadata fields (title, format, etc.) that the schema doesn't list.
  return z.object(shape).passthrough();
}

// ---------------------------------------------------------------------------
// Array converter
// ---------------------------------------------------------------------------

function convertArray(schema: Record<string, unknown>): z.ZodTypeAny {
  const items = schema.items;
  if (Array.isArray(items)) {
    console.warn('[schema-to-zod] Tuple-form "items" (array) is not supported — using z.array(z.unknown())');
    return z.array(z.unknown());
  }
  const itemSchema = items ? convertSchema(items as Record<string, unknown>) : z.unknown();
  return z.array(itemSchema);
}

// ---------------------------------------------------------------------------
// Enum converter
// ---------------------------------------------------------------------------

function convertEnum(schema: Record<string, unknown>): z.ZodType {
  const values = schema.enum as unknown[];

  if (values.length === 0) {
    console.warn('[schema-to-zod] enum with no values — falling back to z.unknown()');
    return z.unknown();
  }

  // If every value is a string, use z.enum for a tighter type.
  const allStrings = values.every((v) => typeof v === 'string');
  if (allStrings) {
    const strValues = values as string[];
    return applyMeta(
      z.enum(strValues as [string, ...string[]]),
      schema,
    );
  }

  // Mixed or non-string enum → z.union of z.literal values.
  if (values.length === 1) {
    return applyMeta(
      z.literal(values[0] as string | number | boolean),
      schema,
    );
  }

  const literals = values.map((v) => z.literal(v as string | number | boolean));
  return applyMeta(
    z.union([literals[0], literals[1], ...literals.slice(2)]),
    schema,
  );
}

// ---------------------------------------------------------------------------
// Metadata applicator — description and default
// ---------------------------------------------------------------------------

/**
 * Apply JSON Schema metadata to a finished Zod schema:
 *   - `description` → .describe(description)
 *   - `default`     → .default(value)
 *
 * Both are applied only when the respective key is present.
 * Note: .default() must come after .describe() because it wraps the schema in
 * a new ZodDefault layer; the description on the inner schema is still accessible.
 */
function applyMeta(zodSchema: z.ZodType, jsonSchema: Record<string, unknown>): z.ZodType {
  let result: z.ZodType = zodSchema;

  if (typeof jsonSchema.description === 'string') {
    result = result.describe(jsonSchema.description);
  }

  if ('default' in jsonSchema) {
    // .default() exists on all ZodType instances at runtime but is only typed
    // on the concrete subclasses. The cast to `any` is intentional here.
    // biome-ignore lint/suspicious/noExplicitAny: .default() exists at runtime on all ZodType instances
    result = (result as any).default(jsonSchema.default);
  }

  return result;
}
