/**
 * Configuration Management
 *
 * Load, save, and validate CodeGraph configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CodeGraphConfig, DEFAULT_CONFIG } from './types';
import { validateConfig } from './config-validate';

/**
 * Configuration filename
 */
export const CONFIG_FILENAME = 'config.json';

/**
 * Get the config file path for a project
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', CONFIG_FILENAME);
}

/**
 * Check if a regex pattern is safe from ReDoS attacks.
 *
 * Rejects patterns with nested quantifiers (e.g., (a+)+, (a*)*) which
 * are the primary source of catastrophic backtracking. Also rejects
 * excessively long patterns and validates compilability.
 */
function mergeConfig(
  defaults: CodeGraphConfig,
  overrides: Partial<CodeGraphConfig>
): CodeGraphConfig {
  return {
    version: overrides.version ?? defaults.version,
    rootDir: overrides.rootDir ?? defaults.rootDir,
    include: overrides.include ?? defaults.include,
    exclude: overrides.exclude ?? defaults.exclude,
    languages: overrides.languages ?? defaults.languages,
    frameworks: overrides.frameworks ?? defaults.frameworks,
    maxFileSize: overrides.maxFileSize ?? defaults.maxFileSize,
    extractDocstrings: overrides.extractDocstrings ?? defaults.extractDocstrings,
    trackCallSites: overrides.trackCallSites ?? defaults.trackCallSites,
    customPatterns: overrides.customPatterns ?? defaults.customPatterns,
  };
}

/**
 * Load configuration from a project
 */
export function loadConfig(projectRoot: string): CodeGraphConfig {
  const configPath = getConfigPath(projectRoot);

  if (!fs.existsSync(configPath)) {
    // Return default config with adjusted rootDir
    return {
      ...DEFAULT_CONFIG,
      rootDir: projectRoot,
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    // Merge with defaults to ensure all fields are present
    const merged = mergeConfig(DEFAULT_CONFIG, parsed as Partial<CodeGraphConfig>);
    merged.rootDir = projectRoot; // Always use actual project root

    if (!validateConfig(merged)) {
      throw new Error('Invalid configuration format');
    }

    return merged;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`);
    }
    throw error;
  }
}

/**
 * Save configuration to a project
 */
export function saveConfig(projectRoot: string, config: CodeGraphConfig): void {
  const configPath = getConfigPath(projectRoot);
  const dir = path.dirname(configPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create a copy without rootDir (it's always derived from project path)
  const toSave = { ...config };
  delete (toSave as Partial<CodeGraphConfig>).rootDir;

  const content = JSON.stringify(toSave, null, 2);

  // Atomic write: write to temp file then rename to prevent partial/corrupt configs
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

/**
 * Create default configuration for a new project
 */
export function createDefaultConfig(projectRoot: string): CodeGraphConfig {
  return {
    ...DEFAULT_CONFIG,
    rootDir: projectRoot,
  };
}

/**
 * Update specific configuration values
 */
export function updateConfig(
  projectRoot: string,
  updates: Partial<CodeGraphConfig>
): CodeGraphConfig {
  const current = loadConfig(projectRoot);
  const updated = mergeConfig(current, updates);
  updated.rootDir = projectRoot;
  saveConfig(projectRoot, updated);
  return updated;
}

/**
 * Add patterns to include list
 */

export { validateConfig } from './config-validate';
export {
  addIncludePatterns,
  addExcludePatterns,
  addCustomPattern,
  shouldIncludeFile,
} from './config-patterns';
