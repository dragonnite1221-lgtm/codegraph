/**
 * Liquid reference extractors (render/include snippets, section references) +
 * shared context and line helpers. Split out of liquid-extractor.ts to stay
 * within the file-size gate. Each extractor pushes into the shared context's
 * node/edge/reference buffers.
 */

import { Node, Edge, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/** Mutable accumulators + source shared by the Liquid extractors. */
export interface LiquidContext {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
}

/** Get the 1-based line number for a character index. */
export function getLineNumber(source: string, index: number): number {
  const substring = source.substring(0, index);
  return (substring.match(/\n/g) || []).length + 1;
}

/** Get the character index of the start of a line. */
export function getLineStart(source: string, lineNumber: number): number {
  const lines = source.split('\n');
  let index = 0;
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    index += lines[i]!.length + 1; // +1 for newline
  }
  return index;
}

/** Extract {% render 'snippet' %} and {% include 'snippet' %} references. */
export function extractSnippetReferences(ctx: LiquidContext, fileNodeId: string): void {
  const { filePath, source } = ctx;
  // Match {% render 'name' %} or {% include 'name' %} with optional parameters
  const renderRegex = /\{%[-]?\s*(render|include)\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = renderRegex.exec(source)) !== null) {
    const [fullMatch, tagType, snippetName] = match;
    const line = getLineNumber(source, match.index);

    // Create an import node for searchability
    const importNodeId = generateNodeId(filePath, 'import', snippetName!, line);
    const importNode: Node = {
      id: importNodeId,
      kind: 'import',
      name: snippetName!,
      qualifiedName: `${filePath}::import:${snippetName}`,
      filePath,
      language: 'liquid',
      signature: fullMatch,
      startLine: line,
      endLine: line,
      startColumn: match.index - getLineStart(source, line),
      endColumn: match.index - getLineStart(source, line) + fullMatch.length,
      updatedAt: Date.now(),
    };
    ctx.nodes.push(importNode);
    ctx.edges.push({ source: fileNodeId, target: importNodeId, kind: 'contains' });

    // Create a component node for the snippet reference
    const nodeId = generateNodeId(filePath, 'component', `${tagType}:${snippetName}`, line);
    const node: Node = {
      id: nodeId,
      kind: 'component',
      name: snippetName!,
      qualifiedName: `${filePath}::${tagType}:${snippetName}`,
      filePath,
      language: 'liquid',
      startLine: line,
      endLine: line,
      startColumn: match.index - getLineStart(source, line),
      endColumn: match.index - getLineStart(source, line) + fullMatch.length,
      updatedAt: Date.now(),
    };
    ctx.nodes.push(node);
    ctx.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

    // Add unresolved reference to the snippet file
    ctx.unresolvedReferences.push({
      fromNodeId: fileNodeId,
      referenceName: `snippets/${snippetName}.liquid`,
      referenceKind: 'references',
      line,
      column: match.index - getLineStart(source, line),
    });
  }
}

/** Extract {% section 'name' %} references. */
export function extractSectionReferences(ctx: LiquidContext, fileNodeId: string): void {
  const { filePath, source } = ctx;
  // Match {% section 'name' %}
  const sectionRegex = /\{%[-]?\s*section\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = sectionRegex.exec(source)) !== null) {
    const [fullMatch, sectionName] = match;
    const line = getLineNumber(source, match.index);

    // Create an import node for searchability
    const importNodeId = generateNodeId(filePath, 'import', sectionName!, line);
    const importNode: Node = {
      id: importNodeId,
      kind: 'import',
      name: sectionName!,
      qualifiedName: `${filePath}::import:${sectionName}`,
      filePath,
      language: 'liquid',
      signature: fullMatch,
      startLine: line,
      endLine: line,
      startColumn: match.index - getLineStart(source, line),
      endColumn: match.index - getLineStart(source, line) + fullMatch.length,
      updatedAt: Date.now(),
    };
    ctx.nodes.push(importNode);
    ctx.edges.push({ source: fileNodeId, target: importNodeId, kind: 'contains' });

    // Create a component node for the section reference
    const nodeId = generateNodeId(filePath, 'component', `section:${sectionName}`, line);
    const node: Node = {
      id: nodeId,
      kind: 'component',
      name: sectionName!,
      qualifiedName: `${filePath}::section:${sectionName}`,
      filePath,
      language: 'liquid',
      startLine: line,
      endLine: line,
      startColumn: match.index - getLineStart(source, line),
      endColumn: match.index - getLineStart(source, line) + fullMatch.length,
      updatedAt: Date.now(),
    };
    ctx.nodes.push(node);
    ctx.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

    // Add unresolved reference to the section file
    ctx.unresolvedReferences.push({
      fromNodeId: fileNodeId,
      referenceName: `sections/${sectionName}.liquid`,
      referenceKind: 'references',
      line,
      column: match.index - getLineStart(source, line),
    });
  }
}
