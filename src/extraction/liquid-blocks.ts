/**
 * Liquid block extractors: {% schema %} blocks and {% assign %} statements.
 * Split out of liquid-extractor.ts to stay within the file-size gate.
 */

import { Node } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { type LiquidContext, getLineNumber, getLineStart } from './liquid-extractors';

/** Extract {% schema %}...{% endschema %} blocks. */
export function extractSchema(ctx: LiquidContext, fileNodeId: string): void {
  const { filePath, source } = ctx;
  // Match {% schema %}...{% endschema %}
  const schemaRegex = /\{%[-]?\s*schema\s*[-]?%\}([\s\S]*?)\{%[-]?\s*endschema\s*[-]?%\}/g;
  let match;

  while ((match = schemaRegex.exec(source)) !== null) {
    const [fullMatch, schemaContent] = match;
    const startLine = getLineNumber(source, match.index);
    const endLine = getLineNumber(source, match.index + fullMatch.length);

    // Try to parse the schema JSON to get the name
    let schemaName = 'schema';
    try {
      const schemaJson = JSON.parse(schemaContent!);
      if (schemaJson.name) {
        // Shopify schema names can be translation objects like {"en": "...", "fr": "..."}
        schemaName = typeof schemaJson.name === 'string'
          ? schemaJson.name
          : schemaJson.name.en || Object.values(schemaJson.name)[0] as string || 'schema';
      }
    } catch {
      // Schema isn't valid JSON, use default name
    }

    // Create a node for the schema
    const nodeId = generateNodeId(filePath, 'constant', `schema:${schemaName}`, startLine);
    const node: Node = {
      id: nodeId,
      kind: 'constant',
      name: schemaName,
      qualifiedName: `${filePath}::schema:${schemaName}`,
      filePath,
      language: 'liquid',
      startLine,
      endLine,
      startColumn: match.index - getLineStart(source, startLine),
      endColumn: 0,
      docstring: schemaContent?.trim().substring(0, 200), // Store first 200 chars as docstring
      updatedAt: Date.now(),
    };
    ctx.nodes.push(node);
    ctx.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
  }
}

/** Extract {% assign var = value %} statements. */
export function extractAssignments(ctx: LiquidContext, fileNodeId: string): void {
  const { filePath, source } = ctx;
  // Match {% assign variable_name = ... %}
  const assignRegex = /\{%[-]?\s*assign\s+(\w+)\s*=/g;
  let match;

  while ((match = assignRegex.exec(source)) !== null) {
    const [, variableName] = match;
    const line = getLineNumber(source, match.index);

    // Create a variable node
    const nodeId = generateNodeId(filePath, 'variable', variableName!, line);
    const node: Node = {
      id: nodeId,
      kind: 'variable',
      name: variableName!,
      qualifiedName: `${filePath}::${variableName}`,
      filePath,
      language: 'liquid',
      startLine: line,
      endLine: line,
      startColumn: match.index - getLineStart(source, line),
      endColumn: match.index - getLineStart(source, line) + match[0].length,
      updatedAt: Date.now(),
    };
    ctx.nodes.push(node);
    ctx.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
  }
}
