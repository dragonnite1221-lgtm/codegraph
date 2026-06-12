import { describe, expect, it } from 'vitest';

import { tools } from '../src/mcp/tools';

describe('MCP tool definitions', () => {
  it('keeps the public tool registry complete and ordered', () => {
    expect(tools.map(tool => tool.name)).toEqual([
      'codegraph_search',
      'codegraph_context',
      'codegraph_callers',
      'codegraph_callees',
      'codegraph_impact',
      'codegraph_node',
      'codegraph_explore',
      'codegraph_status',
      'codegraph_files',
    ]);
  });

  it('keeps cross-project support on every tool', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.properties.projectPath).toMatchObject({
        type: 'string',
      });
    }
  });
});
