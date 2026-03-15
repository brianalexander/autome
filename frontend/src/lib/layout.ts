import ELK from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

const elk = new ELK();

export async function layoutGraph(nodes: Node[], edges: Edge[]): Promise<Node[]> {
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      // DEPTH_FIRST breaks cycles more intelligently than MODEL_ORDER
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      // Center nodes within their layer
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      // Compact the layout horizontally
      'elk.layered.compaction.postCompaction.strategy': 'LEFT',
      // Separate connected components but keep them close
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '80',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: 240,
      height: node.type === 'gate' || node.type?.endsWith('-trigger') ? 60 : 100,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layout = await elk.layout(graph);

  return nodes.map((node) => {
    const layoutNode = layout.children?.find((n) => n.id === node.id);
    if (layoutNode) {
      return {
        ...node,
        position: {
          x: layoutNode.x ?? node.position.x,
          y: layoutNode.y ?? node.position.y,
        },
      };
    }
    return node;
  });
}
