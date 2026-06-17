/**
 * Directory info/query operations split out of directory.ts to keep it within
 * the 200-line limit. No behavior change.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from './directory';

export function listDirectoryContents(projectRoot: string): string[] {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(codegraphDir);
  return files;
}

/**
 * Get the total size of the .codegraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(codegraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .codegraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .codegraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    errors.push('CodeGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codegraphDir).isDirectory()) {
    errors.push('.codegraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair missing .gitignore (non-critical file)
  const gitignorePath = path.join(codegraphDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    try {
      const gitignoreContent = `# CodeGraph data files\n# These are local to each machine and should not be committed\n\n# Database\n*.db\n*.db-wal\n*.db-shm\n\n# Cache\ncache/\n\n# Logs\n*.log\n\n# Hook markers\n.dirty\n`;
      fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
    } catch {
      // Non-fatal: warn but don't block
      errors.push('.gitignore missing in .codegraph directory and could not be created');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
