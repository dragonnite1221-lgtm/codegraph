/**
 * PR19 improvements: lazy grammar loading + arrow-function body traversal.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractFromSource } from '../src/extraction';
import {
  getParser, isLanguageSupported, getSupportedLanguages, clearParserCache,
  getUnavailableGrammarErrors, initGrammars, loadAllGrammars,
} from '../src/extraction/grammars';
import { createTempDir, cleanupTempDir, hasSqliteBindings, HAS_SQLITE } from './pr19-helpers';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Lazy Grammar Loading', () => {
  afterEach(() => {
    clearParserCache();
  });

  it('should load grammars lazily on first use', () => {
    // Clear cache to force fresh load
    clearParserCache();

    // TypeScript should be loadable
    const parser = getParser('typescript');
    expect(parser).not.toBeNull();
  });

  it('should cache loaded grammars', () => {
    clearParserCache();

    const parser1 = getParser('typescript');
    const parser2 = getParser('typescript');

    // Same reference from cache
    expect(parser1).toBe(parser2);
  });

  it('should return null for unknown language', () => {
    const parser = getParser('unknown');
    expect(parser).toBeNull();
  });

  it('should handle unavailable grammars gracefully', () => {
    // 'unknown' is not a valid grammar, should not crash
    expect(isLanguageSupported('unknown')).toBe(false);
  });

  it('should report liquid as supported (custom extractor)', () => {
    expect(isLanguageSupported('liquid')).toBe(true);
  });

  it('should include liquid in supported languages', () => {
    const supported = getSupportedLanguages();
    expect(supported).toContain('liquid');
  });

  it('should return unavailable grammar errors as a record', () => {
    clearParserCache();
    const errors = getUnavailableGrammarErrors();
    // Should be a plain object (may or may not have entries depending on platform)
    expect(typeof errors).toBe('object');
  });

  it('should support multiple languages independently', () => {
    clearParserCache();

    // Load two different languages - one failing shouldn't affect the other
    const tsParser = getParser('typescript');
    const pyParser = getParser('python');

    expect(tsParser).not.toBeNull();
    expect(pyParser).not.toBeNull();
    expect(tsParser).not.toBe(pyParser);
  });

  it('should clear all caches on clearParserCache', () => {
    // Load a grammar
    getParser('typescript');

    // Clear
    clearParserCache();

    // Errors should be cleared too
    const errors = getUnavailableGrammarErrors();
    expect(Object.keys(errors)).toHaveLength(0);
  });
});

// =============================================================================
// Arrow Function Extraction - Body Traversal
// =============================================================================

describe('Arrow Function Body Traversal', () => {
  it('should extract unresolved references from arrow function bodies', () => {
    const code = `
export const useAuth = () => {
  const user = getUser();
  const token = generateToken(user);
  return { user, token };
};
`;
    const result = extractFromSource('hooks.ts', code);

    // The arrow function should be extracted
    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
    expect(funcNode).toBeDefined();

    // Calls inside the body should be captured as unresolved references
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('getUser');
    expect(callNames).toContain('generateToken');
  });

  it('should extract unresolved references from function expression bodies', () => {
    const code = `
export const processData = function(input: string): string {
  const cleaned = sanitize(input);
  return transform(cleaned);
};
`;
    const result = extractFromSource('utils.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
    expect(funcNode).toBeDefined();

    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('sanitize');
    expect(callNames).toContain('transform');
  });

  it('should not create duplicate nodes for arrow functions', () => {
    const code = `
export const handler = () => {
  doSomething();
};
`;
    const result = extractFromSource('handler.ts', code);

    // Should be exactly 1 function node, 0 variable nodes for 'handler'
    const funcNodes = result.nodes.filter((n) => n.name === 'handler' && n.kind === 'function');
    const varNodes = result.nodes.filter((n) => n.name === 'handler' && n.kind === 'variable');
    expect(funcNodes).toHaveLength(1);
    expect(varNodes).toHaveLength(0);
  });

  it('should extract nested calls in arrow functions in JavaScript', () => {
    const code = `
export const fetchData = async () => {
  const response = await fetchAPI('/data');
  return parseResponse(response);
};
`;
    const result = extractFromSource('api.js', code);

    const funcNode = result.nodes.find((n) => n.name === 'fetchData');
    expect(funcNode).toBeDefined();
    expect(funcNode?.kind).toBe('function');

    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('fetchAPI');
    expect(callNames).toContain('parseResponse');
  });
});

// =============================================================================
// Graph Traversal 'both' Direction Fix
// (requires better-sqlite3 - will use CodeGraph integration)
// =============================================================================

