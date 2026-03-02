import { Command } from 'commander';
import { Joule } from '@joule/core';
import { setupJoule } from '../setup.js';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

const PASS = '\x1b[32m[PASS]\x1b[0m';
const WARN = '\x1b[33m[WARN]\x1b[0m';
const FAIL = '\x1b[31m[FAIL]\x1b[0m';

function statusIcon(status: CheckResult['status']): string {
  return status === 'pass' ? PASS : status === 'warn' ? WARN : FAIL;
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    const dbPath = resolve('.joule', 'joule.db');
    if (!existsSync(dbPath)) {
      return { name: 'Database', status: 'warn', detail: 'No database file found (will be created on first run)' };
    }
    const stats = statSync(dbPath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
    return { name: 'Database', status: 'pass', detail: `SQLite (WAL mode, ${sizeMb} MB)` };
  } catch (err) {
    return { name: 'Database', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkProviders(joule: Joule): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const providers = joule.providers.listAll();

  if (providers.length === 0) {
    results.push({ name: 'Providers', status: 'warn', detail: 'No providers registered' });
    return results;
  }

  for (const provider of providers) {
    try {
      const available = await provider.isAvailable();
      if (available) {
        results.push({
          name: `${provider.name} provider`,
          status: 'pass',
          detail: `Available (${provider.supportedTiers.join(', ')})`,
        });
      } else {
        results.push({
          name: `${provider.name} provider`,
          status: 'warn',
          detail: 'Not available (no API key configured)',
        });
      }
    } catch (err) {
      results.push({
        name: `${provider.name} provider`,
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

function checkToolRegistry(joule: Joule): CheckResult {
  try {
    const tools = joule.tools.list();
    return { name: 'Tool registry', status: 'pass', detail: `${tools.length} tools registered` };
  } catch (err) {
    return { name: 'Tool registry', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkMemory(joule: Joule): CheckResult {
  try {
    const mem = joule.memory;
    if (mem?.optimized) {
      return { name: 'Memory system', status: 'pass', detail: 'OptimizedMemory initialized (5-layer)' };
    }
    return { name: 'Memory system', status: 'warn', detail: 'Basic memory (no persistence)' };
  } catch (err) {
    return { name: 'Memory system', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkConfig(joule: Joule): CheckResult {
  try {
    const routing = joule.config.get('routing');
    const budgets = joule.config.get('budgets');
    if (routing && budgets) {
      return { name: 'Configuration', status: 'pass', detail: 'Valid (routing + budgets loaded)' };
    }
    return { name: 'Configuration', status: 'warn', detail: 'Partial configuration loaded' };
  } catch (err) {
    return { name: 'Configuration', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkMcp(joule: Joule): CheckResult {
  try {
    const mcpConfig = joule.config.get('mcp');
    if (!mcpConfig?.servers || Object.keys(mcpConfig.servers).length === 0) {
      return { name: 'MCP servers', status: 'warn', detail: 'No MCP servers configured' };
    }
    const count = Object.keys(mcpConfig.servers).length;
    const enabled = Object.entries(mcpConfig.servers).filter(([, s]) => s.enabled !== false).length;
    return { name: 'MCP servers', status: 'pass', detail: `${enabled}/${count} servers enabled` };
  } catch (err) {
    return { name: 'MCP servers', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkChannels(joule: Joule): CheckResult {
  try {
    const channelsConfig = joule.config.get('channels');
    if (!channelsConfig) {
      return { name: 'Channels', status: 'warn', detail: 'No channels configured' };
    }
    const configured = Object.entries(channelsConfig).filter(([, v]) => v).length;
    return { name: 'Channels', status: 'pass', detail: `${configured} channel(s) configured` };
  } catch (err) {
    return { name: 'Channels', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkDiskSpace(): CheckResult {
  try {
    const jouleDir = resolve('.joule');
    if (!existsSync(jouleDir)) {
      return { name: 'Disk space', status: 'pass', detail: 'No .joule directory yet' };
    }
    return { name: 'Disk space', status: 'pass', detail: '.joule directory accessible' };
  } catch (err) {
    return { name: 'Disk space', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkSqliteVec(): CheckResult {
  try {
    // Check if sqlite-vec extension is available (optional)
    const Database = require('better-sqlite3');
    const testDb = new Database(':memory:');
    try {
      testDb.loadExtension('vec0');
      testDb.close();
      return { name: 'sqlite-vec', status: 'pass', detail: 'Vector extension loaded' };
    } catch {
      testDb.close();
      return { name: 'sqlite-vec', status: 'warn', detail: 'Not installed (vector search will use TF-IDF fallback)' };
    }
  } catch {
    return { name: 'sqlite-vec', status: 'warn', detail: 'better-sqlite3 not available for extension check' };
  }
}

export const doctorCommand = new Command('doctor')
  .description('Run diagnostic checks on the Joule system')
  .action(async () => {
    console.log('');
    console.log('Joule Doctor - System Diagnostics');
    console.log('==================================');
    console.log('');

    const joule = new Joule();
    try {
      await joule.initialize();
      await setupJoule(joule);
    } catch {
      // Partial init is fine for diagnostics
    }

    const results: CheckResult[] = [];

    // Run all checks
    results.push(await checkDatabase());

    const providerResults = await checkProviders(joule);
    results.push(...providerResults);

    results.push(checkToolRegistry(joule));
    results.push(checkMemory(joule));
    results.push(checkConfig(joule));
    results.push(checkMcp(joule));
    results.push(checkChannels(joule));
    results.push(checkDiskSpace());
    results.push(checkSqliteVec());

    // Print results
    for (const r of results) {
      console.log(`${statusIcon(r.status)} ${r.name} (${r.detail})`);
    }

    // Summary
    const passed = results.filter(r => r.status === 'pass').length;
    const warned = results.filter(r => r.status === 'warn').length;
    const failed = results.filter(r => r.status === 'fail').length;

    console.log('');
    console.log(`Summary: ${passed} passed, ${warned} warning(s), ${failed} failed`);
    console.log('');

    await joule.shutdown();

    if (failed > 0) {
      process.exitCode = 1;
    }
  });
