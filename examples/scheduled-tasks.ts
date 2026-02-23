/**
 * Joule Scheduled Tasks
 *
 * Demonstrates adding cron schedules, listing them,
 * and toggling enable/disable (pause/resume).
 */

import { Joule } from '@joule/core';
import { Scheduler } from '@joule/core';

async function main() {
  const joule = new Joule();
  await joule.initialize();

  // Create a scheduler with custom file paths
  const scheduler = new Scheduler(joule, {
    scheduleFile: '.joule/example-schedules.json',
    logFile: '.joule/example-schedule-logs.json',
  });

  console.log('--- Adding Schedules ---');

  // Add some scheduled tasks
  const morning = await scheduler.add(
    'Morning Briefing',
    '0 9 * * *',
    'Summarize the latest news headlines and weather forecast',
    'low',
  );
  console.log(`Added: ${morning.name} (${morning.id}) - cron: ${morning.cron}`);

  const hourly = await scheduler.add(
    'System Health Check',
    '0 * * * *',
    'Check system health metrics and report any anomalies',
    'low',
  );
  console.log(`Added: ${hourly.name} (${hourly.id}) - cron: ${hourly.cron}`);

  const weekly = await scheduler.add(
    'Weekly Energy Report',
    '0 18 * * 5',
    'Generate a weekly energy consumption report across all tasks',
    'medium',
  );
  console.log(`Added: ${weekly.name} (${weekly.id}) - cron: ${weekly.cron}`);

  // List all schedules
  console.log('');
  console.log('--- All Schedules ---');
  const all = await scheduler.list();
  for (const s of all) {
    console.log(`  [${s.enabled ? 'ON ' : 'OFF'}] ${s.name} — ${s.cron} (budget: ${s.budgetPreset})`);
  }

  // Pause a schedule
  console.log('');
  console.log(`Pausing: ${hourly.name}`);
  await scheduler.toggle(hourly.id, false);

  // Remove a schedule
  console.log(`Removing: ${weekly.name}`);
  await scheduler.remove(weekly.id);

  // List again
  console.log('');
  console.log('--- Updated Schedules ---');
  const updated = await scheduler.list();
  for (const s of updated) {
    console.log(`  [${s.enabled ? 'ON ' : 'OFF'}] ${s.name} — ${s.cron}`);
  }

  console.log('');
  console.log('To start the scheduler daemon, call scheduler.start()');
  console.log('It will tick every 60 seconds and execute matching schedules.');

  await joule.shutdown();
}

main().catch(console.error);
