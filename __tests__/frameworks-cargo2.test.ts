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

describe('rustResolver.resolve cargo workspace crates (globs)', () => {
  it('resolves crate name when members uses a glob (crates/*)', () => {
    const workspaceCargo = `
[workspace]
members = ["crates/*"]
`;
    const fooCargo = `
[package]
name = "mytool-foo"
version = "0.1.0"
`;
    const barCargo = `
[package]
name = "mytool-bar"
version = "0.1.0"
`;
    const fooLib: Node = {
      id: 'module:crates/mytool-foo/src/lib.rs:mytool_foo:1',
      kind: 'module',
      name: 'mytool_foo',
      qualifiedName: 'crates/mytool-foo/src/lib.rs::mytool_foo',
      filePath: 'crates/mytool-foo/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const barLib: Node = {
      id: 'module:crates/mytool-bar/src/lib.rs:mytool_bar:1',
      kind: 'module',
      name: 'mytool_bar',
      qualifiedName: 'crates/mytool-bar/src/lib.rs::mytool_bar',
      filePath: 'crates/mytool-bar/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const filesByPath: Record<string, string> = {
      'Cargo.toml': workspaceCargo,
      'crates/mytool-foo/Cargo.toml': fooCargo,
      'crates/mytool-bar/Cargo.toml': barCargo,
    };
    const nodesByFile: Record<string, Node[]> = {
      'crates/mytool-foo/src/lib.rs': [fooLib],
      'crates/mytool-bar/src/lib.rs': [barLib],
    };
    const dirsByPath: Record<string, string[]> = {
      '.': ['crates'],
      crates: ['mytool-foo', 'mytool-bar'],
      'crates/mytool-foo': ['src'],
      'crates/mytool-bar': ['src'],
    };

    const context = {
      getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        Object.prototype.hasOwnProperty.call(filesByPath, p) ||
        Object.prototype.hasOwnProperty.call(nodesByFile, p)
      ),
      readFile: (p: string) => filesByPath[p] ?? null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
        ...Object.keys(nodesByFile),
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      listDirectories: (rel: string) => dirsByPath[rel] ?? [],
    };

    const fooRef = {
      fromNodeId: 'fn:crates/mytool-bar/src/lib.rs:other:1',
      referenceName: 'mytool_foo',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-bar/src/lib.rs',
      language: 'rust' as const,
    };
    const barRef = {
      fromNodeId: 'fn:crates/mytool-foo/src/lib.rs:other:1',
      referenceName: 'mytool_bar',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-foo/src/lib.rs',
      language: 'rust' as const,
    };

    expect(rustResolver.resolve(fooRef, context)?.targetNodeId).toBe(fooLib.id);
    expect(rustResolver.resolve(barRef, context)?.targetNodeId).toBe(barLib.id);
  });

  it('resolves crate name when members uses a name glob at root (helix-*)', () => {
    const workspaceCargo = `
[workspace]
members = ["helix-*"]
`;
    const coreCargo = `
[package]
name = "helix-core"
version = "0.1.0"
`;
    const coreLib: Node = {
      id: 'module:helix-core/src/lib.rs:helix_core:1',
      kind: 'module',
      name: 'helix_core',
      qualifiedName: 'helix-core/src/lib.rs::helix_core',
      filePath: 'helix-core/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const filesByPath: Record<string, string> = {
      'Cargo.toml': workspaceCargo,
      'helix-core/Cargo.toml': coreCargo,
    };
    const nodesByFile: Record<string, Node[]> = {
      'helix-core/src/lib.rs': [coreLib],
    };
    const dirsByPath: Record<string, string[]> = {
      '.': ['helix-core', 'docs', 'target'],
      'helix-core': ['src'],
    };

    const context = {
      getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        Object.prototype.hasOwnProperty.call(filesByPath, p) ||
        Object.prototype.hasOwnProperty.call(nodesByFile, p)
      ),
      readFile: (p: string) => filesByPath[p] ?? null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
        ...Object.keys(nodesByFile),
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      listDirectories: (rel: string) => dirsByPath[rel] ?? [],
    };

    const ref = {
      fromNodeId: 'fn:helix-core/src/lib.rs:other:1',
      referenceName: 'helix_core',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'helix-core/src/lib.rs',
      language: 'rust' as const,
    };

    expect(rustResolver.resolve(ref, context)?.targetNodeId).toBe(coreLib.id);
  });
});
