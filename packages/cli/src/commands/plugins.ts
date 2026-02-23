import { Command } from 'commander';
import { PluginManager } from '@joule/tools';

export const pluginsCommand = new Command('plugins')
  .description('Manage Joule plugins');

pluginsCommand
  .command('install <name>')
  .description('Install a plugin from npm (joule-plugin-<name>)')
  .option('-v, --version <version>', 'Specific version to install')
  .action(async (name: string, options: { version?: string }) => {
    const manager = new PluginManager();
    console.log(`Installing plugin: ${name}...`);
    try {
      const plugin = await manager.install(name, options.version);
      console.log(`Installed ${plugin.manifest.name}@${plugin.manifest.version}`);
      if (plugin.manifest.tools.length > 0) {
        console.log(`  Tools: ${plugin.manifest.tools.join(', ')}`);
      }
    } catch (err) {
      console.error(`Failed to install: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

pluginsCommand
  .command('uninstall <name>')
  .description('Uninstall a plugin')
  .action(async (name: string) => {
    const manager = new PluginManager();
    const removed = await manager.uninstall(name);
    if (removed) {
      console.log(`Uninstalled: ${name}`);
    } else {
      console.log(`Plugin not found: ${name}`);
    }
  });

pluginsCommand
  .command('list')
  .description('List installed plugins')
  .action(async () => {
    const manager = new PluginManager();
    const plugins = await manager.list();

    if (plugins.length === 0) {
      console.log('No plugins installed.');
      console.log('Install one with: joule plugins install <name>');
      return;
    }

    console.log(`Installed plugins (${plugins.length}):\n`);
    for (const p of plugins) {
      const status = p.enabled ? 'enabled' : 'disabled';
      console.log(`  ${p.manifest.name}@${p.manifest.version} [${status}]`);
      console.log(`    ${p.manifest.description}`);
      if (p.manifest.tools.length > 0) {
        console.log(`    Tools: ${p.manifest.tools.join(', ')}`);
      }
    }
  });

pluginsCommand
  .command('search <query>')
  .description('Search npm for Joule plugins')
  .action(async (query: string) => {
    const manager = new PluginManager();
    console.log(`Searching for "${query}"...`);
    const results = await manager.search(query);

    if (results.length === 0) {
      console.log('No plugins found.');
      return;
    }

    console.log(`Found ${results.length} plugin(s):\n`);
    for (const r of results) {
      console.log(`  ${r.name}@${r.latestVersion}`);
      console.log(`    ${r.description}`);
      console.log(`    Author: ${r.author}`);
    }
  });

pluginsCommand
  .command('enable <name>')
  .description('Enable an installed plugin')
  .action(async (name: string) => {
    const manager = new PluginManager();
    const ok = await manager.enable(name);
    console.log(ok ? `Enabled: ${name}` : `Plugin not found: ${name}`);
  });

pluginsCommand
  .command('disable <name>')
  .description('Disable an installed plugin')
  .action(async (name: string) => {
    const manager = new PluginManager();
    const ok = await manager.disable(name);
    console.log(ok ? `Disabled: ${name}` : `Plugin not found: ${name}`);
  });
