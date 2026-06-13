import type { Node } from '../types';

export class NodeCache {
  private nodes = new Map<string, Node>();

  constructor(private readonly maxSize = 1000) {}

  get(id: string): Node | undefined {
    const cached = this.nodes.get(id);
    if (!cached) return undefined;

    // Move to the end to preserve LRU eviction order.
    this.nodes.delete(id);
    this.nodes.set(id, cached);
    return cached;
  }

  set(node: Node): void {
    if (this.nodes.delete(node.id)) {
      this.nodes.set(node.id, node);
      return;
    }

    if (this.nodes.size >= this.maxSize) {
      const first = this.nodes.keys().next();
      if (!first.done) {
        this.nodes.delete(first.value);
      }
    }
    this.nodes.set(node.id, node);
  }

  delete(id: string): void {
    this.nodes.delete(id);
  }

  deleteByFile(filePath: string): void {
    for (const [id, node] of this.nodes) {
      if (node.filePath === filePath) {
        this.nodes.delete(id);
      }
    }
  }

  clear(): void {
    this.nodes.clear();
  }
}
