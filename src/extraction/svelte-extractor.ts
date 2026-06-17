import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import {
  type SvelteContext,
  SVELTE_RUNES,
  extractScriptBlocks,
  processScriptBlock,
} from './svelte-script';
import { extractTemplateCalls, extractTemplateComponents } from './svelte-template';

/**
 * SvelteExtractor - Extracts code relationships from Svelte component files
 *
 * Svelte files are multi-language (script + template + style). Rather than
 * parsing the full Svelte grammar, we extract the <script> block content
 * and delegate it to the TypeScript/JavaScript TreeSitterExtractor (see
 * svelte-script.ts). Template function calls and component usages are
 * extracted in svelte-template.ts.
 *
 * Every .svelte file produces a component node (Svelte components are always importable).
 */
export class SvelteExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * Extract from Svelte source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create component node for the .svelte file itself
      const componentNode = this.createComponentNode();
      const ctx: SvelteContext = {
        filePath: this.filePath,
        source: this.source,
        nodes: this.nodes,
        edges: this.edges,
        unresolvedReferences: this.unresolvedReferences,
        errors: this.errors,
      };

      // Extract and process script blocks
      const scriptBlocks = extractScriptBlocks(this.source);
      for (const block of scriptBlocks) {
        processScriptBlock(ctx, block, componentNode.id);
      }

      // Extract function calls and component usages from template markup
      extractTemplateCalls(ctx, componentNode.id);
      extractTemplateComponents(ctx, componentNode.id);

      // Filter out Svelte rune calls ($state, $props, $derived, etc.)
      this.unresolvedReferences = this.unresolvedReferences.filter(
        ref => !SVELTE_RUNES.has(ref.referenceName)
      );
    } catch (error) {
      this.errors.push({
        message: `Svelte extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Create a component node for the .svelte file
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.svelte$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'svelte',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Svelte components are always importable
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }
}
