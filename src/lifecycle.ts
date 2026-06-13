/**
 * Project lifecycle helpers
 *
 * Shared setup for the CodeGraph static init/open entry points: directory and
 * config creation/validation plus database/QueryBuilder wiring. Kept here so
 * the CodeGraph facade's static methods stay thin and free of duplication.
 */

import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import { loadConfig, saveConfig, createDefaultConfig } from './config';
import { isInitialized, createDirectory, validateDirectory } from './directory';
import type { CodeGraphConfig } from './types';

export interface ProjectHandles {
  db: DatabaseConnection;
  queries: QueryBuilder;
  config: CodeGraphConfig;
}

/**
 * Create the on-disk structure, config, and database for a brand-new project.
 * Throws if the directory is already initialized.
 */
export function prepareNewProject(
  resolvedRoot: string,
  configOverride?: Partial<CodeGraphConfig>
): ProjectHandles {
  if (isInitialized(resolvedRoot)) {
    throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
  }

  // Create directory structure
  createDirectory(resolvedRoot);

  // Create and save configuration
  const config = createDefaultConfig(resolvedRoot);
  if (configOverride) {
    Object.assign(config, configOverride);
  }
  saveConfig(resolvedRoot, config);

  // Initialize database
  const db = DatabaseConnection.initialize(getDatabasePath(resolvedRoot));
  const queries = new QueryBuilder(db.getDb());

  return { db, queries, config };
}

/**
 * Open the database and config for an existing project.
 * Throws if the directory is not initialized or fails validation.
 */
export function openExistingProject(resolvedRoot: string): ProjectHandles {
  if (!isInitialized(resolvedRoot)) {
    throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
  }

  // Validate directory structure
  const validation = validateDirectory(resolvedRoot);
  if (!validation.valid) {
    throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
  }

  // Load configuration
  const config = loadConfig(resolvedRoot);

  // Open database
  const db = DatabaseConnection.open(getDatabasePath(resolvedRoot));
  const queries = new QueryBuilder(db.getDb());

  return { db, queries, config };
}
