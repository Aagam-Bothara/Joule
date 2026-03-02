import { Command } from 'commander';
import { SkillRegistry } from '@joule/tools';

export const skillsCommand = new Command('skills')
  .description('Manage Joule skills (markdown-based agent capabilities)');

skillsCommand
  .command('list')
  .description('List all installed skills')
  .action(() => {
    const registry = new SkillRegistry();
    registry.loadLocal();
    const skills = registry.list();

    if (skills.length === 0) {
      console.log('No skills installed. Use "joule skills create <name>" to create one.');
      return;
    }

    console.log(`\nInstalled Skills (${skills.length}):\n`);
    for (const skill of skills) {
      const tags = skill.tags?.length ? ` [${skill.tags.join(', ')}]` : '';
      console.log(`  ${skill.name} v${skill.version} — ${skill.description}${tags}`);
    }
    console.log('');
  });

skillsCommand
  .command('show <name>')
  .description('Show details of an installed skill')
  .action((name: string) => {
    const registry = new SkillRegistry();
    registry.loadLocal();
    const skill = registry.get(name);

    if (!skill) {
      console.error(`Skill "${name}" not found. Use "joule skills list" to see installed skills.`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n${skill.name} v${skill.version}`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`Description: ${skill.description}`);
    console.log(`Author:      ${skill.author}`);
    console.log(`Source:      ${skill.source}`);
    if (skill.tags?.length) console.log(`Tags:        ${skill.tags.join(', ')}`);
    if (skill.tools?.length) console.log(`Tools:       ${skill.tools.join(', ')}`);
    console.log(`\nInstructions:\n${skill.instructions}`);
    console.log('');
  });

skillsCommand
  .command('install <source>')
  .description('Install a skill from a file, npm package, or URL')
  .action(async (source: string) => {
    const registry = new SkillRegistry();
    registry.loadLocal();

    let skill;

    if (source.startsWith('http://') || source.startsWith('https://')) {
      // URL — GitHub gist, raw file, etc.
      console.log(`Fetching skill from ${source}...`);
      skill = await registry.installFromUrl(source);
    } else if (source.startsWith('joule-skill-') || source.startsWith('@')) {
      // npm package
      console.log(`Installing skill from npm: ${source}...`);
      skill = registry.installFromNpm(source);
    } else if (source.match(/^[\w-]+\/[\w.-]+$/) && !source.endsWith('.md')) {
      // GitHub shorthand: user/repo
      console.log(`Fetching skill from github.com/${source}...`);
      skill = await registry.installFromUrl(source);
    } else {
      // Local file path
      skill = registry.installFromFile(source);
    }

    if (!skill) {
      console.error('Failed to install skill. Check that the source is valid and contains a skill with YAML frontmatter.');
      process.exitCode = 1;
      return;
    }

    const validation = registry.validate(skill);
    if (!validation.valid) {
      console.warn('Skill installed with warnings:');
      for (const err of validation.errors) {
        console.warn(`  - ${err}`);
      }
    }

    console.log(`Installed skill: ${skill.name} v${skill.version} (source: ${skill.source})`);
  });

skillsCommand
  .command('uninstall <name>')
  .description('Remove an installed skill')
  .action((name: string) => {
    const registry = new SkillRegistry();
    registry.loadLocal();

    if (!registry.uninstall(name)) {
      console.error(`Skill "${name}" not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Uninstalled skill: ${name}`);
  });

skillsCommand
  .command('search <query>')
  .description('Search installed skills by name, description, or tags')
  .action((query: string) => {
    const registry = new SkillRegistry();
    registry.loadLocal();

    const results = registry.search(query);
    if (results.length === 0) {
      console.log(`No skills matching "${query}".`);
      return;
    }

    console.log(`\nSearch results for "${query}" (${results.length}):\n`);
    for (const skill of results) {
      console.log(`  ${skill.name} v${skill.version} — ${skill.description}`);
    }
    console.log('');
  });

skillsCommand
  .command('create <name>')
  .description('Scaffold a new skill markdown file')
  .option('-d, --description <desc>', 'Skill description', 'A new Joule skill')
  .action((name: string, options: { description: string }) => {
    const registry = new SkillRegistry();
    const markdown = registry.scaffold(name, options.description);

    const filename = `${name}.md`;
    const fs = require('node:fs');
    fs.writeFileSync(filename, markdown, 'utf-8');

    console.log(`Created skill template: ${filename}`);
    console.log(`Edit it, then install with: joule skills install ${filename}`);
  });
