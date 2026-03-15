/**
 * StreamingMarkdown — Renders markdown content with proper formatting.
 * During streaming, shows a pulsing cursor at the end.
 *
 * Handles narrow panels gracefully:
 * - Code blocks: horizontal scroll within their own container
 * - Tables: wrapped in a scrollable div
 * - Inline code: word-breaks to avoid overflow
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface StreamingMarkdownProps {
  content: string;
  isStreaming?: boolean;
}

type PreProps = JSX.IntrinsicElements['pre'] & ExtraProps;
type CodeProps = JSX.IntrinsicElements['code'] & ExtraProps;
type TableProps = JSX.IntrinsicElements['table'] & ExtraProps;
type ThProps = JSX.IntrinsicElements['th'] & ExtraProps;
type TdProps = JSX.IntrinsicElements['td'] & ExtraProps;

// Custom renderers for overflow-safe elements
const components = {
  // Code blocks get their own horizontal scroll
  pre: ({ children, node: _node, ...props }: PreProps) => (
    <pre
      {...props}
      className="bg-surface-secondary border border-border rounded-lg my-2 p-3 overflow-x-auto text-xs leading-relaxed"
      style={{ maxWidth: '100%' }}
    >
      {children}
    </pre>
  ),
  // Inline code wraps instead of overflowing
  code: ({ children, className, node: _node, ...props }: CodeProps) => {
    // If it has a className like "language-*", it's inside a <pre> — don't double-style
    if (className) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="text-blue-600 dark:text-blue-300 bg-surface-tertiary px-1 py-0.5 rounded text-xs break-all"
        {...props}
      >
        {children}
      </code>
    );
  },
  // Tables get their own horizontal scroll container
  table: ({ children, node: _node, ...props }: TableProps) => (
    <div className="overflow-x-auto my-2 rounded-lg border border-border" style={{ maxWidth: '100%' }}>
      <table {...props} className="min-w-full text-xs border-collapse">
        {children}
      </table>
    </div>
  ),
  th: ({ children, node: _node, ...props }: ThProps) => (
    <th
      {...props}
      className="bg-surface-tertiary px-3 py-1.5 text-left text-text-primary font-medium border-b border-border-subtle whitespace-nowrap"
    >
      {children}
    </th>
  ),
  td: ({ children, node: _node, ...props }: TdProps) => (
    <td {...props} className="px-3 py-1.5 text-text-secondary border-b border-border/50 whitespace-nowrap">
      {children}
    </td>
  ),
};

export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  content,
  isStreaming,
}: StreamingMarkdownProps) {
  return (
    <div
      className="text-xs text-text-primary leading-snug prose prose-xs max-w-none overflow-hidden
      dark:prose-invert
      [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
      prose-p:my-0.5 prose-headings:my-1 prose-headings:text-text-primary
      prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0
      prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
      prose-strong:text-text-primary prose-em:text-text-primary
      prose-blockquote:border-border-subtle prose-blockquote:text-text-secondary
      prose-hr:border-border
    "
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
      {isStreaming && <span className="animate-blink text-blue-400 ml-0.5 inline-block font-light">|</span>}
    </div>
  );
});
