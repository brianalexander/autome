import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateWidget } from '../DateWidget';

const schema = { type: 'string', format: 'date' };

describe('DateWidget', () => {
  it('renders a date input with the current value', () => {
    render(<DateWidget value="2025-06-15" onChange={vi.fn()} schema={schema} fieldName="due_date" required={false} />);
    expect(screen.getByDisplayValue('2025-06-15')).toBeInTheDocument();
  });

  it('fires onChange with the new date string', () => {
    const onChange = vi.fn();
    render(<DateWidget value="2025-06-15" onChange={onChange} schema={schema} fieldName="due_date" required={false} />);
    fireEvent.change(screen.getByDisplayValue('2025-06-15'), { target: { value: '2025-12-01' } });
    expect(onChange).toHaveBeenCalledWith('2025-12-01');
  });

  it('fires onChange with undefined when cleared', () => {
    const onChange = vi.fn();
    render(<DateWidget value="2025-06-15" onChange={onChange} schema={schema} fieldName="due_date" required={false} />);
    fireEvent.change(screen.getByDisplayValue('2025-06-15'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('renders empty when value is undefined', () => {
    render(<DateWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="due_date" required={false} />);
    expect(screen.getByDisplayValue('')).toBeInTheDocument();
  });

  it('is disabled when disabled prop is set', () => {
    render(<DateWidget value="2025-01-01" onChange={vi.fn()} schema={schema} fieldName="due_date" required={false} disabled />);
    expect(screen.getByDisplayValue('2025-01-01')).toBeDisabled();
  });
});
