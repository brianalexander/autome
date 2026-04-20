import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SliderWidget } from '../SliderWidget';

describe('SliderWidget', () => {
  const schema = { type: 'number', minimum: 0, maximum: 100, multipleOf: 5 };

  it('renders a range input with the current value', () => {
    render(<SliderWidget value={50} onChange={vi.fn()} schema={schema} fieldName="volume" required={false} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveValue('50');
  });

  it('displays the numeric label', () => {
    render(<SliderWidget value={75} onChange={vi.fn()} schema={schema} fieldName="volume" required={false} />);
    expect(screen.getByText('75')).toBeInTheDocument();
  });

  it('fires onChange with numeric value on change', () => {
    const onChange = vi.fn();
    render(<SliderWidget value={50} onChange={onChange} schema={schema} fieldName="volume" required={false} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } });
    expect(onChange).toHaveBeenCalledWith(80);
  });

  it('uses schema min/max/step attributes', () => {
    render(<SliderWidget value={50} onChange={vi.fn()} schema={schema} fieldName="volume" required={false} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '100');
    expect(slider).toHaveAttribute('step', '5');
  });

  it('uses defaults when min/max/step not in schema', () => {
    render(<SliderWidget value={50} onChange={vi.fn()} schema={{ type: 'number' }} fieldName="v" required={false} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '100');
    expect(slider).toHaveAttribute('step', '1');
  });

  it('renders with undefined value at minimum', () => {
    render(<SliderWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="volume" required={false} />);
    expect(screen.getByRole('slider')).toHaveValue('0');
  });

  it('is disabled when disabled prop is set', () => {
    render(<SliderWidget value={50} onChange={vi.fn()} schema={schema} fieldName="volume" required={false} disabled />);
    expect(screen.getByRole('slider')).toBeDisabled();
  });
});
