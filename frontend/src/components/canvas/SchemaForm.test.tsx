import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SchemaForm } from './SchemaForm';

// CodeEditor uses CodeMirror which doesn't work in jsdom — mock it
vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="code-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

describe('SchemaForm', () => {
  it('renders nothing for empty schema', () => {
    const onChange = vi.fn();
    render(<SchemaForm schema={{ properties: {} }} value={{}} onChange={onChange} />);
    expect(screen.getByText('No configuration needed.')).toBeInTheDocument();
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
    // Should show name but not provider
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
});
