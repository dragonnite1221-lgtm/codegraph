/**
 * Path/name/kind relevance scoring split out of query-utils.ts to keep it
 * within the 200-line limit. No behavior change.
 */

import * as path from 'path';
import { Node } from '../types';
import { extractSearchTerms } from './query-utils';

export function scorePathRelevance(filePath: string, query: string): number {
  // Use base terms only — stem variants inflate path scores by generating
  // many near-duplicate terms that all match the same path segments.
  const terms = extractSearchTerms(query, { stems: false });
  if (terms.length === 0) return 0;

  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();
  let score = 0;

  for (const term of terms) {
    // Exact filename match (strongest)
    if (fileName.includes(term)) score += 10;
    // Directory match
    if (dirName.includes(term)) score += 5;
    // General path match
    else if (pathLower.includes(term)) score += 3;
  }

  // Deprioritize test files unless the query is explicitly about tests
  const queryLower = query.toLowerCase();
  const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
  if (!isTestQuery && isTestFile(filePath)) {
    score -= 15;
  }

  return score;
}

/**
 * Check if a file path looks like a test file
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath);   // original case — needed for camelCase boundaries
  const lowerName = fileName.toLowerCase();

  // --- Filename patterns ---
  if (
    lowerName.startsWith('test_') ||                              // python: test_foo.py
    lowerName.startsWith('test.') ||
    // separator-delimited: foo_test.go, foo.test.ts, foo-spec.rb, bar_spec.py
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
    // CamelCase suffix (Java/Kotlin/Swift/C#/Scala): FooTest.kt, BarTests.swift,
    // BazSpec.scala, QuxTestCase.java. Capital-led so "latest.kt"/"manifest.kt"
    // (lowercase "test") are NOT matched.
    /(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
  ) {
    return true;
  }

  // --- Directory patterns ---
  if (
    lower.includes('/tests/') || lower.includes('/test/') ||
    lower.includes('/__tests__/') || lower.includes('/spec/') ||
    lower.includes('/specs/') || lower.includes('/testlib/') ||
    lower.includes('/testing/') ||
    lower.startsWith('test/') || lower.startsWith('tests/') ||
    lower.startsWith('spec/') || lower.startsWith('specs/') ||
    // CamelCase test source-set dirs (Kotlin Multiplatform / Gradle / Xcode):
    // jvmTest/, commonTest/, androidTest/, iosTest/, integrationTest/. Capital-led
    // so "latest/" / "manifest/" are not matched.
    /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
  ) {
    return true;
  }

  // Non-production directories: examples, samples, benchmarks, fixtures, demos.
  // Check both mid-path (/integration/) and start-of-path (integration/) since
  // file paths may be stored as relative paths without a leading slash.
  return matchesNonProductionDir(lower);
}

/**
 * Check if a path is in a non-production directory (integration, sample, example, etc.)
 * Handles both absolute paths (/foo/integration/bar) and relative paths (integration/bar).
 */
function matchesNonProductionDir(lowerPath: string): boolean {
  const dirs = [
    'integration', 'sample', 'samples', 'example', 'examples',
    'fixture', 'fixtures', 'benchmark', 'benchmarks', 'demo', 'demos',
  ];
  for (const dir of dirs) {
    if (lowerPath.includes('/' + dir + '/') || lowerPath.startsWith(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Bonus when a node's name matches the search query.
 * Exact matches get the largest boost; prefix matches get smaller boosts.
 * Multi-word queries also check individual term matches against the name.
 */
export function nameMatchBonus(nodeName: string, query: string): number {
  const nameLower = nodeName.toLowerCase();

  // Split query into word-level terms (handles "CacheBuilder build" → ["cache","builder","build"])
  const rawTerms = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2);

  // Also keep original space-separated tokens for exact-term matching
  const queryTokens = query.split(/\s+/).map(t => t.toLowerCase()).filter(t => t.length >= 2);

  // Full query as a single token (for compound identifiers like "CacheBuilder")
  const queryLower = query.replace(/[\s]+/g, '').toLowerCase();

  // Exact match: query exactly equals the node name
  if (nameLower === queryLower) return 80;

  // Exact match on a query token: "CacheBuilder build" and node name is "build"
  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60;

  // Name starts with query — scale by length ratio so "Pod"→"Pod" (exact, handled above)
  // scores much higher than "Pod"→"PodGCControllerOptions" (ratio 0.125).
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length;
    return Math.round(10 + 30 * ratio);
  }

  // All camelCase-split terms appear in the name
  if (rawTerms.length > 1) {
    const allMatch = rawTerms.every(t => nameLower.includes(t));
    if (allMatch) return 15;
  }

  // Name contains the full query as substring
  if (nameLower.includes(queryLower)) return 10;

  return 0;
}

/**
 * Kind-based bonus for search ranking
 * Functions and classes are typically more relevant than variables/imports
 */
export function kindBonus(kind: Node['kind']): number {
  const bonuses: Record<string, number> = {
    function: 10,
    method: 10,
    class: 8,
    interface: 9,
    type_alias: 6,
    struct: 6,
    trait: 9,
    enum: 5,
    component: 8,
    route: 9,
    module: 4,
    property: 3,
    field: 3,
    variable: 2,
    constant: 3,
    import: 1,
    export: 1,
    parameter: 0,
    namespace: 4,
    file: 0,
    protocol: 9,
    enum_member: 3,
  };
  return bonuses[kind] ?? 0;
}
