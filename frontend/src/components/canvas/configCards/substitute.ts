/**
 * Template substitution for ConfigCard url/snippet templates.
 *
 * Supported variables:
 *   {workflowId}  → current workflow ID
 *   {stageId}     → current stage ID
 *   {apiOrigin}   → browser window.location.origin (or passed value)
 *   {config.FIELD} → value of config[FIELD] (e.g. {config.secret})
 */
export interface SubstituteVars {
  workflowId: string;
  stageId: string;
  apiOrigin: string;
  config?: Record<string, unknown>;
}

export function substituteTemplate(template: string, vars: SubstituteVars): string {
  let result = template;

  result = result.replace(/\{workflowId\}/g, vars.workflowId);
  result = result.replace(/\{stageId\}/g, vars.stageId);
  result = result.replace(/\{apiOrigin\}/g, vars.apiOrigin);

  // Always replace {config.*} tokens — returns empty string if config is not provided or field is absent
  result = result.replace(/\{config\.([^}]+)\}/g, (_match, field: string) => {
    const val = vars.config?.[field];
    return val != null ? String(val) : '';
  });

  return result;
}
