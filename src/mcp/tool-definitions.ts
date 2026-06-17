/**
 * Static MCP tool definitions exposed by the CodeGraph server.
 *
 * Designed for minimal context usage - use codegraph_context as the primary
 * tool, and only use other tools for targeted follow-up queries. All tools
 * support cross-project queries via the optional `projectPath` parameter.
 *
 * Definitions are grouped into sibling modules to stay within the file-size
 * gate; this module concatenates them in their original registration order.
 */

import type { ToolDefinition } from './tool-types';
import { queryTools } from './tool-definitions-query';
import { structureTools } from './tool-definitions-structure';

/**
 * All CodeGraph MCP tools, in registration order.
 */
export const tools: ToolDefinition[] = [...queryTools, ...structureTools];
