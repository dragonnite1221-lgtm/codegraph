/**
 * Edge builder
 *
 * Converts resolved references into graph edges, promoting edge kinds where
 * resolution reveals more specific semantics (extends→implements when the
 * target is an interface, calls→instantiates when the target is a class).
 */

import type { Edge } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolvedRef } from './types';

export function buildResolvedEdges(queries: QueryBuilder, resolved: ResolvedRef[]): Edge[] {
  return resolved.map((ref) => {
    let kind = ref.original.referenceKind;

    // Promote "extends" to "implements" when a class/struct targets an interface
    if (kind === 'extends') {
      const targetNode = queries.getNodeById(ref.targetNodeId);
      if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
        const sourceNode = queries.getNodeById(ref.original.fromNodeId);
        if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
          kind = 'implements';
        }
      }
    }

    // Promote "calls" to "instantiates" when the resolved target is a
    // class/struct. Languages without a `new` keyword (Python, Ruby)
    // express instantiation as `Foo()` — extraction can't tell that
    // apart from a function call without symbol info, but resolution
    // can: if `Foo` resolves to a class, the call IS an instantiation.
    if (kind === 'calls') {
      const targetNode = queries.getNodeById(ref.targetNodeId);
      if (targetNode && (targetNode.kind === 'class' || targetNode.kind === 'struct')) {
        kind = 'instantiates';
      }
    }

    return {
      source: ref.original.fromNodeId,
      target: ref.targetNodeId,
      kind,
      line: ref.original.line,
      column: ref.original.column,
      metadata: {
        confidence: ref.confidence,
        resolvedBy: ref.resolvedBy,
      },
    };
  });
}
