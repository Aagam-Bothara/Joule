import { Command } from 'commander';

export const scheduleCommand = new Command('schedule')
  .description('Manage scheduled tasks');

scheduleCommand
  .command('add <name>')
  .description('Add a new scheduled task')
  .requiredOption('--cron <expression>', 'Cron expression (5-field: min hour dom mon dow)')
  .requiredOption('--task <description>', 'Task description to execute')
  .option('--budget <preset>', 'Budget preset', 'medium')
  .action(async (name, options) => {
    const { Joule } = await import('@joule/core');
    const { Scheduler } = await import('@joule/core');

    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const scheduler = new Scheduler(joule);

    try {
      const task = await scheduler.add(name, options.cron, options.task, options.budget);
      console.log(`Schedule added: ${task.id}`);
      console.log(`  Name: ${task.name}`);
      console.log(`  Cron: ${task.cron}`);
      console.log(`  Task: ${task.taskDescription}`);
      console.log(`  Budget: ${task.budgetPreset}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('remove <id>')
  .description('Remove a scheduled task')
  .action(async (id) => {
    const { Joule } = await import('@joule/core');
    const { Scheduler } = await import('@joule/core');

    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const scheduler = new Scheduler(joule);

    const removed = await scheduler.remove(id);
    if (removed) {
      console.log(`Schedule ${id} removed.`);
    } else {
      console.error(`Schedule ${id} not found.`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('list')
  .description('List all scheduled tasks')
  .action(async () => {
    const { Joule } = await import('@joule/core');
    const { Scheduler } = await import('@joule/core');

    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const scheduler = new Scheduler(joule);

    const schedules = await scheduler.list();
    if (schedules.length === 0) {
      console.log('No scheduled tasks.');
      return;
    }

    console.log(`\nScheduled Tasks (${schedules.length}):\n`);
    for (const s of schedules) {
      const status = s.enabled ? 'active' : 'paused';
      const lastRun = s.lastRunAt ? `Last: ${s.lastRunAt} (${s.lastRunStatus})` : 'Never run';
      const energy = s.totalEnergyWh.toFixed(4);
      console.log(`  [${status}] ${s.name} (${s.id})`);
      console.log(`    Cron: ${s.cron} | Budget: ${s.budgetPreset}`);
      console.log(`    Task: ${s.taskDescription}`);
      console.log(`    Runs: ${s.runCount} | Energy: ${energy} Wh | ${lastRun}`);
      console.log();
    }
  });

scheduleCommand
  .command('pause <id>')
  .description('Pause a scheduled task')
  .action(async (id) => {
    const { Joule } = await import('@joule/core');
    const { Scheduler } = await import('@joule/core');

    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const scheduler = new Scheduler(joule);

    const paused = await scheduler.pause(id);
    if (paused) {
      console.log(`Schedule ${id} paused.`);
    } else {
      console.error(`Schedule ${id} not found.`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('resume <id>')
  .description('Resume a paused scheduled task')
  .action(async (id) => {
    const { Joule } = await import('@joule/core');
    const { Scheduler } = await import('@joule/core');

    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const scheduler = new Scheduler(joule);

    const resumed = await scheduler.resume(id);
    if (resumed) {
      console.log(`Schedule ${id} resumed.`);
    } else {
      console.error(`Schedule ${id} not found.`);
      process.exit(1);
    }
  });

scheduleCommand
  .command('logs')
  .description('Show recent schedule execution logs')
  .option('--limit <n>', 'Number of log entries', '20')
  .action(async (options) => {
    const { Joule } = await import('@joule/core');
    const { Scheduler } = await import('@joule/core');

    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const scheduler = new Scheduler(joule);

    const logs = await scheduler.getLogs(parseInt(options.limit, 10));
    if (logs.length === 0) {
      console.log('No execution logs.');
      return;
    }

    console.log(`\nRecent Runs (${logs.length}):\n`);
    for (const log of logs) {
      console.log(`  ${log.completedAt} | ${log.scheduleId} | ${log.status}`);
      console.log(`    Energy: ${log.energyWh.toFixed(4)} Wh | Tokens: ${log.tokensUsed}`);
    }
  });
