/**
 * Default CodeGraph configuration split out of config-types.ts to keep it
 * within the 200-line limit. No behavior change.
 */

import type { CodeGraphConfig } from './config-types';
import { DEFAULT_EXCLUDE } from './config-defaults-exclude';

export const DEFAULT_CONFIG: CodeGraphConfig = {
  version: 1,
  rootDir: '.',
  include: [
    // TypeScript/JavaScript
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    // Python
    '**/*.py',
    // Go
    '**/*.go',
    // Rust
    '**/*.rs',
    // Java
    '**/*.java',
    // C/C++
    '**/*.c',
    '**/*.h',
    '**/*.cpp',
    '**/*.hpp',
    '**/*.cc',
    '**/*.cxx',
    // C#
    '**/*.cs',
    // PHP
    '**/*.php',
    // Ruby
    '**/*.rb',
    // Swift
    '**/*.swift',
    // Kotlin
    '**/*.kt',
    '**/*.kts',
    // Dart
    '**/*.dart',
    // Svelte
    '**/*.svelte',
    // Vue
    '**/*.vue',
    // Liquid (Shopify themes)
    '**/*.liquid',
    // Pascal / Delphi
    '**/*.pas',
    '**/*.dpr',
    '**/*.dpk',
    '**/*.lpr',
    '**/*.dfm',
    '**/*.fmx',
    // Scala
    '**/*.scala',
    '**/*.sc',
  ],
  exclude: DEFAULT_EXCLUDE,
  languages: [],
  frameworks: [],
  maxFileSize: 1024 * 1024, // 1MB
  extractDocstrings: true,
  trackCallSites: true,
};

// =============================================================================
