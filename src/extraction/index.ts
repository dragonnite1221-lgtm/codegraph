/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage. The full-project
 * and targeted indexing drivers live in extraction-index-all.ts /
 * extraction-index-files.ts (operating on this orchestrator via OrchestratorApi)
 * to stay within the file-size gate.
 */

import * as fs from 'fs';
import {
  Language,
  ExtractionResult,
  ExtractionError,
  CodeGraphConfig,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { detectFrameworks } from '../resolution/frameworks';
import { scanDirectory } from './file-scanner';
import { storeExtractionResult } from './result-storage';
import { buildDetectionContext } from './detection-context';
import { getChangedFilesForIndex, runSync } from './sync-operations';
import { indexAll as runIndexAll } from './extraction-index-all';
import {
  indexFile as runIndexFile,
  indexFiles as runIndexFiles,
  indexFileWithContent as runIndexFileWithContent,
} from './extraction-index-files';

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

/** Subset of ExtractionOrchestrator the indexing drivers operate on. */
export interface OrchestratorApi {
  rootDir: string;
  config: CodeGraphConfig;
  detectedFrameworkNames: string[] | null;
  ensureDetectedFrameworks(files?: string[]): string[];
  storeExtractionResult(
    filePath: string, content: string, language: Language, stats: fs.Stats, result: ExtractionResult
  ): void;
  indexFile(relativePath: string): Promise<ExtractionResult>;
  indexFileWithContent(relativePath: string, content: string, stats: fs.Stats): Promise<ExtractionResult>;
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator implements OrchestratorApi {
  rootDir: string;
  config: CodeGraphConfig;
  queries: QueryBuilder;
  // Names of frameworks detected for this project, populated by indexAll().
  detectedFrameworkNames: string[] | null = null;

  constructor(rootDir: string, config: CodeGraphConfig, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.config = config;
    this.queries = queries;
  }

  /**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
  ensureDetectedFrameworks(files?: string[]): string[] {
    if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
    const fileList = files ?? scanDirectory(this.rootDir, this.config);
    const context = buildDetectionContext(this.rootDir, fileList);
    this.detectedFrameworkNames = detectFrameworks(context).map((r) => r.name);
    return this.detectedFrameworkNames;
  }

  /** Index all files in the project */
  indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean
  ): Promise<IndexResult> {
    return runIndexAll(this, onProgress, signal, verbose);
  }

  /** Index specific files */
  indexFiles(filePaths: string[]): Promise<IndexResult> {
    return runIndexFiles(this, filePaths);
  }

  /** Index a single file */
  indexFile(relativePath: string): Promise<ExtractionResult> {
    return runIndexFile(this, relativePath);
  }

  /** Index a single file with pre-read content and stats. */
  indexFileWithContent(relativePath: string, content: string, stats: fs.Stats): Promise<ExtractionResult> {
    return runIndexFileWithContent(this, relativePath, content, stats);
  }

  /** Store extraction result in database */
  storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    storeExtractionResult(this.queries, filePath, content, language, stats, result);
  }

  /**
   * Sync with current file state.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    return runSync(
      {
        rootDir: this.rootDir,
        config: this.config,
        queries: this.queries,
        indexFile: (filePath) => this.indexFile(filePath),
      },
      onProgress
    );
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return getChangedFilesForIndex({
      rootDir: this.rootDir,
      config: this.config,
      queries: this.queries,
      indexFile: (filePath) => this.indexFile(filePath),
    });
  }
}

// Re-export useful types and functions
export { hashContent, scanDirectory, scanDirectoryAsync, shouldIncludeFile } from './file-scanner';
export { extractFromSource } from './extract-from-source';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
