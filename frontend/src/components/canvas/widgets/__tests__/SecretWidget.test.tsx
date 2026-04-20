import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SecretWidget } from '../SecretWidget';

const schema = { type: 'string' };

describe('SecretWidget', () => {
  it('renders a password input by default', () => {
    render(<SecretWidget value="mysecret" onChange={vi.fn()} schema={schema} fieldName="api_key" required={false} />);
    const input = screen.getByDisplayValue('mysecret');
    expect(input).toHaveAttribute('type', 'password');
  });

  it('toggles to text type when eye button is clicked', () => {
    render(<SecretWidget value="mysecret" onChange={vi.fn()} schema={schema} fieldName="api_key" required={false} />);
    const toggleBtn = screen.getByRole('button');
    fireEvent.click(toggleBtn);
    expect(screen.getByDisplayValue('mysecret')).toHaveAttribute('type', 'text');
  });

  it('toggles back to password when clicked again', () => {
    render(<SecretWidget value="mysecret" onChange={vi.fn()} schema={schema} fieldName="api_key" required={false} />);
    const toggleBtn = screen.getByRole('button');
    fireEvent.click(toggleBtn);
    fireEvent.click(toggleBtn);
    expect(screen.getByDisplayValue('mysecret')).toHaveAttribute('type', 'password');
  });

  it('fires onChange when value changes', () => {
    const onChange = vi.fn();
    render(<SecretWidget value="existing" onChange={onChange} schema={schema} fieldName="api_key" required={false} />);
    // The input is type="password" by default — query by display value
    fireEvent.change(screen.getByDisplayValue('existing'), { target: { value: 'newpass' } });
    expect(onChange).toHaveBeenCalledWith('newpass');
  });

  it('fires onChange with undefined on empty input', () => {
    const onChange = vi.fn();
    render(<SecretWidget value="x" onChange={onChange} schema={schema} fieldName="api_key" required={false} />);
    fireEvent.change(screen.getByDisplayValue('x'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('is disabled when disabled prop is set', () => {
    render(<SecretWidget value="mysecret" onChange={vi.fn()} schema={schema} fieldName="api_key" required={false} disabled />);
    expect(screen.getByDisplayValue('mysecret')).toBeDisabled();
  });
});
