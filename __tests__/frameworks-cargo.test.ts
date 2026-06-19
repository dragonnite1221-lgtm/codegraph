import { describe, it, expect } from 'vitest';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';
import { getApplicableFrameworks } from '../src/resolution/frameworks';
import { djangoResolver, flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python';
import { expressResolver } from '../src/resolution/frameworks/express';
import { laravelResolver } from '../src/resolution/frameworks/laravel';
import { railsResolver } from '../src/resolution/frameworks/ruby';
import { springResolver } from '../src/resolution/frameworks/java';
import { goResolver } from '../src/resolution/frameworks/go';
import { rustResolver } from '../src/resolution/frameworks/rust';
import { aspnetResolver } from '../src/resolution/frameworks/csharp';
import { vaporResolver } from '../src/resolution/frameworks/swift';
import { reactResolver } from '../src/resolution/frameworks/react';
import { svelteResolver } from '../src/resolution/frameworks/svelte';

describe('rustResolver.resolve cargo workspace crates', () => {
  it('resolves crate name from workspace member lib.rs', () => {
    const workspaceCargo = `
[workspace]
members = ["crates/mytool-core", "crates/mytool-fetcher"]
`;
    const coreCargo = `
[package]
name = "mytool-core"
version = "0.1.0"
`;
    const libNode: Node = {
      id: 'module:crates/mytool-core/src/lib.rs:mytool_core:1',
      kind: 'module',
      name: 'mytool_core',
      qualifiedName: 'crates/mytool-core/src/lib.rs::mytool_core',
      filePath: 'crates/mytool-core/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const context = {
      getNodesInFile: (fp: string) => (fp === 'crates/mytool-core/src/lib.rs' ? [libNode] : []),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        p === 'Cargo.toml' ||
        p === 'crates/mytool-core/Cargo.toml' ||
        p === 'crates/mytool-core/src/lib.rs'
      ),
      readFile: (p: string) => {
        if (p === 'Cargo.toml') return workspaceCargo;
        if (p === 'crates/mytool-core/Cargo.toml') return coreCargo;
        return null;
      },
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        'crates/mytool-core/Cargo.toml',
        'crates/mytool-core/src/lib.rs',
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'fn:crates/mytool-fetcher/src/main.rs:main:1',
      referenceName: 'mytool_core',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-fetcher/src/main.rs',
      language: 'rust' as const,
    };

    const result = rustResolver.resolve(ref, context);
    expect(result?.targetNodeId).toBe(libNode.id);
    expect(result?.resolvedBy).toBe('framework');
    // Workspace-manifest hits are unambiguous and must beat name-matcher's
    // self-file matches (0.7) so cross-crate `imports` edges materialize.
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('resolves crate name from workspace member main.rs when lib.rs is absent', () => {
    const workspaceCargo = `
[workspace]
members = [
  "crates/mytool-runner",
]
`;
    const runnerCargo = `
[package]
name = "mytool-runner"
version = "0.1.0"
`;
    const mainNode: Node = {
      id: 'module:crates/mytool-runner/src/main.rs:mytool_runner:1',
      kind: 'module',
      name: 'mytool_runner',
      qualifiedName: 'crates/mytool-runner/src/main.rs::mytool_runner',
      filePath: 'crates/mytool-runner/src/main.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const context = {
      getNodesInFile: (fp: string) => (fp === 'crates/mytool-runner/src/main.rs' ? [mainNode] : []),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        p === 'Cargo.toml' ||
        p === 'crates/mytool-runner/Cargo.toml' ||
        p === 'crates/mytool-runner/src/main.rs'
      ),
      readFile: (p: string) => {
        if (p === 'Cargo.toml') return workspaceCargo;
        if (p === 'crates/mytool-runner/Cargo.toml') return runnerCargo;
        return null;
      },
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        'crates/mytool-runner/Cargo.toml',
        'crates/mytool-runner/src/main.rs',
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'fn:crates/mytool-runner/src/main.rs:main:1',
      referenceName: 'mytool_runner',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-runner/src/main.rs',
      language: 'rust' as const,
    };

    const result = rustResolver.resolve(ref, context);
    expect(result?.targetNodeId).toBe(mainNode.id);
    expect(result?.resolvedBy).toBe('framework');
  });

});
