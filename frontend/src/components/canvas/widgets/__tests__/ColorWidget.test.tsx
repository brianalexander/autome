import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColorWidget } from '../ColorWidget';

const schema = { type: 'string', format: 'color' };

describe('ColorWidget', () => {
  it('renders a color swatch and hex text input', () => {
    render(<ColorWidget value="#ff0000" onChange={vi.fn()} schema={schema} fieldName="color" required={false} />);
    const inputs = screen.getAllByDisplayValue('#ff0000');
    expect(inputs).toHaveLength(2); // color picker + text input
  });

  it('fires onChange when color picker changes', () => {
    const onChange = vi.fn();
    render(<ColorWidget value="#ff0000" onChange={onChange} schema={schema} fieldName="color" required={false} />);
    const colorInput = screen.getAllByDisplayValue('#ff0000')[0];
    fireEvent.change(colorInput, { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });

  it('fires onChange when hex text input changes', () => {
    const onChange = vi.fn();
    render(<ColorWidget value="#ff0000" onChange={onChange} schema={schema} fieldName="color" required={false} />);
    const textInput = screen.getAllByDisplayValue('#ff0000')[1];
    fireEvent.change(textInput, { target: { value: '#0000ff' } });
    expect(onChange).toHaveBeenCalledWith('#0000ff');
  });

  it('defaults to black when value is undefined', () => {
    render(<ColorWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="color" required={false} />);
    expect(screen.getAllByDisplayValue('#000000')).toHaveLength(2);
  });

  it('is disabled when disabled prop is set', () => {
    render(<ColorWidget value="#ff0000" onChange={vi.fn()} schema={schema} fieldName="color" required={false} disabled />);
    screen.getAllByDisplayValue('#ff0000').forEach((input) => expect(input).toBeDisabled());
  });
});
