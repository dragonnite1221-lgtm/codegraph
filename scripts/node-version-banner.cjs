function buildUnsupportedNodeBlockBanner(nodeVersion, commandName = 'npm test') {
  const sep = '-'.repeat(72);
  if (!isNodeVersionAtLeast(nodeVersion, 20, 12)) {
    return [
      sep,
      `[CodeGraph] Unsupported Node.js version for tests: ${nodeVersion}`,
      sep,
      'CodeGraph and its test dependencies require Node.js >=20.12.0 <24.0.0.',
      '',
      'Fix: install Node.js 22 LTS:',
      '  nvm install 22 && nvm use 22                          # nvm',
      '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
      sep,
    ].join('\n');
  }
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version for tests: ${nodeVersion}`,
    sep,
    'Node.js 24.x and newer have a V8 WASM JIT (turboshaft) Zone allocator bug that',
    'crashes with `Fatal process out of memory: Zone` when CodeGraph compiles',
    'tree-sitter grammars. The full test suite is blocked on this runtime.',
    'See https://github.com/colbymchenry/codegraph/issues/81',
    '',
    'Fix: install Node.js 22 LTS before running the full test suite:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'For targeted diagnostics only (NOT the full suite), override with:',
    `  CODEGRAPH_ALLOW_UNSAFE_NODE=1 ${commandName}`,
    sep,
  ].join('\n');
}

function isNodeVersionAtLeast(nodeVersion, major, minor) {
  const [actualMajor = 0, actualMinor = 0] = nodeVersion
    .split('.')
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

function isSupportedNodeVersion(nodeVersion) {
  return isNodeVersionAtLeast(nodeVersion, 20, 12) && !isNodeVersionAtLeast(nodeVersion, 24, 0);
}

module.exports = { buildUnsupportedNodeBlockBanner, isSupportedNodeVersion };
