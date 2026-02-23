import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstalledPlugin, PluginManifest, PluginRegistryEntry } from '@joule/shared';
import { isoNow } from '@joule/shared';
import { loadPluginFromFile, type JoulePlugin } from './plugin.js';

const execFileAsync = promisify(execFile);
const INSTALLED_FILE = 'installed.json';
const PLUGIN_PREFIX = 'joule-plugin-';

export class PluginManager {
  private pluginsDir: string;
  private installed: InstalledPlugin[] = [];
  private loaded = false;

  constructor(pluginsDir?: string) {
    this.pluginsDir = pluginsDir ?? path.join(process.cwd(), '.joule', 'plugins');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.pluginsDir, { recursive: true });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.ensureDir();
    try {
      const content = await fs.readFile(path.join(this.pluginsDir, INSTALLED_FILE), 'utf-8');
      this.installed = JSON.parse(content) as InstalledPlugin[];
    } catch {
      this.installed = [];
    }
    this.loaded = true;
  }

  private async saveInstalled(): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(
      path.join(this.pluginsDir, INSTALLED_FILE),
      JSON.stringify(this.installed, null, 2),
      'utf-8',
    );
  }

  async install(name: string, version?: string): Promise<InstalledPlugin> {
    await this.ensureLoaded();

    const packageName = name.startsWith(PLUGIN_PREFIX) ? name : `${PLUGIN_PREFIX}${name}`;
    const spec = version ? `${packageName}@${version}` : packageName;

    // Install via npm into plugins directory
    await execFileAsync('npm', ['install', '--prefix', this.pluginsDir, spec], {
      timeout: 120_000,
    });

    // Read installed package.json for manifest
    const pkgJsonPath = path.join(this.pluginsDir, 'node_modules', packageName, 'package.json');
    const pkgContent = await fs.readFile(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(pkgContent) as Record<string, unknown>;

    const manifest: PluginManifest = {
      name: packageName,
      version: (pkg.version as string) ?? '0.0.0',
      description: (pkg.description as string) ?? '',
      author: typeof pkg.author === 'string' ? pkg.author : (pkg.author as Record<string, string>)?.name ?? 'unknown',
      homepage: pkg.homepage as string | undefined,
      tools: ((pkg as Record<string, unknown>).joulePlugin as Record<string, unknown>)?.tools as string[] ?? [],
      keywords: pkg.keywords as string[] | undefined,
      jouleVersion: ((pkg as Record<string, unknown>).joulePlugin as Record<string, unknown>)?.jouleVersion as string | undefined,
    };

    // Check if already installed, update if so
    const existingIdx = this.installed.findIndex(p => p.manifest.name === packageName);
    const plugin: InstalledPlugin = {
      manifest,
      installedAt: isoNow(),
      path: path.join(this.pluginsDir, 'node_modules', packageName),
      enabled: true,
    };

    if (existingIdx >= 0) {
      this.installed[existingIdx] = plugin;
    } else {
      this.installed.push(plugin);
    }

    await this.saveInstalled();
    return plugin;
  }

  async uninstall(name: string): Promise<boolean> {
    await this.ensureLoaded();

    const packageName = name.startsWith(PLUGIN_PREFIX) ? name : `${PLUGIN_PREFIX}${name}`;

    try {
      await execFileAsync('npm', ['uninstall', '--prefix', this.pluginsDir, packageName], {
        timeout: 60_000,
      });
    } catch {
      // npm uninstall may fail if package wasn't npm-installed
    }

    const idx = this.installed.findIndex(p => p.manifest.name === packageName);
    if (idx >= 0) {
      this.installed.splice(idx, 1);
      await this.saveInstalled();
      return true;
    }
    return false;
  }

  async list(): Promise<InstalledPlugin[]> {
    await this.ensureLoaded();
    return [...this.installed];
  }

  async enable(name: string): Promise<boolean> {
    await this.ensureLoaded();
    const plugin = this.findPlugin(name);
    if (plugin) {
      plugin.enabled = true;
      await this.saveInstalled();
      return true;
    }
    return false;
  }

  async disable(name: string): Promise<boolean> {
    await this.ensureLoaded();
    const plugin = this.findPlugin(name);
    if (plugin) {
      plugin.enabled = false;
      await this.saveInstalled();
      return true;
    }
    return false;
  }

  async loadAll(): Promise<JoulePlugin[]> {
    await this.ensureLoaded();
    const plugins: JoulePlugin[] = [];

    for (const installed of this.installed) {
      if (!installed.enabled) continue;

      try {
        const mainFile = await this.resolveMainFile(installed.path);
        if (mainFile) {
          const plugin = await loadPluginFromFile(mainFile);
          plugins.push(plugin);
        }
      } catch {
        // Skip plugins that fail to load
      }
    }

    return plugins;
  }

  async search(query: string): Promise<PluginRegistryEntry[]> {
    try {
      const { stdout } = await execFileAsync(
        'npm', ['search', `${PLUGIN_PREFIX}${query}`, '--json'],
        { timeout: 30_000 },
      );
      const results = JSON.parse(stdout) as Array<{
        name: string;
        description: string;
        version: string;
        author?: { name?: string };
      }>;

      return results
        .filter(r => r.name.startsWith(PLUGIN_PREFIX))
        .map(r => ({
          name: r.name,
          description: r.description ?? '',
          latestVersion: r.version,
          author: r.author?.name ?? 'unknown',
        }));
    } catch {
      return [];
    }
  }

  private findPlugin(name: string): InstalledPlugin | undefined {
    const packageName = name.startsWith(PLUGIN_PREFIX) ? name : `${PLUGIN_PREFIX}${name}`;
    return this.installed.find(p => p.manifest.name === packageName || p.manifest.name === name);
  }

  private async resolveMainFile(pluginPath: string): Promise<string | null> {
    // Try package.json main field
    try {
      const pkgContent = await fs.readFile(path.join(pluginPath, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
      const main = (pkg.main as string) ?? 'index.js';
      const mainPath = path.join(pluginPath, main);
      if (existsSync(mainPath)) return mainPath;
    } catch {
      // Fall through
    }

    // Try common entry points
    for (const entry of ['index.js', 'index.mjs', 'dist/index.js']) {
      const entryPath = path.join(pluginPath, entry);
      if (existsSync(entryPath)) return entryPath;
    }

    return null;
  }
}
