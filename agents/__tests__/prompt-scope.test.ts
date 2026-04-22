/**
 * Regression gate: the workflow-author prompt must never reference stages.X
 * (cross-stage reach-back). The server rejects such templates at save time
 * with a 400, so authoring patterns that use them will always fail.
 *
 * If this test fails, someone added a stages.* example or hint to the prompt —
 * replace it with the correct {{ output.FIELD }} pattern on an outbound edge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = join(__dirname, '..', 'workflow-author', 'prompt.md');

describe('workflow-author prompt — template scope', () => {
  it('does not contain stages. (cross-stage reach-back is forbidden)', () => {
    const content = readFileSync(promptPath, 'utf-8');
    // Allow the one line in the Data Flow Rules section that FORBIDS stages.*
    // by checking that any line containing "stages." is part of a NEVER block.
    const lines = content.split('\n');
    const violations = lines.filter((line) => {
      if (!line.includes('stages.')) return false;
      // Lines in the NEVER block start with "- `{{ stages." — these are allowed
      // because they explicitly call out the forbidden pattern.
      const isForbiddenDeclaration = line.trim().startsWith('- `{{ stages.');
      return !isForbiddenDeclaration;
    });
    expect(violations).toEqual([]);
  });
});
