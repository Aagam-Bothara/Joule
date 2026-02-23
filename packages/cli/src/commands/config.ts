import { Command } from 'commander';
import { ConfigManager } from '@joule/core';

export const configCommand = new Command('config')
  .description('Manage Joule configuration');

configCommand
  .command('show')
  .description('Show current configuration')
  .action(async () => {
    const mgr = new ConfigManager();
    const config = await mgr.load();
    console.log(JSON.stringify(config, null, 2));
  });

configCommand
  .command('path')
  .description('Show config file search paths')
  .action(() => {
    console.log('Config files searched (first found wins):');
    console.log('  1. ./joule.config.yaml');
    console.log('  2. ./joule.config.yml');
    console.log('  3. ./joule.config.json');
    console.log('');
    console.log('Environment variables:');
    console.log('  JOULE_ANTHROPIC_API_KEY');
    console.log('  JOULE_OPENAI_API_KEY');
    console.log('  JOULE_GOOGLE_API_KEY');
    console.log('  JOULE_DEFAULT_BUDGET');
    console.log('  JOULE_LOG_LEVEL');
    console.log('  JOULE_SERVER_PORT');
    console.log('  JOULE_API_KEY');
  });
