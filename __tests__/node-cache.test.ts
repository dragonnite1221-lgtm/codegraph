import { describe, expect, it } from 'vitest';

import { NodeCache } from '../src/db/node-cache';
import type { Node } from '../src/types';

function node(id: string, filePath = `${id}.ts`): Node {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  };
}

describe('NodeCache', () => {
  it('evicts the least recently used node when full', () => {
    const cache = new NodeCache(2);

    cache.set(node('a'));
    cache.set(node('b'));
    expect(cache.get('a')?.id).toBe('a');
    cache.set(node('c'));

    expect(cache.get('a')?.id).toBe('a');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')?.id).toBe('c');
  });

  it('moves updated nodes to the most recently used position', () => {
    const cache = new NodeCache(2);

    cache.set(node('a', 'src/old.ts'));
    cache.set(node('b'));
    cache.set(node('a', 'src/new.ts'));
    cache.set(node('c'));

    expect(cache.get('a')?.filePath).toBe('src/new.ts');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')?.id).toBe('c');
  });

  it('evicts an empty-string node id when it is least recently used', () => {
    const cache = new NodeCache(1);

    cache.set(node(''));
    cache.set(node('b'));

    expect(cache.get('')).toBeUndefined();
    expect(cache.get('b')?.id).toBe('b');
  });

  it('deletes cached nodes by file path', () => {
    const cache = new NodeCache();

    cache.set(node('a', 'src/shared.ts'));
    cache.set(node('b', 'src/shared.ts'));
    cache.set(node('c', 'src/other.ts'));
    cache.deleteByFile('src/shared.ts');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')?.id).toBe('c');
  });
});
