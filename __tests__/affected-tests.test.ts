import { describe, expect, it } from 'vitest';
import { buildAffectedTestMatcher, findAffectedTests, globToRegex } from '../src/bin/affected-tests';

describe('buildAffectedTestMatcher', () => {
  it('matches relative test directories without a leading slash', () => {
    const isTestFile = buildAffectedTestMatcher();

    expect(isTestFile('e2e/login-flow.ts')).toBe(true);
    expect(isTestFile('tests/sync.test.ts')).toBe(true);
    expect(isTestFile('__tests__/affected-tests.test.ts')).toBe(true);
    expect(isTestFile('spec/cli.ts')).toBe(true);
  });

  it('normalizes Windows path separators before matching', () => {
    const isTestFile = buildAffectedTestMatcher();

    expect(isTestFile('e2e\\login-flow.ts')).toBe(true);
    expect(isTestFile('project\\__tests__\\foo.ts')).toBe(true);
  });

  it('applies custom glob filters to normalized paths', () => {
    const isTestFile = buildAffectedTestMatcher('e2e/*.ts');

    expect(isTestFile('e2e/login-flow.ts')).toBe(true);
    expect(isTestFile('e2e/login-flow.ts.bak')).toBe(false);
    expect(isTestFile('src/login-flow.ts')).toBe(false);
  });

  it('anchors glob regexes and lets ** match zero or more directories', () => {
    const regex = globToRegex('src/**/*.ts');

    expect(regex.test('src/foo.ts')).toBe(true);
    expect(regex.test('src/nested/foo.ts')).toBe(true);
    expect(regex.test('src/foo.tsconfig.json')).toBe(false);
  });

  it('finds changed tests and transitive dependent tests', () => {
    const graph = {
      getFileDependents(filePath: string): string[] {
        const edges: Record<string, string[]> = {
          'src/core.ts': ['src/ui.ts', 'tests/core.test.ts'],
          'src/ui.ts': ['e2e/ui.spec.ts'],
          'tests/core.test.ts': ['tests/harness.test.ts'],
        };
        return edges[filePath] || [];
      },
    };

    const result = findAffectedTests(['src/core.ts', 'tests/direct.test.ts'], graph, {
      maxDepth: 5,
    });

    expect(result).toEqual({
      changedFiles: ['src/core.ts', 'tests/direct.test.ts'],
      affectedTests: [
        'e2e/ui.spec.ts',
        'tests/core.test.ts',
        'tests/direct.test.ts',
        'tests/harness.test.ts',
      ],
      totalDependentsTraversed: 4,
    });
  });

  it('honors traversal depth while still including directly changed tests', () => {
    const graph = {
      getFileDependents(filePath: string): string[] {
        const edges: Record<string, string[]> = {
          'src/core.ts': ['src/ui.ts'],
          'src/ui.ts': ['tests/ui.test.ts'],
        };
        return edges[filePath] || [];
      },
    };

    const result = findAffectedTests(['src/core.ts', 'tests/direct.test.ts'], graph, {
      maxDepth: 1,
    });

    expect(result).toEqual({
      changedFiles: ['src/core.ts', 'tests/direct.test.ts'],
      affectedTests: ['tests/direct.test.ts'],
      totalDependentsTraversed: 1,
    });
  });
});
