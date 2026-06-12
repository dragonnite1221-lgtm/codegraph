import type { Command } from 'commander';

import { getGlyphs } from '../ui/glyphs';

import { chalk, error } from './cli-output';

type CommandDeps = {
  resolveProjectPath(pathArg?: string): string;
};

export function registerServeCommand(program: Command, deps: CommandDeps): void {
  program
    .command('serve')
    .description('Start CodeGraph as an MCP server for AI assistants')
    .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
    .option('--mcp', 'Run as MCP server (stdio transport)')
    .action(async (options: { path?: string; mcp?: boolean }) => {
      const projectPath = options.path ? deps.resolveProjectPath(options.path) : undefined;

      try {
        if (options.mcp) {
          const { MCPServer } = await import('../mcp/index');
          const server = new MCPServer(projectPath);
          await server.start();
        } else {
          console.error(chalk.bold('\nCodeGraph MCP Server\n'));
          console.error(chalk.blue(getGlyphs().info) + ' Use --mcp flag to start the MCP server');
          console.error('\nTo use with Claude Code, add to your MCP configuration:');
          console.error(chalk.dim(`
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
          console.error('Available tools:');
          console.error(chalk.cyan('  codegraph_search') + '    - Search for code symbols');
          console.error(chalk.cyan('  codegraph_context') + '   - Build context for a task');
          console.error(chalk.cyan('  codegraph_callers') + '   - Find callers of a symbol');
          console.error(chalk.cyan('  codegraph_callees') + '   - Find what a symbol calls');
          console.error(chalk.cyan('  codegraph_impact') + '    - Analyze impact of changes');
          console.error(chalk.cyan('  codegraph_node') + '      - Get symbol details');
          console.error(chalk.cyan('  codegraph_files') + '     - Get project file structure');
          console.error(chalk.cyan('  codegraph_status') + '    - Get index status');
        }
      } catch (err) {
        error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
