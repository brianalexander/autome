import nunjucks from 'nunjucks';

export interface TemplateDiagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
}

export function validateTemplate(template: string): TemplateDiagnostic[] {
  const diagnostics: TemplateDiagnostic[] = [];

  // Validate Jinja2 syntax by rendering with empty context.
  // compile() only catches parse errors; renderString() also catches
  // unknown block tags ({% zzzzz %}) which only fail at render time.
  const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });
  try {
    env.renderString(template, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Try to extract line/col from nunjucks error
    // nunjucks errors look like: "(unknown path) [Line 3, Column 5] ..."
    const lineMatch = msg.match(/\[Line (\d+), Column (\d+)\]/);
    if (lineMatch) {
      const line = parseInt(lineMatch[1], 10);
      const col = parseInt(lineMatch[2], 10);
      // Convert line/col to character offset
      const lines = template.split('\n');
      let offset = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      const from = offset + Math.max(0, col - 1);
      const to = Math.min(from + 10, template.length); // highlight a small range
      diagnostics.push({
        from,
        to,
        severity: 'error',
        message: msg.replace(/\(unknown path\)\s*/, ''),
      });
    } else {
      // Can't determine position — highlight the start
      diagnostics.push({
        from: 0,
        to: Math.min(10, template.length),
        severity: 'error',
        message: msg,
      });
    }
  }

  return diagnostics;
}
