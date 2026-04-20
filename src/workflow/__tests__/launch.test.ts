import { describe, it, expect } from 'vitest';
import { computeDisplaySummary } from '../launch.js';
import type { WorkflowDefinition } from '../../schemas/pipeline.js';
import type { Event } from '../../types/events.js';

function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
    ...overrides,
  };
}

function makeEvent(payload: Record<string, unknown>): Event {
  return {
    type: 'trigger',
    provider: 'manual',
    payload,
  } as Event;
}

describe('computeDisplaySummary', () => {
  describe('prompt-trigger branch', () => {
    const triggerStage = { type: 'prompt-trigger' };

    it('returns trimmed prompt text up to 80 chars', () => {
      const event = makeEvent({ prompt: 'Summarize this article for me' });
      const result = computeDisplaySummary(triggerStage, makeWorkflow(), event);
      expect(result).toBe('Summarize this article for me');
    });

    it('truncates prompt at 80 chars', () => {
      const longPrompt = 'A'.repeat(100);
      const event = makeEvent({ prompt: longPrompt });
      const result = computeDisplaySummary(triggerStage, makeWorkflow(), event);
      expect(result).toBe('A'.repeat(80));
    });

    it('collapses whitespace in prompt', () => {
      const event = makeEvent({ prompt: '  Hello   world  ' });
      const result = computeDisplaySummary(triggerStage, makeWorkflow(), event);
      expect(result).toBe('Hello world');
    });

    it('falls through to default when prompt is missing', () => {
      const event = makeEvent({});
      const result = computeDisplaySummary(triggerStage, makeWorkflow(), event);
      // Should fall through to default since no prompt — starts with "prompt · "
      expect(result).toMatch(/^prompt · /);
    });
  });

  describe('instance_summary_template branch', () => {
    const triggerStage = { type: 'manual-trigger' };

    it('renders template against trigger payload', () => {
      const workflow = makeWorkflow({
        instance_summary_template: 'PR #{{ output.pr_number }}: {{ output.title }}',
      } as Partial<WorkflowDefinition>);
      const event = makeEvent({ pr_number: 42, title: 'Fix the bug' });
      const result = computeDisplaySummary(triggerStage, workflow, event);
      expect(result).toBe('PR #42: Fix the bug');
    });

    it('does not throw on render errors', () => {
      const workflow = makeWorkflow({
        instance_summary_template: '{% invalid jinja %}',
      } as Partial<WorkflowDefinition>);
      const event = makeEvent({});
      // resolveTemplate internally catches nunjucks errors and falls back
      // to simple interpolation — it should not throw from computeDisplaySummary.
      expect(() => computeDisplaySummary(triggerStage, workflow, event)).not.toThrow();
    });

    it('falls through to default when template renders empty string', () => {
      // Template that produces only whitespace
      const workflow = makeWorkflow({
        instance_summary_template: '   ',
      } as Partial<WorkflowDefinition>);
      const event = makeEvent({});
      const result = computeDisplaySummary(triggerStage, workflow, event);
      expect(result).toMatch(/^manual · /);
    });
  });

  describe('default fallback branch', () => {
    it('uses trigger provider name and timestamp format', () => {
      const triggerStage = { type: 'manual-trigger' };
      const workflow = makeWorkflow();
      const event = makeEvent({});
      const result = computeDisplaySummary(triggerStage, workflow, event);
      // Format: "manual · YYYY-MM-DD HH:mm"
      expect(result).toMatch(/^manual · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('uses webhook as provider name for webhook-trigger', () => {
      const triggerStage = { type: 'webhook-trigger' };
      const workflow = makeWorkflow();
      const event = makeEvent({});
      const result = computeDisplaySummary(triggerStage, workflow, event);
      expect(result).toMatch(/^webhook · /);
    });

    it('handles undefined triggerStage', () => {
      const workflow = makeWorkflow();
      const event = makeEvent({});
      const result = computeDisplaySummary(undefined, workflow, event);
      // Falls back to "manual · ..." since provider is "manual"
      expect(result).toMatch(/^manual · /);
    });
  });
});
