/**
 * Config validation split out of config.ts to keep it within the 200-line
 * limit. No behavior change.
 */

import { CodeGraphConfig, Language } from './types';

function isSafeRegex(pattern: string): boolean {
  // Reject excessively long patterns
  if (pattern.length > 500) return false;

  // Reject nested quantifiers: (...)+ followed by +, *, or {
  // These are the primary cause of catastrophic backtracking
  if (/([+*}])\s*[+*{]/.test(pattern)) return false;
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;

  // Verify the pattern is a valid regex
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a configuration object
 */
export function validateConfig(config: unknown): config is CodeGraphConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  // Required fields
  if (typeof c.version !== 'number') return false;
  if (typeof c.rootDir !== 'string') return false;
  if (!Array.isArray(c.include)) return false;
  if (!Array.isArray(c.exclude)) return false;
  if (!Array.isArray(c.languages)) return false;
  if (!Array.isArray(c.frameworks)) return false;
  if (typeof c.maxFileSize !== 'number') return false;
  if (typeof c.extractDocstrings !== 'boolean') return false;
  if (typeof c.trackCallSites !== 'boolean') return false;

  // Validate include/exclude are string arrays
  if (!c.include.every((p) => typeof p === 'string')) return false;
  if (!c.exclude.every((p) => typeof p === 'string')) return false;

  // Validate languages
  const validLanguages: Language[] = [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'java',
    'svelte',
    'unknown',
  ];
  if (!c.languages.every((l) => validLanguages.includes(l as Language))) return false;

  // Validate frameworks
  for (const fw of c.frameworks) {
    if (typeof fw !== 'object' || fw === null) return false;
    const framework = fw as Record<string, unknown>;
    if (typeof framework.name !== 'string') return false;
  }

  // Validate custom patterns if present
  if (c.customPatterns !== undefined) {
    if (!Array.isArray(c.customPatterns)) return false;
    for (const pattern of c.customPatterns) {
      if (typeof pattern !== 'object' || pattern === null) return false;
      const p = pattern as Record<string, unknown>;
      if (typeof p.name !== 'string') return false;
      if (typeof p.pattern !== 'string') return false;
      if (typeof p.kind !== 'string') return false;

      // Validate regex is compilable and reject patterns with known ReDoS risks
      if (!isSafeRegex(p.pattern)) return false;
    }
  }

  return true;
}

/**
 * Merge configuration with defaults
 */
