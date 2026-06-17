/**
 * Svelte <script> block handling: detection/extraction and delegation to the
 * TreeSitterExtractor with line-offset fixups. Split out of svelte-extractor.ts
 * to stay within the file-size gate.
 */

import { Node, Edge, ExtractionError, UnresolvedReference, Language } from '../types';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/** Svelte 5 rune names — compiler builtins, not real functions */
export const SVELTE_RUNES = new Set([
  '$props', '$state', '$derived', '$effect', '$bindable',
  '$inspect', '$host', '$snippet',
]);

/** Mutable accumulators + source shared by the Svelte extractors. */
export interface SvelteContext {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
}

export interface SvelteScriptBlock {
  content: string;
  startLine: number;
  isModule: boolean;
  isTypeScript: boolean;
}

/** Extract <script> blocks from the Svelte source. */
export function extractScriptBlocks(source: string): SvelteScriptBlock[] {
  const blocks: SvelteScriptBlock[] = [];

  const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
  let match;

  while ((match = scriptRegex.exec(source)) !== null) {
    const attrs = match[1] || '';
    const content = match.groups?.content || match[2] || '';

    // Detect TypeScript from lang attribute
    const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

    // Detect module script
    const isModule = /context\s*=\s*["']module["']/.test(attrs);

    // Calculate start line of the script content (line after <script>)
    const beforeScript = source.substring(0, match.index);
    const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
    // The content starts on the line after the opening <script> tag
    const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
    const openingTagLines = (openingTag.match(/\n/g) || []).length;
    const contentStartLine = scriptTagLine + openingTagLines + 1; // 0-indexed line

    blocks.push({ content, startLine: contentStartLine, isModule, isTypeScript });
  }

  return blocks;
}

/** Process a script block by delegating to TreeSitterExtractor. */
export function processScriptBlock(
  ctx: SvelteContext,
  block: SvelteScriptBlock,
  componentNodeId: string
): void {
  const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

  // Check if the script language parser is available
  if (!isLanguageSupported(scriptLanguage)) {
    ctx.errors.push({
      message: `Parser for ${scriptLanguage} not available, cannot parse Svelte script block`,
      severity: 'warning',
    });
    return;
  }

  // Delegate to TreeSitterExtractor
  const extractor = new TreeSitterExtractor(ctx.filePath, block.content, scriptLanguage);
  const result = extractor.extract();

  // Offset line numbers from script block back to .svelte file positions
  for (const node of result.nodes) {
    node.startLine += block.startLine;
    node.endLine += block.startLine;
    node.language = 'svelte'; // Mark as svelte, not TS/JS

    ctx.nodes.push(node);
    ctx.edges.push({ source: componentNodeId, target: node.id, kind: 'contains' });
  }

  // Offset edges (they reference line numbers)
  for (const edge of result.edges) {
    if (edge.line) {
      edge.line += block.startLine;
    }
    ctx.edges.push(edge);
  }

  // Offset unresolved references
  for (const ref of result.unresolvedReferences) {
    ref.line += block.startLine;
    ref.filePath = ctx.filePath;
    ref.language = 'svelte';
    ctx.unresolvedReferences.push(ref);
  }

  // Carry over errors
  for (const error of result.errors) {
    if (error.line) {
      error.line += block.startLine;
    }
    ctx.errors.push(error);
  }
}
