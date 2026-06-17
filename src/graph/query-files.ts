/**
 * File-oriented graph queries for GraphQueryManager (dependencies, dependents,
 * exports, module structure, circular dependencies). Split out to stay within
 * the file-size gate. Free functions taking the QueryBuilder.
 */

import { Node } from '../types';
import { QueryBuilder } from '../db/queries';

/**
 * Get dependencies of a file — all files this file imports from.
 */
export function getFileDependencies(queries: QueryBuilder, filePath: string): string[] {
  const nodes = queries.getNodesByFile(filePath);
  const fileNode = nodes.find((n) => n.kind === 'file');

  if (!fileNode) {
    return [];
  }

  const dependencies = new Set<string>();
  const importEdges = queries.getOutgoingEdges(fileNode.id, ['imports']);

  for (const edge of importEdges) {
    const targetNode = queries.getNodeById(edge.target);
    if (targetNode && targetNode.filePath !== filePath) {
      dependencies.add(targetNode.filePath);
    }
  }

  return Array.from(dependencies);
}

/**
 * Get dependents of a file — all files that import from this file.
 */
export function getFileDependents(queries: QueryBuilder, filePath: string): string[] {
  const nodes = queries.getNodesByFile(filePath);
  const dependents = new Set<string>();

  // Check file-level incoming import edges (file:X imports file:Y)
  const fileNode = nodes.find((n) => n.kind === 'file');
  if (fileNode) {
    const incomingFileEdges = queries.getIncomingEdges(fileNode.id, ['imports']);
    for (const edge of incomingFileEdges) {
      const sourceNode = queries.getNodeById(edge.source);
      if (sourceNode && sourceNode.filePath !== filePath) {
        dependents.add(sourceNode.filePath);
      }
    }
  }

  // Also check node-level imports of exported symbols
  for (const node of nodes) {
    if (node.isExported) {
      const incomingEdges = queries.getIncomingEdges(node.id, ['imports']);
      for (const edge of incomingEdges) {
        const sourceNode = queries.getNodeById(edge.source);
        if (sourceNode && sourceNode.filePath !== filePath) {
          dependents.add(sourceNode.filePath);
        }
      }
    }
  }

  return Array.from(dependents);
}

/**
 * Get all symbols exported by a file.
 */
export function getExportedSymbols(queries: QueryBuilder, filePath: string): Node[] {
  const nodes = queries.getNodesByFile(filePath);
  return nodes.filter((n) => n.isExported);
}

/**
 * Get the module/package structure: a map of directory paths to contained files.
 */
export function getModuleStructure(queries: QueryBuilder): Map<string, string[]> {
  const files = queries.getAllFiles();
  const structure = new Map<string, string[]>();

  for (const file of files) {
    const parts = file.path.split('/');
    const dir = parts.slice(0, -1).join('/') || '.';

    if (!structure.has(dir)) {
      structure.set(dir, []);
    }
    structure.get(dir)!.push(file.path);
  }

  return structure;
}

/**
 * Find circular dependencies in the graph. Each cycle is an array of file paths.
 */
export function findCircularDependencies(queries: QueryBuilder): string[][] {
  const files = queries.getAllFiles();
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const dfs = (filePath: string, path: string[]): void => {
    if (recursionStack.has(filePath)) {
      // Found a cycle
      const cycleStart = path.indexOf(filePath);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }

    if (visited.has(filePath)) {
      return;
    }

    visited.add(filePath);
    recursionStack.add(filePath);

    const dependencies = getFileDependencies(queries, filePath);
    for (const dep of dependencies) {
      dfs(dep, [...path, filePath]);
    }

    recursionStack.delete(filePath);
  };

  for (const file of files) {
    if (!visited.has(file.path)) {
      dfs(file.path, []);
    }
  }

  return cycles;
}
