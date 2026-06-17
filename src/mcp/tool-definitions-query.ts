/**
 * Query-oriented MCP tool definitions (search, context, graph traversal).
 */

import type { ToolDefinition } from './tool-types';
import { projectPathProperty } from './tool-shared';

export const queryTools: ToolDefinition[] = [
  {
    name: 'codegraph_search',
    description: 'Quick symbol search by name. Returns locations only (no code) — best for pinpoint "where is X defined / find the symbol named X" lookups. For understanding how something works or tracing a flow, lead with codegraph_explore instead of searching then reading.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'codegraph_context',
    description: 'PRIMARY TOOL: Build comprehensive context for a task. Returns entry points, related symbols, and key code - often enough to understand the codebase without additional tool calls. NOTE: This provides CODE context, not product requirements. For new features, still clarify UX/behavior questions with the user before implementing.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task, bug, or feature to build context for',
        },
        maxNodes: {
          type: 'number',
          description: 'Maximum symbols to include (default: 20)',
          default: 20,
        },
        includeCode: {
          type: 'boolean',
          description: 'Include code snippets for key symbols (default: true)',
          default: true,
        },
        projectPath: projectPathProperty,
      },
      required: ['task'],
    },
  },
  {
    name: 'codegraph_callers',
    description: 'Find all functions/methods that call a specific symbol. Useful for understanding usage patterns and impact of changes.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callers for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_callees',
    description: 'Find all functions/methods that a specific symbol calls. Useful for understanding dependencies and code flow.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callees for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_impact',
    description: 'Analyze the impact radius of changing a symbol. Shows what code could be affected by modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to analyze impact for',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_node',
    description: 'Get detailed information about a specific code symbol. Use includeCode=true only when you need the full source code - otherwise just get location and signature to minimize context usage.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to get details for',
        },
        includeCode: {
          type: 'boolean',
          description: 'Include full source code (default: false to minimize context)',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_explore',
    description: 'PRIMARY TOOL for understanding questions — "how does X work", "trace X end to end", "explain the Y system", architecture/onboarding. Returns comprehensive context in a SINGLE call: relevant source grouped by file (contiguous, line-numbered sections, not snippets) + a relationship map + deep graph traversal. It REPLACES the grep+Read exploration loop: feed it the key symbol/file names and read its output — do NOT Read the files one by one. It works best when your query names the relevant symbols (e.g. "readAgentsFromDirectory createClaudeSession chat-manager agents.ts"); if the question is a plain sentence that names nothing concrete, do ONE quick codegraph_search or codegraph_context to surface the names, then call this with them. After exploring, use codegraph_node / Read only to fill specific gaps it did not cover. Prefer codegraph_search over this only for a pinpoint "where is X defined" lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to explore. A short list of symbol/file/keyword terms works best (e.g., "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"), but a plain-language phrase also works — the tool runs its own retrieval. No need to codegraph_search first.',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
];
