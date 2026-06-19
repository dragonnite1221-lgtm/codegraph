/**
 * Option types for the CodeGraph facade. Split out of index.ts to stay within
 * the file-size gate.
 */

import type { CodeGraphConfig } from './types';
import type { IndexProgress } from './extraction';

/** Options for initializing a new CodeGraph project */
export interface InitOptions {
  /** Custom configuration overrides */
  config?: Partial<CodeGraphConfig>;
  /** Whether to run initial indexing after init */
  index?: boolean;
  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/** Options for opening an existing CodeGraph project */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;
  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/** Options for indexing */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;
}
