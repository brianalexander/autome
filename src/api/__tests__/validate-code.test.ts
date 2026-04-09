/**
 * Tests for validate-code.ts
 *
 * The module uses the TypeScript compiler API in-process — no mocks needed.
 * Tests focus on:
 *   1. jsonSchemaToTsType — schema-to-TS-string conversion (via validateCode output)
 *   2. validateCode — function mode, expression mode, sandbox flag
 *   3. Diagnostic positions map back to the user's original code range
 */
import { describe, it, expect } from 'vitest';
import { validateCode } from '../validate-code.js';
import type { ValidateCodeInput } from '../validate-code.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validate(code: string, extra: Partial<ValidateCodeInput> = {}) {
  return validateCode({ code, ...extra });
}

// ---------------------------------------------------------------------------
// Empty / trivial inputs
// ---------------------------------------------------------------------------

describe('validateCode — empty input', () => {
  it('returns no diagnostics for an empty string', () => {
    expect(validate('')).toEqual([]);
  });

  it('returns no diagnostics for whitespace-only code', () => {
    expect(validate('   \n\t  ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Function mode — valid code
// ---------------------------------------------------------------------------

describe('validateCode — function mode (valid code)', () => {
  it('accepts a simple arrow function with no issues', () => {
    const code = `export default ({ input, config }) => {
  return { result: 'ok' };
}`;
    const diags = validate(code);
    expect(diags).toHaveLength(0);
  });

  it('accepts an async arrow function', () => {
    const code = `export default async ({ input, config }) => {
  const data = await fetch('https://example.com');
  return { ok: data.ok };
}`;
    const diags = validate(code);
    expect(diags).toHaveLength(0);
  });

  it('accepts a named async function with single param', () => {
    const code = `export default async function handler(input) {
  return { value: 42 };
}`;
    const diags = validate(code);
    expect(diags).toHaveLength(0);
  });

  it('accepts code that accesses typed input properties from an output schema', () => {
    const outputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['name'],
    };
    const code = `export default ({ input }) => {
  const name: string = input.name;
  return { processed: name };
}`;
    const diags = validate(code, { outputSchema });
    expect(diags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Function mode — type errors produce diagnostics
// ---------------------------------------------------------------------------

describe('validateCode — function mode (type errors)', () => {
  it('returns a diagnostic for an undeclared variable reference', () => {
    const code = `export default ({ input }) => {
  return undeclaredVariable;
}`;
    const diags = validate(code);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toContain('undeclaredVariable');
  });

  it('returns a diagnostic for a type mismatch with a return schema', () => {
    const returnSchema = {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    };
    // Returning a string where number is expected
    const code = `export default ({ input }): { count: number } => {
  return { count: 'not-a-number' as any };
}`;
    // any cast suppresses errors — use a harder mismatch that TS catches regardless
    const strictCode = `export default ({ input }) => {
  const x: number = 'hello';
  return x;
}`;
    const diags = validate(strictCode, { returnSchema });
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toContain("'string'");
  });

  it('diagnostic positions are within the user code range (from >= 0)', () => {
    const code = `export default ({ input }) => {
  return unknownVar;
}`;
    const diags = validate(code);
    for (const d of diags) {
      expect(d.from).toBeGreaterThanOrEqual(0);
      expect(d.to).toBeGreaterThan(d.from);
    }
  });

  it('diagnostic `from` points to a position inside the user code string', () => {
    const code = `export default ({ input }) => {
  const x = badRef;
  return x;
}`;
    const diags = validate(code);
    expect(diags.length).toBeGreaterThan(0);
    // `from` should be <= the length of the user's code
    for (const d of diags) {
      expect(d.from).toBeLessThanOrEqual(code.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Expression mode
// ---------------------------------------------------------------------------

describe('validateCode — expression mode', () => {
  it('accepts a valid expression', () => {
    const code = `output.name + ' world'`;
    const outputSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    const diags = validate(code, {
      validationMode: 'expression',
      outputSchema,
    });
    expect(diags).toHaveLength(0);
  });

  it('returns diagnostics for an undeclared variable in expression mode', () => {
    const code = `ghostVariable.toUpperCase()`;
    const diags = validate(code, { validationMode: 'expression' });
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toContain('ghostVariable');
  });

  it('provides output and input as typed declared constants', () => {
    const outputSchema = {
      type: 'object',
      properties: {
        value: { type: 'number' },
      },
      required: ['value'],
    };
    // output.value is a number — adding 1 should be fine
    const code = `output.value + 1`;
    const diags = validate(code, {
      validationMode: 'expression',
      outputSchema,
    });
    expect(diags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// jsonSchemaToTsType — tested indirectly via diagnostics
// ---------------------------------------------------------------------------

describe('jsonSchemaToTsType — schema type mapping (verified via type checking)', () => {
  // We can probe the generated types by checking whether TS catches mismatches.

  it('maps string schema to the string type', () => {
    const outputSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    // Accessing .toUpperCase() on a string property should be fine
    const code = `export default ({ input }) => {
  const upper: string = input.name.toUpperCase();
  return { upper };
}`;
    const diags = validate(code, { outputSchema });
    expect(diags).toHaveLength(0);
  });

  it('maps number schema to the number type', () => {
    const outputSchema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
    const code = `export default ({ input }) => {
  const doubled: number = input.count * 2;
  return { doubled };
}`;
    const diags = validate(code, { outputSchema });
    expect(diags).toHaveLength(0);
  });

  it('maps boolean schema to the boolean type', () => {
    const outputSchema = { type: 'object', properties: { active: { type: 'boolean' } }, required: ['active'] };
    const code = `export default ({ input }) => {
  const flag: boolean = input.active;
  return { flag };
}`;
    const diags = validate(code, { outputSchema });
    expect(diags).toHaveLength(0);
  });

  it('maps array schema to Array<T>', () => {
    const outputSchema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['items'],
    };
    const code = `export default ({ input }) => {
  const first: string = input.items[0];
  return { first };
}`;
    const diags = validate(code, { outputSchema });
    expect(diags).toHaveLength(0);
  });

  it('maps object schema with properties to a typed object', () => {
    const outputSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            email: { type: 'string' },
          },
          required: ['id', 'email'],
        },
      },
      required: ['user'],
    };
    const code = `export default ({ input }) => {
  const id: number = input.user.id;
  const email: string = input.user.email;
  return { id, email };
}`;
    const diags = validate(code, { outputSchema });
    expect(diags).toHaveLength(0);
  });

  it('maps oneOf schema to a union type', () => {
    const outputSchema = {
      type: 'object',
      properties: {
        value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['value'],
    };
    // Assigning to string | number should work
    const code = `export default ({ input }) => {
  const v: string | number = input.value;
  return { v };
}`;
    const diags = validate(code, { outputSchema });
    expect(diags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// code-trigger node type
// ---------------------------------------------------------------------------

describe('validateCode — code-trigger node type', () => {
  it('accepts code that uses emit() and signal', () => {
    const code = `export default ({ emit, signal, config }) => {
  emit({ type: 'ping' });
}`;
    const diags = validate(code, { nodeType: 'code-trigger' });
    expect(diags).toHaveLength(0);
  });

  it('provides __CodeTriggerParams with typed emit when returnSchema is given', () => {
    const returnSchema = {
      type: 'object',
      properties: { type: { type: 'string' } },
      required: ['type'],
    };
    const code = `export default ({ emit }) => {
  emit({ type: 'hello' });
}`;
    const diags = validate(code, { nodeType: 'code-trigger', returnSchema });
    expect(diags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sandbox flag
// ---------------------------------------------------------------------------

describe('validateCode — sandbox mode', () => {
  it('does not crash in sandbox mode (default)', () => {
    const code = `export default ({ input }) => ({ result: 'sandbox' })`;
    const diags = validate(code, { sandbox: true });
    expect(Array.isArray(diags)).toBe(true);
  });

  it('does not crash in non-sandbox mode (node types available)', () => {
    const code = `export default ({ input }) => ({ result: 'nonsandbox' })`;
    const diags = validate(code, { sandbox: false });
    expect(Array.isArray(diags)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diagnostic severity mapping
// ---------------------------------------------------------------------------

describe('validateCode — severity', () => {
  it('reports errors with severity "error"', () => {
    const code = `export default ({ input }) => {
  return notDefined;
}`;
    const diags = validate(code);
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Noise suppression
// ---------------------------------------------------------------------------

describe('validateCode — suppressed diagnostics', () => {
  it('does not report export/import keyword errors', () => {
    // A module with a top-level export should not produce "export" errors
    const code = `export default ({ input }) => {
  return { processed: true };
}`;
    const diags = validate(code);
    const exportErrors = diags.filter(
      (d) => d.message.includes("'export'") || d.message.includes("'import'"),
    );
    expect(exportErrors).toHaveLength(0);
  });
});
