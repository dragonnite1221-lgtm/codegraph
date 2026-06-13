import type { Node } from '../types';

export type NodeStatementParams = {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  isExported: number;
  isAsync: number;
  isStatic: number;
  isAbstract: number;
  decorators: string | null;
  typeParameters: string | null;
  updatedAt: number;
};

export function isNodePersistable(node: Node): boolean {
  return Boolean(node.id && node.kind && node.name && node.filePath && node.language);
}

export function describeNodeRequiredFields(node: Node): Pick<
  Node,
  'id' | 'kind' | 'name' | 'filePath' | 'language'
> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    filePath: node.filePath,
    language: node.language,
  };
}

export function nodeToStatementParams(node: Node): NodeStatementParams {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName ?? node.name,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine ?? 0,
    endLine: node.endLine ?? 0,
    startColumn: node.startColumn ?? 0,
    endColumn: node.endColumn ?? 0,
    docstring: node.docstring ?? null,
    signature: node.signature ?? null,
    visibility: node.visibility ?? null,
    isExported: node.isExported ? 1 : 0,
    isAsync: node.isAsync ? 1 : 0,
    isStatic: node.isStatic ? 1 : 0,
    isAbstract: node.isAbstract ? 1 : 0,
    decorators: node.decorators ? JSON.stringify(node.decorators) : null,
    typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
    updatedAt: node.updatedAt ?? Date.now(),
  };
}
