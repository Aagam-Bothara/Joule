import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginManager } from '../src/plugin-manager.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('PluginManager', () => {
  let manager: PluginManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `joule-plugins-test-${Date.now()}`);
    manager = new PluginManager(tempDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('creates plugins directory on first access', async () => {
    const plugins = await manager.list();
    expect(plugins).toEqual([]);
    const stat = await fs.stat(tempDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('lists empty when no plugins installed', async () => {
    const plugins = await manager.list();
    expect(plugins).toHaveLength(0);
  });

  it('persists installed.json after manual write', async () => {
    // Simulate what install() does by writing installed.json directly
    await fs.mkdir(tempDir, { recursive: true });
    const installedData = [{
      manifest: {
        name: 'joule-plugin-test',
        version: '1.0.0',
        description: 'Test plugin',
        author: 'test',
        tools: ['test_tool'],
      },
      installedAt: new Date().toISOString(),
      path: path.join(tempDir, 'node_modules', 'joule-plugin-test'),
      enabled: true,
    }];
    await fs.writeFile(
      path.join(tempDir, 'installed.json'),
      JSON.stringify(installedData, null, 2),
      'utf-8',
    );

    const plugins = await manager.list();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe('joule-plugin-test');
    expect(plugins[0].manifest.tools).toEqual(['test_tool']);
  });

  it('enables and disables a plugin', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const installedData = [{
      manifest: {
        name: 'joule-plugin-example',
        version: '1.0.0',
        description: 'Example',
        author: 'test',
        tools: [],
      },
      installedAt: new Date().toISOString(),
      path: path.join(tempDir, 'node_modules', 'joule-plugin-example'),
      enabled: true,
    }];
    await fs.writeFile(
      path.join(tempDir, 'installed.json'),
      JSON.stringify(installedData),
      'utf-8',
    );

    // Disable
    const disabled = await manager.disable('example');
    expect(disabled).toBe(true);
    let plugins = await manager.list();
    expect(plugins[0].enabled).toBe(false);

    // Enable
    const enabled = await manager.enable('example');
    expect(enabled).toBe(true);
    plugins = await manager.list();
    expect(plugins[0].enabled).toBe(true);
  });

  it('returns false when enabling non-existent plugin', async () => {
    const result = await manager.enable('nonexistent');
    expect(result).toBe(false);
  });

  it('returns false when disabling non-existent plugin', async () => {
    const result = await manager.disable('nonexistent');
    expect(result).toBe(false);
  });

  it('uninstall removes from installed list', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const installedData = [{
      manifest: {
        name: 'joule-plugin-to-remove',
        version: '1.0.0',
        description: 'Will be removed',
        author: 'test',
        tools: [],
      },
      installedAt: new Date().toISOString(),
      path: path.join(tempDir, 'node_modules', 'joule-plugin-to-remove'),
      enabled: true,
    }];
    await fs.writeFile(
      path.join(tempDir, 'installed.json'),
      JSON.stringify(installedData),
      'utf-8',
    );

    const removed = await manager.uninstall('to-remove');
    expect(removed).toBe(true);

    const plugins = await manager.list();
    expect(plugins).toHaveLength(0);
  });

  it('loadAll skips disabled plugins', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const installedData = [{
      manifest: {
        name: 'joule-plugin-disabled',
        version: '1.0.0',
        description: 'Disabled',
        author: 'test',
        tools: [],
      },
      installedAt: new Date().toISOString(),
      path: path.join(tempDir, 'node_modules', 'joule-plugin-disabled'),
      enabled: false,
    }];
    await fs.writeFile(
      path.join(tempDir, 'installed.json'),
      JSON.stringify(installedData),
      'utf-8',
    );

    const loaded = await manager.loadAll();
    expect(loaded).toHaveLength(0);
  });

  it('handles concurrent list calls', async () => {
    const [list1, list2, list3] = await Promise.all([
      manager.list(),
      manager.list(),
      manager.list(),
    ]);
    expect(list1).toEqual([]);
    expect(list2).toEqual([]);
    expect(list3).toEqual([]);
  });

  it('reloads state from disk with new instance', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const installedData = [{
      manifest: {
        name: 'joule-plugin-persist',
        version: '2.0.0',
        description: 'Persistent',
        author: 'test',
        tools: ['tool_a', 'tool_b'],
      },
      installedAt: new Date().toISOString(),
      path: path.join(tempDir, 'node_modules', 'joule-plugin-persist'),
      enabled: true,
    }];
    await fs.writeFile(
      path.join(tempDir, 'installed.json'),
      JSON.stringify(installedData),
      'utf-8',
    );

    // Create new manager pointing to same dir
    const manager2 = new PluginManager(tempDir);
    const plugins = await manager2.list();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.version).toBe('2.0.0');
    expect(plugins[0].manifest.tools).toEqual(['tool_a', 'tool_b']);
  });
});
