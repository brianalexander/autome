import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArrayOfObjectsWidget } from '../ArrayOfObjectsWidget';

// Minimal SchemaForm stub — renders string fields as text inputs
function StubSchemaForm({ schema, value, onChange }: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const props = (schema.properties as Record<string, { title?: string; type?: string }>) ?? {};
  return (
    <div>
      {Object.entries(props).map(([key, prop]) => (
        <input
          key={key}
          aria-label={prop.title ?? key}
          value={String(value[key] ?? '')}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        />
      ))}
    </div>
  );
}

const schema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name' },
    },
    _SchemaForm: StubSchemaForm,
  },
  _SchemaForm: StubSchemaForm,
};

describe('ArrayOfObjectsWidget', () => {
  it('renders existing items as sub-cards', () => {
    render(
      <ArrayOfObjectsWidget
        value={[{ name: 'Alice' }, { name: 'Bob' }]}
        onChange={vi.fn()}
        schema={schema}
        fieldName="people"
        required={false}
      />,
    );
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bob')).toBeInTheDocument();
  });

  it('renders Add item button', () => {
    render(<ArrayOfObjectsWidget value={[]} onChange={vi.fn()} schema={schema} fieldName="people" required={false} />);
    expect(screen.getByText('Add item')).toBeInTheDocument();
  });

  it('adds an empty item when Add item is clicked', () => {
    const onChange = vi.fn();
    render(<ArrayOfObjectsWidget value={[]} onChange={onChange} schema={schema} fieldName="people" required={false} />);
    fireEvent.click(screen.getByText('Add item'));
    expect(onChange).toHaveBeenCalledWith([{}]);
  });

  it('removes an item when its x button is clicked', () => {
    const onChange = vi.fn();
    render(
      <ArrayOfObjectsWidget
        value={[{ name: 'Alice' }, { name: 'Bob' }]}
        onChange={onChange}
        schema={schema}
        fieldName="people"
        required={false}
      />,
    );
    const removeButtons = screen.getAllByRole('button');
    fireEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([{ name: 'Bob' }]);
  });

  it('handles undefined value as empty array', () => {
    render(<ArrayOfObjectsWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="people" required={false} />);
    expect(screen.getByText('Add item')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('hides Add and remove buttons when disabled', () => {
    render(
      <ArrayOfObjectsWidget
        value={[{ name: 'Alice' }]}
        onChange={vi.fn()}
        schema={schema}
        fieldName="people"
        required={false}
        disabled
      />,
    );
    expect(screen.queryByText('Add item')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
