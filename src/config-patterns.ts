/**
 * Config include/exclude pattern mutation + matching split out of config.ts
 * to keep it within the 200-line limit. No behavior change.
 */

import picomatch from 'picomatch';
import { CodeGraphConfig, NodeKind } from './types';
import { normalizePath } from './utils';
import { loadConfig, saveConfig } from './config';

export function addIncludePatterns(projectRoot: string, patterns: string[]): CodeGraphConfig {
  const config = loadConfig(projectRoot);
  const newPatterns = patterns.filter((p) => !config.include.includes(p));
  config.include = [...config.include, ...newPatterns];
  saveConfig(projectRoot, config);
  return config;
}

/**
 * Add patterns to exclude list
 */
export function addExcludePatterns(projectRoot: string, patterns: string[]): CodeGraphConfig {
  const config = loadConfig(projectRoot);
  const newPatterns = patterns.filter((p) => !config.exclude.includes(p));
  config.exclude = [...config.exclude, ...newPatterns];
  saveConfig(projectRoot, config);
  return config;
}

/**
 * Add a custom pattern
 */
export function addCustomPattern(
  projectRoot: string,
  name: string,
  pattern: string,
  kind: NodeKind
): CodeGraphConfig {
  const config = loadConfig(projectRoot);

  if (!config.customPatterns) {
    config.customPatterns = [];
  }

  // Check for duplicate name
  const existing = config.customPatterns.find((p) => p.name === name);
  if (existing) {
    existing.pattern = pattern;
    existing.kind = kind;
  } else {
    config.customPatterns.push({ name, pattern, kind });
  }

  saveConfig(projectRoot, config);
  return config;
}

/**
 * Check if a file path matches the include/exclude patterns
 */
export function shouldIncludeFile(filePath: string, config: CodeGraphConfig): boolean {
  // Normalize to forward slashes so Windows backslash paths match glob patterns
  filePath = normalizePath(filePath);

  // Simple glob matching (for now, just check if any pattern matches)
  // A full implementation would use a proper glob library

  const matchesPattern = (pattern: string, filePath: string): boolean => {
    return picomatch.isMatch(filePath, pattern, { dot: true });
  };

  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesPattern(pattern, filePath)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesPattern(pattern, filePath)) {
      return true;
    }
  }

  // Default to not including if no pattern matches
  return false;
}
