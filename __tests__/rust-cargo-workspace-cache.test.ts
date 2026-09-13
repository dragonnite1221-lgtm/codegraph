import { describe, expect, it } from 'vitest';

import { resolveModule, resetCargoWorkspaceCache } from '../src/resolution/frameworks/rust-resolve';
import type { Node, ResolutionContext } from '../src/resolution/types';

/**
 * Regression: `resolveModule`'s Cargo workspace crate map is cached in a
 * module-level `WeakMap<ResolutionContext, ...>`. Since a `ReferenceResolver`
 * keeps the same `ResolutionContext` object for its whole lifetime, this
 * cache would otherwise survive a force-reindex on a reused CodeGraph
 * instance forever -- resolveModule() must pick up a changed Cargo.toml
 * workspace member list once `resetCargoWorkspaceCache` is called for that
 * context (wired into ReferenceResolver.clearCaches()).
 */

function makeNode(id: string, filePath: string): Node {
  return {
    id,
    kind: 'module',
    name: id,
    qualifiedName: id,
    filePath,
    language: 'rust',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  };
}

function makeContext(files: Record<string, string>, nodesByFile: Record<string, Node[]>): ResolutionContext {
  return {
    getNodesInFile: (filePath) => nodesByFile[filePath] ?? [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (filePath) => filePath in files,
    readFile: (filePath) => files[filePath] ?? null,
    getProjectRoot: () => '/project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };
}

describe('Cargo workspace crate map cache', () => {
  it('resolves a workspace member added after the context was already cached', () => {
    const files: Record<string, string> = {
      'Cargo.toml': `[workspace]\nmembers = ["crates/old"]\n`,
      'crates/old/Cargo.toml': `[package]\nname = "old_crate"\n`,
      'crates/old/src/lib.rs': 'pub fn old() {}\n',
    };
    const nodesByFile: Record<string, Node[]> = {
      'crates/old/src/lib.rs': [makeNode('old-mod', 'crates/old/src/lib.rs')],
    };
    const context = makeContext(files, nodesByFile);

    const first = resolveModule('old_crate', context);
    expect(first?.fromWorkspace).toBe(true);
    expect(first?.targetId).toBe('old-mod');

    // Cargo.toml now points at a different (renamed) member crate. Without
    // invalidation, the cache keyed on this same `context` object would
    // still report the old crate map and fail to resolve the new one.
    files['Cargo.toml'] = `[workspace]\nmembers = ["crates/new"]\n`;
    files['crates/new/Cargo.toml'] = `[package]\nname = "new_crate"\n`;
    files['crates/new/src/lib.rs'] = 'pub fn new_fn() {}\n';
    nodesByFile['crates/new/src/lib.rs'] = [makeNode('new-mod', 'crates/new/src/lib.rs')];

    expect(resolveModule('new_crate', context)).toBeNull(); // still cached, stale

    resetCargoWorkspaceCache(context);

    const afterReset = resolveModule('new_crate', context);
    expect(afterReset?.fromWorkspace).toBe(true);
    expect(afterReset?.targetId).toBe('new-mod');
  });
});
