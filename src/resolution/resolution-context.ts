/**
 * Resolution context factory
 *
 * Builds the ResolutionContext consumed by import/name/framework resolvers.
 * The resolver owns the caches and lazy state (known files, project aliases);
 * this factory wires read-through closures over them so the context stays a
 * plain data interface while the resolver keeps lifecycle control.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Node } from '../types';
import { logDebug } from '../errors';
import type { QueryBuilder } from '../db/queries';
import type {
  ImportMapping,
  ReExport,
  ResolutionContext,
} from './types';
import { loadProjectAliases, type AliasMap } from './path-aliases';
import { extractImportMappings, extractReExports } from './import-resolver';

export interface ResolutionContextDeps {
  queries: QueryBuilder;
  projectRoot: string;
  nodeCache: Map<string, Node[]>;
  fileCache: Map<string, string | null>;
  importMappingCache: Map<string, ImportMapping[]>;
  reExportCache: Map<string, ReExport[]>;
  nameCache: Map<string, Node[]>;
  lowerNameCache: Map<string, Node[]>;
  qualifiedNameCache: Map<string, Node[]>;
  /** Live accessor for the resolver's known-files set (null until warmed). */
  getKnownFiles: () => Set<string> | null;
  /** Lazily-computed tsconfig/jsconfig alias map, cached on the resolver. */
  getAliases: () => AliasMap | null | undefined;
  setAliases: (aliases: AliasMap | null) => void;
}

export function createResolutionContext(deps: ResolutionContextDeps): ResolutionContext {
  const ctx: ResolutionContext = {
    getNodesInFile: (filePath: string) => {
      if (!deps.nodeCache.has(filePath)) {
        deps.nodeCache.set(filePath, deps.queries.getNodesByFile(filePath));
      }
      return deps.nodeCache.get(filePath)!;
    },

    getNodesByName: (name: string) => {
      const cached = deps.nameCache.get(name);
      if (cached !== undefined) return cached;
      const result = deps.queries.getNodesByName(name);
      deps.nameCache.set(name, result);
      return result;
    },

    getNodesByQualifiedName: (qualifiedName: string) => {
      const cached = deps.qualifiedNameCache.get(qualifiedName);
      if (cached !== undefined) return cached;
      const result = deps.queries.getNodesByQualifiedNameExact(qualifiedName);
      deps.qualifiedNameCache.set(qualifiedName, result);
      return result;
    },

    getNodesByKind: (kind: Node['kind']) => {
      return deps.queries.getNodesByKind(kind);
    },

    fileExists: (filePath: string) => {
      // Check pre-built known files set first (O(1))
      const knownFiles = deps.getKnownFiles();
      if (knownFiles) {
        const normalized = filePath.replace(/\\/g, '/');
        if (knownFiles.has(filePath) || knownFiles.has(normalized)) {
          return true;
        }
      }
      // Fall back to filesystem for files not yet indexed
      const fullPath = path.join(deps.projectRoot, filePath);
      try {
        return fs.existsSync(fullPath);
      } catch (error) {
        logDebug('Error checking file existence', { filePath, error: String(error) });
        return false;
      }
    },

    readFile: (filePath: string) => {
      if (deps.fileCache.has(filePath)) {
        return deps.fileCache.get(filePath)!;
      }

      const fullPath = path.join(deps.projectRoot, filePath);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        deps.fileCache.set(filePath, content);
        return content;
      } catch (error) {
        logDebug('Failed to read file for resolution', { filePath, error: String(error) });
        deps.fileCache.set(filePath, null);
        return null;
      }
    },

    getProjectRoot: () => deps.projectRoot,

    getAllFiles: () => {
      return deps.queries.getAllFilePaths();
    },

    listDirectories: (relativePath: string) => {
      const target = relativePath === '.' || relativePath === ''
        ? deps.projectRoot
        : path.join(deps.projectRoot, relativePath);
      try {
        return fs
          .readdirSync(target, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (error) {
        logDebug('Failed to list directory for resolution', {
          relativePath,
          error: String(error),
        });
        return [];
      }
    },

    getNodesByLowerName: (lowerName: string) => {
      const cached = deps.lowerNameCache.get(lowerName);
      if (cached !== undefined) return cached;
      const result = deps.queries.getNodesByLowerName(lowerName);
      deps.lowerNameCache.set(lowerName, result);
      return result;
    },

    getImportMappings: (filePath: string, language) => {
      const cacheKey = filePath;
      const cached = deps.importMappingCache.get(cacheKey);
      if (cached) return cached;

      const content = ctx.readFile(filePath);
      if (!content) {
        deps.importMappingCache.set(cacheKey, []);
        return [];
      }

      const mappings = extractImportMappings(filePath, content, language);
      deps.importMappingCache.set(cacheKey, mappings);
      return mappings;
    },

    getProjectAliases: () => {
      if (deps.getAliases() === undefined) {
        deps.setAliases(loadProjectAliases(deps.projectRoot));
      }
      return deps.getAliases() ?? null;
    },

    getReExports: (filePath: string, language) => {
      const cached = deps.reExportCache.get(filePath);
      if (cached) return cached;
      const content = ctx.readFile(filePath);
      if (!content) {
        deps.reExportCache.set(filePath, []);
        return [];
      }
      const reExports = extractReExports(content, language);
      deps.reExportCache.set(filePath, reExports);
      return reExports;
    },
  };

  return ctx;
}
