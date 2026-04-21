import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SchemaForm } from './SchemaForm';
import { resolveWidget } from './widgets/index';

// CodeEditor uses CodeMirror which doesn't work in jsdom — mock it
vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="code-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// -----------------------------------------------------------------------
// SchemaForm rendering tests
// -----------------------------------------------------------------------

describe('SchemaForm', () => {
  it('renders nothing for empty schema', () => {
    const onChange = vi.fn();
    const { container } = render(<SchemaForm schema={{ properties: {} }} value={{}} onChange={onChange} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a text input for string fields', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            url: { type: 'string', title: 'URL' },
          },
        }}
        value={{ url: 'https://example.com' }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('https://example.com');
    expect(input).toBeInTheDocument();
  });

  it('renders a number input for number fields', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            timeout: { type: 'number', title: 'Timeout', default: 30 },
          },
        }}
        value={{ timeout: 60 }}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('60')).toBeInTheDocument();
  });

  it('renders a checkbox for boolean fields', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            enabled: { type: 'boolean', title: 'Enabled' },
          },
        }}
        value={{ enabled: true }}
        onChange={onChange}
      />,
    );
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('renders a select for enum fields', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            method: { type: 'string', title: 'Method', enum: ['GET', 'POST', 'PUT'] },
          },
        }}
        value={{ method: 'POST' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('POST')).toBeInTheDocument();
  });

  it('calls onChange when a text field is updated', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            name: { type: 'string', title: 'Name' },
          },
        }}
        value={{ name: '' }}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'test' } });
    expect(onChange).toHaveBeenCalledWith({ name: 'test' });
  });

  it('hides const fields', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            provider: { type: 'string', const: 'manual', default: 'manual' },
            name: { type: 'string', title: 'Name' },
          },
        }}
        value={{ provider: 'manual', name: 'test' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.queryByText('provider')).not.toBeInTheDocument();
  });

  it('renders textarea for format:textarea fields', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            template: { type: 'string', title: 'Template', format: 'textarea' },
          },
        }}
        value={{ template: 'hello {{ name }}' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('hello {{ name }}')).toBeInTheDocument();
    expect(screen.getByDisplayValue('hello {{ name }}').tagName).toBe('TEXTAREA');
  });

  it('shows required indicator for required fields', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            url: { type: 'string', title: 'URL' },
          },
          required: ['url'],
        }}
        value={{}}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('disables a field when prop.readOnly is true', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            fixed: { type: 'string', title: 'Fixed Field', readOnly: true },
          },
        }}
        value={{ fixed: 'baked' }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('baked');
    expect(input).toBeDisabled();
  });

  it('disables a field when panel readonly is true (field has no readOnly)', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            name: { type: 'string', title: 'Name' },
          },
        }}
        value={{ name: 'hello' }}
        onChange={onChange}
        readonly={true}
      />,
    );
    const input = screen.getByDisplayValue('hello');
    expect(input).toBeDisabled();
  });

  it('does NOT call onChange when a readOnly field changes', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{
          properties: {
            fixed: { type: 'string', title: 'Fixed', readOnly: true },
          },
        }}
        value={{ fixed: 'immutable' }}
        onChange={onChange}
      />,
    );
    // The input is disabled so firing change won't go through, but guard via onChange check
    const input = screen.getByDisplayValue('immutable');
    fireEvent.change(input, { target: { value: 'changed' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// resolveWidget tests — one per priority branch
// -----------------------------------------------------------------------

describe('resolveWidget', () => {
  it('priority 1: x-widget explicit override (registered)', () => {
    expect(resolveWidget({ 'x-widget': 'slider', type: 'number' }, 'count')).toBe('slider');
  });

  it('priority 1: x-widget unknown key falls through', () => {
    // unregistered x-widget → falls through to type-based dispatch
    expect(resolveWidget({ 'x-widget': 'not-a-widget', type: 'boolean' }, 'flag')).toBe('checkbox');
  });

  it('priority 2: format date', () => {
    expect(resolveWidget({ type: 'string', format: 'date' }, 'due_date')).toBe('date');
  });

  it('priority 2: format date-time', () => {
    expect(resolveWidget({ type: 'string', format: 'date-time' }, 'created_at')).toBe('date-time');
  });

  it('priority 2: format color', () => {
    expect(resolveWidget({ type: 'string', format: 'color' }, 'bg')).toBe('color');
  });

  it('priority 2: format textarea', () => {
    expect(resolveWidget({ type: 'string', format: 'textarea' }, 'prompt')).toBe('textarea');
  });

  it('priority 2: format code', () => {
    expect(resolveWidget({ type: 'string', format: 'code' }, 'script')).toBe('code');
  });

  it('priority 2: format json', () => {
    expect(resolveWidget({ type: 'object', format: 'json' }, 'config')).toBe('code');
  });

  it('priority 2: format template', () => {
    expect(resolveWidget({ type: 'string', format: 'template' }, 'body')).toBe('code');
  });

  it('priority 2: format dependencies', () => {
    expect(resolveWidget({ type: 'object', format: 'dependencies' }, 'pkgs')).toBe('dependencies');
  });

  it('priority 3: fieldName === dependencies', () => {
    expect(resolveWidget({ type: 'object' }, 'dependencies')).toBe('dependencies');
  });

  it('priority 4: enum → select', () => {
    expect(resolveWidget({ type: 'string', enum: ['a', 'b'] }, 'mode')).toBe('select');
  });

  it('priority 5: array with items.enum → multiselect', () => {
    expect(resolveWidget({ type: 'array', items: { enum: ['x', 'y'] } }, 'tags')).toBe('multiselect');
  });

  it('priority 5: array with items.type=object → arrayOfObjects', () => {
    expect(resolveWidget({ type: 'array', items: { type: 'object', properties: {} } }, 'rows')).toBe('arrayOfObjects');
  });

  it('priority 5: array (strings) → tags', () => {
    expect(resolveWidget({ type: 'array', items: { type: 'string' } }, 'labels')).toBe('tags');
  });

  it('priority 6: boolean → checkbox', () => {
    expect(resolveWidget({ type: 'boolean' }, 'active')).toBe('checkbox');
  });

  it('priority 7: number → number', () => {
    expect(resolveWidget({ type: 'number' }, 'count')).toBe('number');
  });

  it('priority 7: integer → number', () => {
    expect(resolveWidget({ type: 'integer' }, 'count')).toBe('number');
  });

  it('priority 8: object with additionalProperties → keyvalue', () => {
    expect(resolveWidget({ type: 'object', additionalProperties: { type: 'string' } }, 'headers')).toBe('keyvalue');
  });

  it('priority 9: object with properties → nested', () => {
    expect(resolveWidget({ type: 'object', properties: { foo: { type: 'string' } } }, 'config')).toBe('nested');
  });

  it('priority 10: field name contains secret', () => {
    expect(resolveWidget({ type: 'string' }, 'api_secret')).toBe('secret');
  });

  it('priority 10: field name contains token', () => {
    expect(resolveWidget({ type: 'string' }, 'authToken')).toBe('secret');
  });

  it('priority 10: field name contains api_key', () => {
    expect(resolveWidget({ type: 'string' }, 'api_key')).toBe('secret');
  });

  it('priority 11: default → text', () => {
    expect(resolveWidget({ type: 'string' }, 'name')).toBe('text');
  });
});
