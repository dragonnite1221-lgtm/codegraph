/**
 * Node.js version compatibility check.
 *
 * Node 24.x and newer currently expose a V8 turboshaft WASM JIT Zone allocator bug that
 * reliably crashes CodeGraph with `Fatal process out of memory: Zone`
 * during tree-sitter grammar compilation. This module owns the
 * user-facing banner shown before exit. Kept side-effect-free so it's
 * safe to import from tests without triggering CLI bootstrap.
 */

/**
 * Build the bordered banner shown when CodeGraph detects an
 * unsupported Node.js version. Pinned via unit
 * test so the recovery commands and override instructions can't be
 * silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildUnsupportedNodeBlockBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  const tooOld = !isNodeVersionAtLeast(nodeVersion, 20, 12);
  if (tooOld) {
    return [
      sep,
      `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
      sep,
      'CodeGraph and its runtime dependencies require Node.js >=20.12.0 <24.0.0.',
      '',
      'Fix: install Node.js 22 LTS:',
      '  nvm install 22 && nvm use 22                          # nvm',
      '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
      sep,
    ].join('\n');
  }
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'Node.js 24.x and newer have a V8 WASM JIT (turboshaft) Zone allocator bug that',
    'crashes with `Fatal process out of memory: Zone` when CodeGraph',
    'compiles tree-sitter grammars. CodeGraph WILL crash on this Node',
    'version mid-indexing. See https://github.com/colbymchenry/codegraph/issues/81',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - you will likely OOM):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}

export function isSupportedNodeVersion(nodeVersion: string): boolean {
  return isNodeVersionAtLeast(nodeVersion, 20, 12) && !isNodeVersionAtLeast(nodeVersion, 24, 0);
}

function isNodeVersionAtLeast(nodeVersion: string, major: number, minor: number): boolean {
  const [actualMajor = 0, actualMinor = 0] = nodeVersion
    .split('.')
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

export const buildNode25BlockBanner = buildUnsupportedNodeBlockBanner;
