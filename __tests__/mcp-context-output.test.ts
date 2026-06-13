import { describe, expect, it } from 'vitest';

import {
  buildContextOutput,
  looksLikeFeatureRequest,
  type ContextGraph,
} from '../src/mcp/context-output';
import type { BuildContextOptions, TaskContext, TaskInput } from '../src/types';

function graph(result: string | TaskContext): ContextGraph & { calls: BuildContextOptions[] } {
  return {
    calls: [],
    async buildContext(_input: TaskInput, options?: BuildContextOptions) {
      this.calls.push(options ?? {});
      return result;
    },
  };
}

describe('MCP context output helpers', () => {
  it('passes markdown build options through and appends feature reminders', async () => {
    const cg = graph('## Code Context\n');

    const output = await buildContextOutput(cg, 'add export support', {
      maxNodes: 12,
      includeCode: false,
    });

    expect(cg.calls).toEqual([{ maxNodes: 12, includeCode: false, format: 'markdown' }]);
    expect(output).toContain('## Code Context');
    expect(output).toContain('Ask user');
  });

  it('formats TaskContext fallback results', async () => {
    const output = await buildContextOutput(
      graph({ summary: 'Compact context summary' } as TaskContext),
      'review payment flow',
      { maxNodes: 20, includeCode: true },
    );

    expect(output).toBe('Compact context summary');
  });

  it('does not classify bug fixes or exploration as feature requests', () => {
    expect(looksLikeFeatureRequest('fix checkout crash')).toBe(false);
    expect(looksLikeFeatureRequest('how does checkout work')).toBe(false);
    expect(looksLikeFeatureRequest('implement saved filters')).toBe(true);
  });
});
