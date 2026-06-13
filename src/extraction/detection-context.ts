/**
 * Detection context
 *
 * A filesystem-backed ResolutionContext sufficient for framework detection.
 * Graph-query methods return empty because the DB is not yet populated; detect()
 * only uses readFile, fileExists, and getAllFiles. Extracted from
 * ExtractionOrchestrator.
 */

import * as fs from 'fs';
import type { ResolutionContext } from '../resolution/types';
import { validatePathWithinRoot } from '../utils';

export function buildDetectionContext(rootDir: string, files: string[]): ResolutionContext {

    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
    };
  }
