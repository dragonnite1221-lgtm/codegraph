/**
 * Parse-and-extract driver for TreeSitterExtractor: language/parser guards,
 * the file node, the root walk, and WASM tree cleanup. Split out of
 * tree-sitter.ts to stay within the file-size gate.
 */

import * as path from 'path';
import type { Node, ExtractionResult } from '../types';
import { getParser, isLanguageSupported } from './grammars';
import type { TreeSitterExtractor } from './tree-sitter';

/** Parse and extract from the source code. */
export function extract(self: TreeSitterExtractor): ExtractionResult {
  const startTime = Date.now();

  if (!isLanguageSupported(self.language)) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `Unsupported language: ${self.language}`,
          filePath: self.filePath,
          severity: 'error',
          code: 'unsupported_language',
        },
      ],
      durationMs: Date.now() - startTime,
    };
  }

  const parser = getParser(self.language);
  if (!parser) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `Failed to get parser for language: ${self.language}`,
          filePath: self.filePath,
          severity: 'error',
          code: 'parser_error',
        },
      ],
      durationMs: Date.now() - startTime,
    };
  }

  try {
    self.tree = parser.parse(self.source) ?? null;
    if (!self.tree) {
      throw new Error('Parser returned null tree');
    }

    // Create file node representing the source file
    const fileNode: Node = {
      id: `file:${self.filePath}`,
      kind: 'file',
      name: path.basename(self.filePath),
      qualifiedName: self.filePath,
      filePath: self.filePath,
      language: self.language,
      startLine: 1,
      endLine: self.source.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    self.nodes.push(fileNode);

    // Push file node onto stack so top-level declarations get contains edges
    self.nodeStack.push(fileNode.id);
    self.visitNode(self.tree.rootNode);
    self.nodeStack.pop();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // WASM memory errors leave the module in a corrupted state — all subsequent
    // parses would also fail. Re-throw so the worker can detect and crash,
    // forcing a clean restart with a fresh heap.
    if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
      throw error;
    }

    self.errors.push({
      message: `Parse error: ${msg}`,
      filePath: self.filePath,
      severity: 'error',
      code: 'parse_error',
    });
  } finally {
    // Free tree-sitter WASM memory immediately — trees hold native heap memory
    // invisible to V8's GC that accumulates across thousands of files.
    if (self.tree) {
      self.tree.delete();
      self.tree = null;
    }
    // Release source string to reduce GC pressure
    self.source = '';
  }

  return {
    nodes: self.nodes,
    edges: self.edges,
    unresolvedReferences: self.unresolvedReferences,
    errors: self.errors,
    durationMs: Date.now() - startTime,
  };
}
