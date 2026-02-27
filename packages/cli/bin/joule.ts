#!/usr/bin/env node
import { Command } from 'commander';
import { runCommand } from '../src/commands/run.js';
import { traceCommand } from '../src/commands/trace.js';
import { configCommand } from '../src/commands/config.js';
import { toolsCommand } from '../src/commands/tools.js';
import { serveCommand } from '../src/commands/serve.js';
import { chatCommand } from '../src/commands/chat.js';
import { usersCommand } from '../src/commands/users.js';
import { pluginsCommand } from '../src/commands/plugins.js';
import { channelsCommand } from '../src/commands/channels.js';
import { scheduleCommand } from '../src/commands/schedule.js';
import { voiceCommand } from '../src/commands/voice.js';
import { doCommand } from '../src/commands/do.js';
import { authCommand } from '../src/commands/auth.js';
import { crewCommand } from '../src/commands/crew.js';

const program = new Command();

program
  .name('joule')
  .description('Joule - Energy-aware AI agent runtime')
  .version('0.5.0');

program.addCommand(runCommand);
program.addCommand(traceCommand);
program.addCommand(configCommand);
program.addCommand(toolsCommand);
program.addCommand(serveCommand);
program.addCommand(chatCommand);
program.addCommand(usersCommand);
program.addCommand(pluginsCommand);
program.addCommand(channelsCommand);
program.addCommand(scheduleCommand);
program.addCommand(voiceCommand);
program.addCommand(doCommand);
program.addCommand(authCommand);
program.addCommand(crewCommand);

program.parse();
