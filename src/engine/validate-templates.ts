/**
 * validate-templates — save-time validation of user-authored template strings and
 * JS eval expressions in a workflow definition.
 *
 * Policy: templates and expressions may only reference:
 *   - `trigger`       — workflow-level payload
 *   - `input`         — data delivered by the inbound edge to this stage
 *   - `output`        — source stage's output (in outbound-edge templates/conditions only)
 *   - `secret('NAME')` — nunjucks global (unchanged)
 *
 * Forbidden patterns (cross-stage reach-back):
 *   - `{{ stages.X.Y }}` / `{{ stages['X'].Y }}`
 *   - `context.stages`, `context[`
 *   - bare `context.` anywhere
 */
import type { WorkflowDefinition, EdgeDefinition, StageDefinition } from '../types/workflow.js';

export interface TemplateValidationError {
  /** Dot-path to the field that contains the violation (e.g. "stages[0].config.message") */
  field: string;
  /** Human-readable description of the problem */
  error: string;
  /** Actionable suggestion for how to fix it */
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Forbidden patterns
// ---------------------------------------------------------------------------

interface ForbiddenPattern {
  regex: RegExp;
  label: string;
  buildSuggestion: (match: RegExpMatchArray, fieldPath: string) => string;
}

const FORBIDDEN_NUNJUCKS: ForbiddenPattern[] = [
  {
    // {{ stages.STAGE_ID.* }}  (dot notation)
    regex: /\{\{[\s\S]*?stages\.(\w[\w-]*)\.([^}]+)\}\}/g,
    label: 'Cross-stage reach-back via stages.<id>',
    buildSuggestion: (match) => {
      const stageId = match[1];
      const rest = match[2]?.trim() ?? '';
      // Try to extract a field name — e.g. "latest.content" → "content"
      const fieldGuess = rest.replace(/^(?:latest|output)\./, '');
      return (
        `Remove "{{ stages.${stageId}.${rest} }}". Cross-stage access is not allowed. ` +
        `Connect '${stageId}' to this stage via an explicit edge, then reference ` +
        `{{ input.${fieldGuess || '<field>'} }} in the incoming edge's prompt_template, ` +
        `or {{ output.${fieldGuess || '<field>'} }} in an outbound-edge template.`
      );
    },
  },
  {
    // {{ stages['STAGE_ID'].* }}  (bracket notation)
    regex: /\{\{[\s\S]*?stages\[['"]([^'"]+)['"]\]\.([^}]+)\}\}/g,
    label: "Cross-stage reach-back via stages['id']",
    buildSuggestion: (match) => {
      const stageId = match[1];
      const rest = match[2]?.trim() ?? '';
      const fieldGuess = rest.replace(/^(?:latest|output)\./, '');
      return (
        `Remove "{{ stages['${stageId}'].${rest} }}". Cross-stage access is not allowed. ` +
        `Connect '${stageId}' to this stage via an explicit edge, then reference ` +
        `{{ input.${fieldGuess || '<field>'} }} in the incoming edge's prompt_template.`
      );
    },
  },
  {
    // {{ context.* }} or {{ context['...'] }}
    regex: /\{\{[\s\S]*?context[\s]*[.[\s]/g,
    label: 'Raw context exposure',
    buildSuggestion: (_match, fieldPath) =>
      `Remove "{{ context.* }}" in ${fieldPath}. Use {{ trigger.<field> }} for trigger payload fields or {{ input.<field> }} for upstream data.`,
  },
];

const FORBIDDEN_JS: ForbiddenPattern[] = [
  {
    // context.stages or context['stages'] or context["stages"]
    regex: /context\.stages|context\[['"]stages['"]\]/g,
    label: 'Cross-stage reach-back via context.stages',
    buildSuggestion: (_match, fieldPath) =>
      `Remove "context.stages" from the expression in ${fieldPath}. Use "input.<field>" for edge-delivered data or "trigger.<field>" for the workflow trigger payload.`,
  },
  {
    // context[ (bracket access on context object)
    regex: /context\[/g,
    label: 'Bracket access on context object',
    buildSuggestion: (_match, fieldPath) =>
      `Remove "context[...]" from the expression in ${fieldPath}. Use "input.<field>" for edge-delivered data or "trigger.<field>" for the workflow trigger payload.`,
  },
  {
    // bare context. (dot access on context — catches anything not already matched above)
    regex: /\bcontext\./g,
    label: 'Direct context object access',
    buildSuggestion: (_match, fieldPath) =>
      `Remove "context." from the expression in ${fieldPath}. Use "input.<field>" for edge-delivered data or "trigger.<field>" for the workflow trigger payload.`,
  },
];

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

function scanNunjucksTemplate(
  template: string,
  fieldPath: string,
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  for (const pattern of FORBIDDEN_NUNJUCKS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpMatchArray | null;
    while ((match = regex.exec(template)) !== null) {
      const suggestion = pattern.buildSuggestion(match, fieldPath);
      errors.push({
        field: fieldPath,
        error: `${pattern.label}: "${match[0].slice(0, 80)}${match[0].length > 80 ? '…' : ''}"`,
        suggestion,
      });
    }
  }

  return errors;
}

function scanJsExpression(
  expression: string,
  fieldPath: string,
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  for (const pattern of FORBIDDEN_JS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpMatchArray | null;
    while ((match = regex.exec(expression)) !== null) {
      const suggestion = pattern.buildSuggestion(match, fieldPath);
      errors.push({
        field: fieldPath,
        error: `${pattern.label}: "${match[0]}"`,
        suggestion,
      });
    }
  }

  // Deduplicate — context. catches context.stages, so avoid double-reporting on same position
  return deduplicateErrors(errors);
}

/**
 * Remove duplicate errors where a more-specific match and a more-general match
 * both fire at the same character offset (e.g. `context.stages` firing both the
 * `context.stages` rule and the bare `context.` rule).
 */
function deduplicateErrors(errors: TemplateValidationError[]): TemplateValidationError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    // key on field + first ~40 chars of the matched snippet
    const key = `${e.field}::${e.error.slice(0, 40)}`;
    // If we've already seen the exact same field + error prefix, skip
    const normalized = key.replace(/context\.\w+/g, 'context.');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Stage + edge walkers
// ---------------------------------------------------------------------------

function validateStage(stage: StageDefinition, index: number): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];
  const prefix = `stages[${index}](${stage.id})`;
  const config = (stage.config ?? {}) as Record<string, unknown>;

  // Fields that hold Nunjucks templates
  const templateFields = ['message', 'prompt_template', 'prompt', 'urlTemplate'];
  for (const field of templateFields) {
    const value = config[field];
    if (typeof value === 'string' && value.length > 0) {
      errors.push(...scanNunjucksTemplate(value, `${prefix}.config.${field}`));
    }
  }

  // Fields that hold JS expressions (format: 'code')
  const codeFields = ['condition', 'code', 'expression'];
  for (const field of codeFields) {
    const value = config[field];
    if (typeof value === 'string' && value.length > 0) {
      errors.push(...scanJsExpression(value, `${prefix}.config.${field}`));
    }
  }

  // Stage-level readme/description (templates may appear there too)
  if (typeof stage.readme === 'string') {
    errors.push(...scanNunjucksTemplate(stage.readme, `${prefix}.readme`));
  }

  return errors;
}

function validateEdge(edge: EdgeDefinition, index: number): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];
  const prefix = `edges[${index}](${edge.id})`;

  if (typeof edge.prompt_template === 'string' && edge.prompt_template.length > 0) {
    errors.push(...scanNunjucksTemplate(edge.prompt_template, `${prefix}.prompt_template`));
  }

  if (typeof edge.condition === 'string' && edge.condition.length > 0) {
    errors.push(...scanJsExpression(edge.condition, `${prefix}.condition`));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate all user-authored templates and JS eval expressions in a workflow definition.
 *
 * Returns an array of validation errors. An empty array means no forbidden patterns
 * were found. Callers should return 400 and not persist if any errors are returned.
 */
export function validateWorkflowTemplates(definition: WorkflowDefinition): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  const stages = definition.stages ?? [];
  const edges = definition.edges ?? [];

  for (let i = 0; i < stages.length; i++) {
    errors.push(...validateStage(stages[i], i));
  }

  for (let i = 0; i < edges.length; i++) {
    errors.push(...validateEdge(edges[i], i));
  }

  return errors;
}
