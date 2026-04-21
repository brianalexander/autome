import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CodeWidget } from '../CodeWidget';

// CodeMirror relies on browser APIs unavailable in jsdom — mock CodeEditor
// so the widget's wrapper structure renders without error.
// Path is relative to this __tests__ file, resolving to canvas/CodeEditor.
vi.mock('../../CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <div data-testid="code-editor">{value}</div>
  ),
}));

const schema = { type: 'string' };

describe('CodeWidget', () => {
  it('renders the editor without a READ ONLY badge when not disabled', () => {
    render(
      <CodeWidget
        value="const x = 1;"
        onChange={vi.fn()}
        schema={schema}
        fieldName="code"
        required={false}
      />,
    );
    expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    expect(screen.queryByText('READ ONLY')).not.toBeInTheDocument();
  });

  it('shows a READ ONLY badge when disabled', () => {
    render(
      <CodeWidget
        value="const x = 1;"
        onChange={vi.fn()}
        schema={schema}
        fieldName="code"
        required={false}
        disabled
      />,
    );
    expect(screen.getByText('READ ONLY')).toBeInTheDocument();
  });

  it('applies opacity-60 and cursor-not-allowed wrapper classes when disabled', () => {
    const { container } = render(
      <CodeWidget
        value="const x = 1;"
        onChange={vi.fn()}
        schema={schema}
        fieldName="code"
        required={false}
        disabled
      />,
    );
    const wrapper = container.querySelector('.opacity-60.cursor-not-allowed');
    expect(wrapper).toBeInTheDocument();
  });

  it('does not apply disabled wrapper classes when editable', () => {
    const { container } = render(
      <CodeWidget
        value="const x = 1;"
        onChange={vi.fn()}
        schema={schema}
        fieldName="code"
        required={false}
      />,
    );
    expect(container.querySelector('.opacity-60')).not.toBeInTheDocument();
    expect(container.querySelector('.cursor-not-allowed')).not.toBeInTheDocument();
  });
});
