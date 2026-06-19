/**
 * CodeGraph project lifecycle: create/open a project and construct the facade.
 * Split out of index.ts to stay within the file-size gate. These take the
 * CodeGraph class to construct instances (the constructor stays effectively
 * internal — the static factories on CodeGraph are the documented entry points).
 */

import * as path from 'path';
import type { CodeGraphConfig } from './types';
import type { DatabaseConnection } from './db';
import type { QueryBuilder } from './db/queries';
import { initGrammars } from './extraction';
import { prepareNewProject, openExistingProject } from './lifecycle';
import type { InitOptions, OpenOptions } from './codegraph-types';

/** Constructor signature shared by the lifecycle factories. */
type CodeGraphCtor<T> = new (
  db: DatabaseConnection,
  queries: QueryBuilder,
  config: CodeGraphConfig,
  projectRoot: string
) => T;

export async function initCodeGraph<T extends { indexAll(o: { onProgress?: InitOptions['onProgress'] }): Promise<unknown> }>(
  Ctor: CodeGraphCtor<T>,
  projectRoot: string,
  options: InitOptions = {}
): Promise<T> {
  await initGrammars();
  const resolvedRoot = path.resolve(projectRoot);
  const { db, queries, config } = prepareNewProject(resolvedRoot, options.config);
  const instance = new Ctor(db, queries, config, resolvedRoot);
  if (options.index) {
    await instance.indexAll({ onProgress: options.onProgress });
  }
  return instance;
}

export function initCodeGraphSync<T>(
  Ctor: CodeGraphCtor<T>,
  projectRoot: string,
  options: Omit<InitOptions, 'index' | 'onProgress'> = {}
): T {
  const resolvedRoot = path.resolve(projectRoot);
  const { db, queries, config } = prepareNewProject(resolvedRoot, options.config);
  return new Ctor(db, queries, config, resolvedRoot);
}

export async function openCodeGraph<T extends { sync(): Promise<unknown> }>(
  Ctor: CodeGraphCtor<T>,
  projectRoot: string,
  options: OpenOptions = {}
): Promise<T> {
  await initGrammars();
  const resolvedRoot = path.resolve(projectRoot);
  const { db, queries, config } = openExistingProject(resolvedRoot);
  const instance = new Ctor(db, queries, config, resolvedRoot);
  if (options.sync) {
    await instance.sync();
  }
  return instance;
}

export function openCodeGraphSync<T>(Ctor: CodeGraphCtor<T>, projectRoot: string): T {
  const resolvedRoot = path.resolve(projectRoot);
  const { db, queries, config } = openExistingProject(resolvedRoot);
  return new Ctor(db, queries, config, resolvedRoot);
}
