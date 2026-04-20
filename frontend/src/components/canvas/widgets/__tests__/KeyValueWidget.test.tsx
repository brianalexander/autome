import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeyValueWidget } from '../KeyValueWidget';

const schema = { type: 'object', additionalProperties: { type: 'string' } };

describe('KeyValueWidget', () => {
  it('renders existing key-value pairs', () => {
    render(<KeyValueWidget value={{ Authorization: 'Bearer xyz', 'X-Foo': 'bar' }} onChange={vi.fn()} schema={schema} fieldName="headers" required={false} />);
    expect(screen.getByDisplayValue('Authorization')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bearer xyz')).toBeInTheDocument();
    expect(screen.getByDisplayValue('X-Foo')).toBeInTheDocument();
  });

  it('adds a new empty row when Add is clicked', () => {
    const onChange = vi.fn();
    render(<KeyValueWidget value={{ a: '1' }} onChange={onChange} schema={schema} fieldName="headers" required={false} />);
    fireEvent.click(screen.getByText('Add'));
    expect(onChange).toHaveBeenCalledWith({ a: '1', '': '' });
  });

  it('updates a value when the value input changes', () => {
    const onChange = vi.fn();
    render(<KeyValueWidget value={{ key1: 'val1' }} onChange={onChange} schema={schema} fieldName="h" required={false} />);
    const valueInputs = screen.getAllByPlaceholderText('value');
    fireEvent.change(valueInputs[0], { target: { value: 'updated' } });
    expect(onChange).toHaveBeenCalledWith({ key1: 'updated' });
  });

  it('removes a row when x button is clicked', () => {
    const onChange = vi.fn();
    render(<KeyValueWidget value={{ a: '1', b: '2' }} onChange={onChange} schema={schema} fieldName="h" required={false} />);
    const removeButtons = screen.getAllByRole('button', { name: /remove row/i });
    fireEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith({ b: '2' });
  });

  it('calls onChange with undefined when last row is removed', () => {
    const onChange = vi.fn();
    render(<KeyValueWidget value={{ only: '1' }} onChange={onChange} schema={schema} fieldName="h" required={false} />);
    fireEvent.click(screen.getByRole('button', { name: /remove row/i }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('handles undefined value as empty dict', () => {
    render(<KeyValueWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="h" required={false} />);
    expect(screen.getByText('Add')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('key')).not.toBeInTheDocument();
  });

  it('hides Add and remove buttons when disabled', () => {
    render(<KeyValueWidget value={{ a: '1' }} onChange={vi.fn()} schema={schema} fieldName="h" required={false} disabled />);
    expect(screen.queryByText('Add')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
