/**
 * Check if adding edge (from → to) would create a cycle in the graph.
 * Also usable as `canReach(to, from, edges)` to check reachability.
 */
export function canReach(from: string, to: string, edges: Array<{ source: string; target: string }>): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const visited = new Set<string>();
  function dfs(node: string): boolean {
    if (node === to) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    for (const next of adj.get(node) || []) {
      if (dfs(next)) return true;
    }
    return false;
  }
  return dfs(from);
}

/**
 * Check if a stage is part of any cycle in the graph.
 */
export function stageIsInCycle(stageId: string, edges: Array<{ source: string; target: string }>): boolean {
  return canReach(stageId, stageId, edges);
}
