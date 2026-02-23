import { Command } from 'commander';
import {
  fileReadTool,
  fileWriteTool,
  shellExecTool,
  httpFetchTool,
  jsonTransformTool,
} from '@joule/tools';

export const toolsCommand = new Command('tools')
  .description('Manage tools');

toolsCommand
  .command('list')
  .description('List available tools')
  .action(() => {
    const tools = [
      fileReadTool,
      fileWriteTool,
      shellExecTool,
      httpFetchTool,
      jsonTransformTool,
    ];

    console.log('Available tools:\n');
    for (const tool of tools) {
      const tags = tool.tags?.length ? ` [${tool.tags.join(', ')}]` : '';
      const confirm = tool.requiresConfirmation ? ' (requires confirmation)' : '';
      console.log(`  ${tool.name}${tags}${confirm}`);
      console.log(`    ${tool.description}`);
      console.log('');
    }
  });
