/**
 * Configuration types
 *
 * Framework hints, the CodeGraphConfig shape, and DEFAULT_CONFIG.
 * Re-exported from types.ts; import from there or here interchangeably.
 */

import type { Language, NodeKind } from './types';

/**
 * Framework-specific hints for better extraction
 */
export interface FrameworkHint {
  /** Framework name (react, express, django, etc.) */
  name: string;

  /** Version constraint if relevant */
  version?: string;

  /** Custom patterns for this framework */
  patterns?: {
    /** Component detection patterns */
    components?: string[];
    /** Route detection patterns */
    routes?: string[];
    /** Model detection patterns */
    models?: string[];
  };
}

/**
 * Configuration for a CodeGraph project
 */
export interface CodeGraphConfig {
  /** Schema version for migrations */
  version: number;

  /** Root directory of the project */
  rootDir: string;

  /** Glob patterns for files to include */
  include: string[];

  /** Glob patterns for files to exclude */
  exclude: string[];

  /** Languages to process (auto-detected if empty) */
  languages: Language[];

  /** Framework hints for better extraction */
  frameworks: FrameworkHint[];

  /** Maximum file size to process (in bytes) */
  maxFileSize: number;

  /** Whether to extract docstrings */
  extractDocstrings: boolean;

  /** Whether to track call sites */
  trackCallSites: boolean;

  /** Custom symbol patterns to extract */
  customPatterns?: {
    /** Name for this pattern group */
    name: string;
    /** Regex pattern to match */
    pattern: string;
    /** Node kind to assign */
    kind: NodeKind;
  }[];
}

/**
 * Default configuration values
 */
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
  exclude: [
    // Version control
    '**/.git/**',

    // Dependencies
    '**/node_modules/**',
    '**/vendor/**',
    '**/Pods/**',

    // Generic build outputs
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/bin/**',
    '**/obj/**',
    '**/target/**',

    // JavaScript/TypeScript
    '**/*.min.js',
    '**/*.bundle.js',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.output/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/.vite/**',
    '**/.astro/**',
    '**/.docusaurus/**',
    '**/.gatsby/**',
    '**/.webpack/**',
    '**/.nx/**',
    '**/.yarn/cache/**',
    '**/.pnpm-store/**',
    '**/storybook-static/**',

    // React Native / Expo
    '**/.expo/**',
    '**/web-build/**',
    '**/ios/Pods/**',
    '**/ios/build/**',
    '**/android/build/**',
    '**/android/.gradle/**',

    // Python
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/site-packages/**',
    '**/dist-packages/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/*.egg-info/**',
    '**/.eggs/**',

    // Go
    '**/go/pkg/mod/**',

    // Rust
    '**/target/debug/**',
    '**/target/release/**',

    // Java/Kotlin/Gradle
    '**/.gradle/**',
    '**/.m2/**',
    '**/generated-sources/**',
    '**/.kotlin/**',

    // Dart/Flutter
    '**/.dart_tool/**',

    // C#/.NET
    '**/.vs/**',
    '**/.nuget/**',
    '**/artifacts/**',
    '**/publish/**',

    // C/C++
    '**/cmake-build-*/**',
    '**/CMakeFiles/**',
    '**/bazel-*/**',
    '**/vcpkg_installed/**',
    '**/.conan/**',
    '**/Debug/**',
    '**/Release/**',
    '**/x64/**',
    '**/.pio/**',  // Platform.io (IoT/embedded build artifacts and library deps)

    // Electron
    '**/release/**',
    '**/*.app/**',
    '**/*.asar',

    // Swift/iOS/Xcode
    '**/DerivedData/**',
    '**/.build/**',
    '**/.swiftpm/**',
    '**/xcuserdata/**',
    '**/Carthage/Build/**',
    '**/SourcePackages/**',

    // Delphi/Pascal
    '**/__history/**',
    '**/__recovery/**',
    '**/*.dcu',

    // PHP
    '**/.composer/**',
    '**/storage/framework/**',
    '**/bootstrap/cache/**',

    // Ruby
    '**/.bundle/**',
    '**/tmp/cache/**',
    '**/public/assets/**',
    '**/public/packs/**',
    '**/.yardoc/**',

    // Testing/Coverage
    '**/coverage/**',
    '**/htmlcov/**',
    '**/.nyc_output/**',
    '**/test-results/**',
    '**/.coverage/**',

    // IDE/Editor
    '**/.idea/**',

    // Logs and temp
    '**/logs/**',
    '**/tmp/**',
    '**/temp/**',

    // Documentation build output
    '**/_build/**',
    '**/docs/_build/**',
    '**/site/**',
  ],
  languages: [],
  frameworks: [],
  maxFileSize: 1024 * 1024, // 1MB
  extractDocstrings: true,
  trackCallSites: true,
};

// =============================================================================
