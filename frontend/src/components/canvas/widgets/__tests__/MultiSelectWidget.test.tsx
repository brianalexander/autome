import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultiSelectWidget } from '../MultiSelectWidget';

const schema = { type: 'array', items: { enum: ['alpha', 'beta', 'gamma'] } };

describe('MultiSelectWidget', () => {
  it('renders all options as checkboxes', () => {
    render(<MultiSelectWidget value={[]} onChange={vi.fn()} schema={schema} fieldName="opts" required={false} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('gamma')).toBeInTheDocument();
  });

  it('checks the boxes that match the current value', () => {
    render(<MultiSelectWidget value={['alpha', 'gamma']} onChange={vi.fn()} schema={schema} fieldName="opts" required={false} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0]).toBeChecked();   // alpha
    expect(checkboxes[1]).not.toBeChecked(); // beta
    expect(checkboxes[2]).toBeChecked();   // gamma
  });

  it('fires onChange adding a new item when unchecked box is clicked', () => {
    const onChange = vi.fn();
    render(<MultiSelectWidget value={['alpha']} onChange={onChange} schema={schema} fieldName="opts" required={false} />);
    const betaCheckbox = screen.getAllByRole('checkbox')[1];
    fireEvent.click(betaCheckbox);
    expect(onChange).toHaveBeenCalledWith(['alpha', 'beta']);
  });

  it('fires onChange removing an item when checked box is clicked', () => {
    const onChange = vi.fn();
    render(<MultiSelectWidget value={['alpha', 'beta']} onChange={onChange} schema={schema} fieldName="opts" required={false} />);
    const alphaCheckbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(alphaCheckbox);
    expect(onChange).toHaveBeenCalledWith(['beta']);
  });

  it('handles undefined value as empty selection', () => {
    render(<MultiSelectWidget value={undefined} onChange={vi.fn()} schema={schema} fieldName="opts" required={false} />);
    const checkboxes = screen.getAllByRole('checkbox');
    checkboxes.forEach((cb) => expect(cb).not.toBeChecked());
  });

  it('does not fire onChange when disabled', () => {
    const onChange = vi.fn();
    render(<MultiSelectWidget value={[]} onChange={onChange} schema={schema} fieldName="opts" required={false} disabled />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders empty message when options array is empty', () => {
    render(<MultiSelectWidget value={[]} onChange={vi.fn()} schema={{ type: 'array', items: { enum: [] } }} fieldName="opts" required={false} />);
    expect(screen.getByText('No options defined')).toBeInTheDocument();
  });
});
