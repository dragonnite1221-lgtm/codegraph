import { describe, expect, it } from 'vitest';

import {
  runDeleteResolvedReferences,
  runGetUnresolvedReferencesByFiles,
} from '../src/db/unresolved-ref-queries';
import type { SqliteStatement } from '../src/db/sqlite-adapter';

function unresolvedRow(fromNodeId: string, referenceName: string, filePath: string) {
  return {
    id: 1,
    from_node_id: fromNodeId,
    reference_name: referenceName,
    reference_kind: 'calls',
    line: 1,
    col: 1,
    candidates: null,
    file_path: filePath,
    language: 'typescript',
  };
}

describe('unresolved reference query helpers', () => {
  it('chunks file-scoped lookups to stay under SQLite variable limits', () => {
    const argCounts: number[] = [];
    const filePaths = Array.from({ length: 901 }, (_, index) => `src/${index}.ts`);

    const refs = runGetUnresolvedReferencesByFiles((sql, fn) => {
      const stmt = {
        all: (...args: string[]) => {
          argCounts.push(args.length);
          expect(sql.match(/\?/g)?.length).toBe(args.length);
          return args.map((filePath) => unresolvedRow('from', filePath, filePath));
        },
      } as SqliteStatement;
      return fn(stmt);
    }, filePaths);

    expect(argCounts).toEqual([900, 1]);
    expect(refs).toHaveLength(901);
  });

  it('chunks resolved-reference deletes to stay under SQLite variable limits', () => {
    const argCounts: number[] = [];
    const nodeIds = Array.from({ length: 901 }, (_, index) => `node-${index}`);

    runDeleteResolvedReferences((sql, fn) => {
      const stmt = {
        run: (...args: string[]) => {
          argCounts.push(args.length);
          expect(sql.match(/\?/g)?.length).toBe(args.length);
          return { changes: args.length, lastInsertRowid: 0 };
        },
      } as SqliteStatement;
      return fn(stmt);
    }, nodeIds);

    expect(argCounts).toEqual([900, 1]);
  });
});
