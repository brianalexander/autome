import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DatetimeWidget } from '../DatetimeWidget';

const schema = { type: 'string', format: 'date-time' };

describe('DatetimeWidget', () => {
  it('renders a datetime-local input with the current value', () => {
    render(<DatetimeWidget value="2025-06-15T10:30" onChange={vi.fn()} schema={schema} fieldName="created_at" required={false} />);
    expect(screen.getByDisplayValue('2025-06-15T10:30')).toBeInTheDocument();
  });

  it('fires onChange with the new datetime string', () => {
    const onChange = vi.fn();
    render(<DatetimeWidget value="2025-06-15T10:30" onChange={onChange} schema={schema} fieldName="created_at" required={false} />);
    fireEvent.change(screen.getByDisplayValue('2025-06-15T10:30'), { target: { value: '2025-12-01T09:00' } });
    expect(onChange).toHaveBeenCalledWith('2025-12-01T09:00');
  });

  it('fires onChange with undefined when cleared', () => {
    const onChange = vi.fn();
    render(<DatetimeWidget value="2025-06-15T10:30" onChange={onChange} schema={schema} fieldName="created_at" required={false} />);
    fireEvent.change(screen.getByDisplayValue('2025-06-15T10:30'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('renders empty when value is undefined', () => {
    render(<DatetimeWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="created_at" required={false} />);
    expect(screen.getByDisplayValue('')).toBeInTheDocument();
  });

  it('is disabled when disabled prop is set', () => {
    render(<DatetimeWidget value="2025-06-15T10:30" onChange={vi.fn()} schema={schema} fieldName="created_at" required={false} disabled />);
    expect(screen.getByDisplayValue('2025-06-15T10:30')).toBeDisabled();
  });
});
