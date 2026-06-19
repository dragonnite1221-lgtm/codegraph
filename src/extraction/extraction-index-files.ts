/**
 * Targeted file indexing for ExtractionOrchestrator: a list of files, a single
 * file (read + dispatch), and the pre-read content path. Split out of index.ts
 * to stay within the file-size gate. Operates on the orchestrator via
 * OrchestratorApi.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { ExtractionError, ExtractionResult } from '../types';
import { extractFromSource } from './extract-from-source';
import { detectLanguage, isLanguageSupported } from './grammars';
import { logWarn } from '../errors';
import { validatePathWithinRoot } from '../utils';
import type { IndexResult, OrchestratorApi } from './index';

/** Index a specific list of files. */
export async function indexFiles(orch: OrchestratorApi, filePaths: string[]): Promise<IndexResult> {
  const startTime = Date.now();
  const errors: ExtractionError[] = [];
  let filesIndexed = 0;
  let filesSkipped = 0;
  let filesErrored = 0;
  let totalNodes = 0;
  let totalEdges = 0;

  for (const filePath of filePaths) {
    const result = await orch.indexFile(filePath);

    if (result.errors.length > 0) {
      errors.push(...result.errors);
    }

    if (result.nodes.length > 0) {
      filesIndexed++;
      totalNodes += result.nodes.length;
      totalEdges += result.edges.length;
    } else if (result.errors.some((e) => e.severity === 'error')) {
      filesErrored++;
    } else {
      filesSkipped++;
    }
  }

  return {
    success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
    filesIndexed,
    filesSkipped,
    filesErrored,
    nodesCreated: totalNodes,
    edgesCreated: totalEdges,
    errors,
    durationMs: Date.now() - startTime,
  };
}

/** Index a single file (reads content + stats, then dispatches). */
export async function indexFile(orch: OrchestratorApi, relativePath: string): Promise<ExtractionResult> {
  const fullPath = validatePathWithinRoot(orch.rootDir, relativePath);

  if (!fullPath) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
      durationMs: 0,
    };
  }

  // Read file content and stats
  let content: string;
  let stats: fs.Stats;
  try {
    stats = await fsp.stat(fullPath);
    if (stats.size > orch.config.maxFileSize) {
      return indexFileWithContent(orch, relativePath, '', stats);
    }
    content = await fsp.readFile(fullPath, 'utf-8');
  } catch (error) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
          filePath: relativePath,
          severity: 'error',
          code: 'read_error',
        },
      ],
      durationMs: 0,
    };
  }

  return indexFileWithContent(orch, relativePath, content, stats);
}

/**
 * Index a single file with pre-read content and stats. Used by the parallel
 * batch reader to avoid redundant file I/O.
 */
export async function indexFileWithContent(
  orch: OrchestratorApi,
  relativePath: string,
  content: string,
  stats: fs.Stats
): Promise<ExtractionResult> {
  // Prevent path traversal
  const fullPath = validatePathWithinRoot(orch.rootDir, relativePath);
  if (!fullPath) {
    logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
      durationMs: 0,
    };
  }

  // Check file size
  if (stats.size > orch.config.maxFileSize) {
    return {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [
        {
          message: `File exceeds max size (${stats.size} > ${orch.config.maxFileSize})`,
          filePath: relativePath,
          severity: 'warning',
          code: 'size_exceeded',
        },
      ],
      durationMs: 0,
    };
  }

  // Detect language
  const language = detectLanguage(relativePath, content);
  if (!isLanguageSupported(language)) {
    return { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  }

  // Extract from source. Use cached framework names if indexAll has run,
  // otherwise detect on the spot so single-file re-index paths still emit
  // route nodes / middleware / etc.
  const frameworkNames = orch.ensureDetectedFrameworks();
  const result = extractFromSource(relativePath, content, language, frameworkNames);

  // Store in database
  if (result.nodes.length > 0 || result.errors.length === 0) {
    orch.storeExtractionResult(relativePath, content, language, stats, result);
  }

  return result;
}
