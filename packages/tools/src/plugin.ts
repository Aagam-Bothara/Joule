import type { ToolDefinition } from '@joule/shared';
import { pathToFileURL } from 'node:url';
import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

export interface JoulePlugin {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export async function loadPluginFromFile(filePath: string): Promise<JoulePlugin> {
  const module = await import(pathToFileURL(filePath).href);

  if (module.plugin && typeof module.plugin === 'object') {
    return module.plugin as JoulePlugin;
  }

  if (typeof module.default === 'function') {
    return module.default() as JoulePlugin;
  }

  if (module.tools && Array.isArray(module.tools)) {
    return {
      name: filePath,
      version: '0.0.0',
      tools: module.tools,
    };
  }

  throw new Error(`Invalid plugin format: ${filePath}`);
}

export async function loadPluginsFromDirectory(dirPath: string): Promise<JoulePlugin[]> {
  const entries = await readdir(dirPath);
  const plugins: JoulePlugin[] = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const entryStat = await stat(fullPath);

    if (entryStat.isFile() && ['.ts', '.js', '.mjs'].includes(extname(entry))) {
      try {
        plugins.push(await loadPluginFromFile(fullPath));
      } catch {
        // Skip invalid plugins
      }
    }
  }

  return plugins;
}
