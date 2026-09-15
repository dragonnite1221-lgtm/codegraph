/**
 * Shared test utilities for resolveAndPersistBatched regression tests: node
 * / unresolved-ref record builders and a real-QueryBuilder-backed resolver.
 */
import { QueryBuilder } from '../../src/db/queries';
import type { ResolverApi } from '../../src/resolution/resolution-resolve';
import type { UnresolvedRef, ResolvedRef } from '../../src/resolution/types';
import type { Node, UnresolvedReference } from '../../src/types';

export function nodeRecord(id: string, filePath: string): Node {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  };
}

export function unresolvedRef(fromNodeId: string, referenceName: string): UnresolvedReference {
  return {
    fromNodeId,
    referenceName,
    referenceKind: 'calls',
    line: 1,
    column: 1,
    filePath: 'a.ts',
    language: 'typescript',
  };
}

/** Real ResolverApi: `queries` is a genuine QueryBuilder over a temp SQLite db; only resolveOne (the actual name-matching logic under test elsewhere) is stubbed. */
export function makeResolver(queries: QueryBuilder, unresolvableNames: Set<string>): ResolverApi {
  return {
    queries,
    warmCaches: () => {},
    resolveOne: (ref: UnresolvedRef): ResolvedRef | null => {
      if (unresolvableNames.has(ref.referenceName)) return null;
      return {
        original: ref,
        targetNodeId: 'target',
        confidence: 1,
        resolvedBy: 'exact-match',
      };
    },
    getFilePathFromNodeId: () => 'a.ts',
    getLanguageFromNodeId: () => 'typescript',
  };
}
