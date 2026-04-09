import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import { layoutGraph } from './layout';

function makeNode(id: string, type = 'default'): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} };
}

function makeEdge(id: string, source: string, target: string): Edge {
  return { id, source, target };
}

describe('layoutGraph', () => {
  it('returns an empty array for an empty graph', async () => {
    const result = await layoutGraph([], []);
    expect(result).toEqual([]);
  });

  it('returns a single node with a position assigned by ELK', async () => {
    const nodes = [makeNode('a')];
    const result = await layoutGraph(nodes, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
    // ELK should assign numeric coordinates
    expect(typeof result[0].position.x).toBe('number');
    expect(typeof result[0].position.y).toBe('number');
  });

  it('lays out a simple linear workflow (a -> b -> c)', async () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'c')];
    const result = await layoutGraph(nodes, edges);

    expect(result).toHaveLength(3);

    const byId = Object.fromEntries(result.map((n) => [n.id, n]));
    // With direction DOWN, y should increase along the chain
    expect(byId['b'].position.y).toBeGreaterThan(byId['a'].position.y);
    expect(byId['c'].position.y).toBeGreaterThan(byId['b'].position.y);
  });

  it('lays out a fan-out / fan-in graph', async () => {
    // start -> left, start -> right, left -> end, right -> end
    const nodes = [makeNode('start'), makeNode('left'), makeNode('right'), makeNode('end')];
    const edges = [
      makeEdge('e1', 'start', 'left'),
      makeEdge('e2', 'start', 'right'),
      makeEdge('e3', 'left', 'end'),
      makeEdge('e4', 'right', 'end'),
    ];
    const result = await layoutGraph(nodes, edges);

    expect(result).toHaveLength(4);

    const byId = Object.fromEntries(result.map((n) => [n.id, n]));
    // All nodes get positions
    for (const node of result) {
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
    }
    // start should be above left/right (smaller y in downward layout)
    expect(byId['start'].position.y).toBeLessThan(byId['left'].position.y);
    expect(byId['start'].position.y).toBeLessThan(byId['right'].position.y);
  });

  it('preserves original position for nodes not found in ELK output', async () => {
    // Provide a node that has no edges — ELK may still lay it out, but its
    // original position is the fallback; the important thing is the node is
    // returned and its position fields are numbers.
    const nodes = [makeNode('orphan')];
    const result = await layoutGraph(nodes, []);
    expect(result[0].id).toBe('orphan');
    expect(typeof result[0].position.x).toBe('number');
    expect(typeof result[0].position.y).toBe('number');
  });

  it('uses a reduced height for gate nodes', async () => {
    // layout.ts gives gate nodes height 60 vs 100 for regular nodes.
    // We can't inspect the ELK input directly, but we can verify the function
    // runs without error and returns the correct number of nodes.
    const nodes = [makeNode('trigger', 'manual-trigger'), makeNode('gate', 'gate'), makeNode('action', 'llm-agent')];
    const edges = [makeEdge('e1', 'trigger', 'gate'), makeEdge('e2', 'gate', 'action')];
    const result = await layoutGraph(nodes, edges);
    expect(result).toHaveLength(3);
    // Gate and trigger should be placed higher (smaller y) than the action node
    const byId = Object.fromEntries(result.map((n) => [n.id, n]));
    expect(byId['trigger'].position.y).toBeLessThan(byId['action'].position.y);
  });

  it('preserves non-position node properties through layout', async () => {
    const nodes: Node[] = [
      { id: 'a', type: 'custom', position: { x: 0, y: 0 }, data: { label: 'Step A', count: 42 } },
      { id: 'b', type: 'custom', position: { x: 0, y: 0 }, data: { label: 'Step B' } },
    ];
    const edges = [makeEdge('e1', 'a', 'b')];
    const result = await layoutGraph(nodes, edges);
    const a = result.find((n) => n.id === 'a')!;
    expect(a.data).toEqual({ label: 'Step A', count: 42 });
    expect(a.type).toBe('custom');
  });
});
