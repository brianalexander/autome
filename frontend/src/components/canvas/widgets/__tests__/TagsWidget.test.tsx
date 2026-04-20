import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TagsWidget } from '../TagsWidget';

const schema = { type: 'array', items: { type: 'string' } };

describe('TagsWidget', () => {
  it('renders existing tags as chips', () => {
    render(<TagsWidget value={['foo', 'bar']} onChange={vi.fn()} schema={schema} fieldName="tags" required={false} />);
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
  });

  it('adds a tag on Enter', () => {
    const onChange = vi.fn();
    render(<TagsWidget value={[]} onChange={onChange} schema={schema} fieldName="tags" required={false} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['newtag']);
  });

  it('removes last tag on Backspace when input is empty', () => {
    const onChange = vi.fn();
    render(<TagsWidget value={['foo', 'bar']} onChange={onChange} schema={schema} fieldName="tags" required={false} />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['foo']);
  });

  it('removes a chip when its x button is clicked', () => {
    const onChange = vi.fn();
    render(<TagsWidget value={['foo', 'bar']} onChange={onChange} schema={schema} fieldName="tags" required={false} />);
    const removeButtons = screen.getAllByRole('button');
    fireEvent.click(removeButtons[0]); // Remove 'foo'
    expect(onChange).toHaveBeenCalledWith(['bar']);
  });

  it('does not add empty or duplicate tags', () => {
    const onChange = vi.fn();
    render(<TagsWidget value={['foo']} onChange={onChange} schema={schema} fieldName="tags" required={false} />);
    const input = screen.getByRole('textbox');
    // Empty
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    // Duplicate
    fireEvent.change(input, { target: { value: 'foo' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('handles undefined value as empty', () => {
    render(<TagsWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="tags" required={false} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('hides input and remove buttons when disabled', () => {
    render(<TagsWidget value={['foo']} onChange={vi.fn()} schema={schema} fieldName="tags" required={false} disabled />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
