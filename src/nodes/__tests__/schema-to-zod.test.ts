import { describe, it, expect, vi } from 'vitest';
import { jsonSchemaToZod } from '../schema-to-zod.js';
import { agentNodeSpec } from '../builtin/agent.js';

// ---------------------------------------------------------------------------
// Simple scalar types
// ---------------------------------------------------------------------------

describe('simple types', () => {
  it('string accepts strings and rejects non-strings', () => {
    const schema = jsonSchemaToZod({ type: 'string' });
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it('number accepts numbers and rejects non-numbers', () => {
    const schema = jsonSchemaToZod({ type: 'number' });
    expect(schema.safeParse(3.14).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse('3.14').success).toBe(false);
  });

  it('boolean accepts booleans and rejects non-booleans', () => {
    const schema = jsonSchemaToZod({ type: 'boolean' });
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    expect(schema.safeParse(1).success).toBe(false);
    expect(schema.safeParse('true').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integer type
// ---------------------------------------------------------------------------

describe('integer validation', () => {
  it('accepts integers', () => {
    const schema = jsonSchemaToZod({ type: 'integer' });
    expect(schema.safeParse(5).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(-10).success).toBe(true);
  });

  it('rejects floats', () => {
    const schema = jsonSchemaToZod({ type: 'integer' });
    expect(schema.safeParse(3.14).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
  });

  it('rejects non-numbers', () => {
    const schema = jsonSchemaToZod({ type: 'integer' });
    expect(schema.safeParse('5').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Required vs optional fields
// ---------------------------------------------------------------------------

describe('required vs optional fields', () => {
  const schema = jsonSchemaToZod({
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
    required: ['name'],
  });

  it('accepts object with both fields present', () => {
    expect(schema.safeParse({ name: 'Alice', age: 30 }).success).toBe(true);
  });

  it('accepts object with only required field', () => {
    expect(schema.safeParse({ name: 'Alice' }).success).toBe(true);
  });

  it('required field rejects undefined (missing key)', () => {
    expect(schema.safeParse({ age: 30 }).success).toBe(false);
  });

  it('optional field accepts undefined (missing key)', () => {
    expect(schema.safeParse({ name: 'Alice' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enum fields
// ---------------------------------------------------------------------------

describe('enum fields', () => {
  const schema = jsonSchemaToZod({
    type: 'string',
    enum: ['red', 'green', 'blue'],
  });

  it('accepts a value in the enum', () => {
    expect(schema.safeParse('red').success).toBe(true);
    expect(schema.safeParse('green').success).toBe(true);
    expect(schema.safeParse('blue').success).toBe(true);
  });

  it('rejects a value not in the enum', () => {
    expect(schema.safeParse('yellow').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(schema.safeParse(1).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nested objects
// ---------------------------------------------------------------------------

describe('nested objects', () => {
  const schema = jsonSchemaToZod({
    type: 'object',
    properties: {
      user: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          score: { type: 'number' },
        },
        required: ['id'],
      },
    },
    required: ['user'],
  });

  it('accepts a valid nested object', () => {
    expect(schema.safeParse({ user: { id: 'u1', score: 42 } }).success).toBe(true);
  });

  it('accepts nested object missing optional field', () => {
    expect(schema.safeParse({ user: { id: 'u1' } }).success).toBe(true);
  });

  it('rejects nested object missing required inner field', () => {
    expect(schema.safeParse({ user: { score: 42 } }).success).toBe(false);
  });

  it('rejects missing top-level required field', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('default values', () => {
  it('parsing undefined produces the default value', () => {
    const schema = jsonSchemaToZod({ type: 'string', default: 'hello' });
    const result = schema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('hello');
    }
  });

  it('parsing a provided value uses that value, not the default', () => {
    const schema = jsonSchemaToZod({ type: 'string', default: 'hello' });
    const result = schema.safeParse('world');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('world');
    }
  });

  it('default works on number types', () => {
    const schema = jsonSchemaToZod({ type: 'number', default: 5 });
    const result = schema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

describe('arrays', () => {
  it('array of strings accepts valid input', () => {
    const schema = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(schema.safeParse(['a', 'b', 'c']).success).toBe(true);
    expect(schema.safeParse([]).success).toBe(true);
  });

  it('array of strings rejects non-string items', () => {
    const schema = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(schema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it('array of objects accepts valid input', () => {
    const schema = jsonSchemaToZod({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    });
    expect(schema.safeParse([{ id: 'a' }, { id: 'b' }]).success).toBe(true);
  });

  it('array of objects rejects items missing required fields', () => {
    const schema = jsonSchemaToZod({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    });
    expect(schema.safeParse([{ notId: 'a' }]).success).toBe(false);
  });

  it('rejects non-array values', () => {
    const schema = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(schema.safeParse('not an array').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// const fields
// ---------------------------------------------------------------------------

describe('const fields', () => {
  it('accepts the exact const value', () => {
    const schema = jsonSchemaToZod({ const: 'fixed' });
    expect(schema.safeParse('fixed').success).toBe(true);
  });

  it('rejects any value other than the const', () => {
    const schema = jsonSchemaToZod({ const: 'fixed' });
    expect(schema.safeParse('other').success).toBe(false);
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it('works with numeric const', () => {
    const schema = jsonSchemaToZod({ const: 42 });
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(43).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown type
// ---------------------------------------------------------------------------

describe('unknown type', () => {
  it('schema with an unrecognised type falls back to z.unknown() and accepts anything', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = jsonSchemaToZod({ type: 'foobar' });
    expect(schema.safeParse('anything').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('foobar'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Empty schema
// ---------------------------------------------------------------------------

describe('empty schema', () => {
  it('{} falls back to z.unknown() and accepts anything', () => {
    const schema = jsonSchemaToZod({});
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No type but has properties — treated as object
// ---------------------------------------------------------------------------

describe('no type but has properties', () => {
  it('is treated as an object schema', () => {
    const schema = jsonSchemaToZod({
      properties: {
        foo: { type: 'string' },
      },
      required: ['foo'],
    });
    expect(schema.safeParse({ foo: 'bar' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nullable
// ---------------------------------------------------------------------------

describe('nullable', () => {
  it('nullable: true allows null in addition to the base type', () => {
    const schema = jsonSchemaToZod({ type: 'string', nullable: true });
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it('type: ["string", "null"] allows null', () => {
    const schema = jsonSchemaToZod({ type: ['string', 'null'] });
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it('type: ["number", "null"] allows null', () => {
    const schema = jsonSchemaToZod({ type: ['number', 'null'] });
    expect(schema.safeParse(3.14).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse('3.14').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

describe('description', () => {
  it('applies .describe() so zodSchema.description is set', () => {
    const schema = jsonSchemaToZod({ type: 'string', description: 'A name field' });
    expect(schema.description).toBe('A name field');
  });

  it('no description leaves description undefined', () => {
    const schema = jsonSchemaToZod({ type: 'string' });
    expect(schema.description).toBeUndefined();
  });

  it('description is accessible on the inner schema when default is also applied', () => {
    // When both description and default are present, applyMeta wraps in ZodDefault.
    // The inner schema retains the description.
    const schema = jsonSchemaToZod({ type: 'string', description: 'My field', default: 'x' });
    // The outer ZodDefault delegates description through the inner schema
    const inner = (schema as any)._def?.innerType;
    expect(inner?.description).toBe('My field');
  });
});

// ---------------------------------------------------------------------------
// Passthrough — objects allow extra properties
// ---------------------------------------------------------------------------

describe('passthrough', () => {
  it('extra properties not in the schema are allowed through', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    });
    const result = schema.safeParse({ name: 'Alice', extraKey: 'extra value' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extraKey).toBe('extra value');
    }
  });
});

// ---------------------------------------------------------------------------
// Unsupported keywords
// ---------------------------------------------------------------------------

describe('unsupported keywords', () => {
  it('$ref produces console.warn and returns z.unknown()', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = jsonSchemaToZod({ $ref: '#/definitions/Foo' });
    expect(schema.safeParse('anything').success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('$ref'));
    warnSpy.mockRestore();
  });

  it('allOf produces console.warn and returns z.unknown()', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = jsonSchemaToZod({ allOf: [{ type: 'string' }] });
    expect(schema.safeParse(42).success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('allOf'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Integration — real agent configSchema
// ---------------------------------------------------------------------------

describe('integration: agent configSchema', () => {
  it('converts the real agent configSchema and validates a valid config', () => {
    const schema = jsonSchemaToZod(agentNodeSpec.configSchema);
    const result = schema.safeParse({
      agentId: 'code-reviewer',
      max_iterations: 5,
      cycle_behavior: 'fresh',
      output_schema: { type: 'object', properties: {} },
    });
    expect(result.success).toBe(true);
  });

  it('rejects agent config with missing required agentId', () => {
    const schema = jsonSchemaToZod(agentNodeSpec.configSchema);
    const result = schema.safeParse({ max_iterations: 5 });
    expect(result.success).toBe(false);
  });

  it('accepts agent config with only agentId (all other fields optional)', () => {
    const schema = jsonSchemaToZod(agentNodeSpec.configSchema);
    const result = schema.safeParse({ agentId: 'my-agent', output_schema: { type: 'object', properties: {} } });
    expect(result.success).toBe(true);
  });

  it('accepts extra fields via passthrough', () => {
    const schema = jsonSchemaToZod(agentNodeSpec.configSchema);
    const result = schema.safeParse({ agentId: 'my-agent', output_schema: { type: 'object', properties: {} }, unknownField: true });
    expect(result.success).toBe(true);
  });

  it('rejects invalid cycle_behavior value', () => {
    const schema = jsonSchemaToZod(agentNodeSpec.configSchema);
    const result = schema.safeParse({ agentId: 'my-agent', cycle_behavior: 'invalid' });
    expect(result.success).toBe(false);
  });
});
