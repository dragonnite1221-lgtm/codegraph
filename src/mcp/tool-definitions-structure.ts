/**
 * Project-structure MCP tool definitions (index status, file tree).
 */

import type { ToolDefinition } from './tool-types';
import { projectPathProperty } from './tool-shared';

export const structureTools: ToolDefinition[] = [
  {
    name: 'codegraph_status',
    description: 'Get the status of the CodeGraph index, including statistics about indexed files, nodes, and edges.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_files',
    description: 'REQUIRED for file/folder exploration. Get the project file structure from the CodeGraph index. Returns a tree view of all indexed files with metadata (language, symbol count). Much faster than Glob/filesystem scanning. Use this FIRST when exploring project structure, finding files, or understanding codebase organization.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Filter to files under this directory path (e.g., "src/components"). Returns all files if not specified.',
        },
        pattern: {
          type: 'string',
          description: 'Filter files matching this glob pattern (e.g., "*.tsx", "**/*.test.ts")',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language)',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show (default: unlimited)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of files to render before truncating the file list (default: 500, max: 5000)',
        },
        projectPath: projectPathProperty,
      },
    },
  },
];
