/**
 * Shared property schemas reused across MCP tool definitions.
 */

import type { PropertySchema } from './tool-types';

/**
 * Common projectPath property for cross-project queries.
 */
export const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Path to a different project with .codegraph/ initialized. If omitted, uses current project. Use this to query other codebases.',
};
