const DEFAULT_TEST_PATTERNS = [
  /\.spec\./,
  /\.test\./,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)e2e\//,
  /(^|\/)spec\//,
];

export function globToRegex(glob: string): RegExp {
  let regex = '^';
  for (let i = 0; i < glob.length;) {
    const ch = glob[i] ?? '';
    const next = glob[i + 1];
    const afterNext = glob[i + 2];

    if (ch === '*' && next === '*' && afterNext === '/') {
      regex += '(?:.*/)?';
      i += 3;
    } else if (ch === '*' && next === '*') {
      regex += '.*';
      i += 2;
    } else if (ch === '*') {
      regex += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else {
      regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

export function buildAffectedTestMatcher(filter?: string): (filePath: string) => boolean {
  const customFilter = filter ? globToRegex(filter) : null;

  return (filePath: string): boolean => {
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (customFilter) return customFilter.test(normalizedPath);
    return DEFAULT_TEST_PATTERNS.some(pattern => pattern.test(normalizedPath));
  };
}

export type FileDependentsGraph = {
  getFileDependents(filePath: string): string[];
};

export type AffectedTestsResult = {
  changedFiles: string[];
  affectedTests: string[];
  totalDependentsTraversed: number;
};

export function findAffectedTests(
  changedFiles: string[],
  graph: FileDependentsGraph,
  options: { maxDepth: number; filter?: string },
): AffectedTestsResult {
  const isTestFile = buildAffectedTestMatcher(options.filter);
  const affectedTests = new Set<string>();
  const allDependents = new Set<string>();

  for (const file of changedFiles) {
    if (isTestFile(file)) {
      affectedTests.add(file);
    }

    const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
    const visited = new Set<string>();
    visited.add(file);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= options.maxDepth) continue;

      const dependents = graph.getFileDependents(current.file);
      for (const dep of dependents) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        allDependents.add(dep);

        if (isTestFile(dep)) {
          affectedTests.add(dep);
        }
        queue.push({ file: dep, depth: current.depth + 1 });
      }
    }
  }

  return {
    changedFiles,
    affectedTests: Array.from(affectedTests).sort(),
    totalDependentsTraversed: allDependents.size,
  };
}
