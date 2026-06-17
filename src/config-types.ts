/**
 * Configuration types
 *
 * Framework hints, the CodeGraphConfig shape, and DEFAULT_CONFIG.
 * Re-exported from types.ts; import from there or here interchangeably.
 */

import type { Language, NodeKind } from './types';

/**
 * Framework-specific hints for better extraction
 */
export interface FrameworkHint {
  /** Framework name (react, express, django, etc.) */
  name: string;

  /** Version constraint if relevant */
  version?: string;

  /** Custom patterns for this framework */
  patterns?: {
    /** Component detection patterns */
    components?: string[];
    /** Route detection patterns */
    routes?: string[];
    /** Model detection patterns */
    models?: string[];
  };
}

/**
 * Configuration for a CodeGraph project
 */
export interface CodeGraphConfig {
  /** Schema version for migrations */
  version: number;

  /** Root directory of the project */
  rootDir: string;

  /** Glob patterns for files to include */
  include: string[];

  /** Glob patterns for files to exclude */
  exclude: string[];

  /** Languages to process (auto-detected if empty) */
  languages: Language[];

  /** Framework hints for better extraction */
  frameworks: FrameworkHint[];

  /** Maximum file size to process (in bytes) */
  maxFileSize: number;

  /** Whether to extract docstrings */
  extractDocstrings: boolean;

  /** Whether to track call sites */
  trackCallSites: boolean;

  /** Custom symbol patterns to extract */
  customPatterns?: {
    /** Name for this pattern group */
    name: string;
    /** Regex pattern to match */
    pattern: string;
    /** Node kind to assign */
    kind: NodeKind;
  }[];
}

export { DEFAULT_CONFIG } from './config-defaults';
