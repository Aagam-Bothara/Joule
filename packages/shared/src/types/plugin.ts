export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  tools: string[];
  keywords?: string[];
  jouleVersion?: string;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  installedAt: string;
  path: string;
  enabled: boolean;
}

export interface PluginRegistryEntry {
  name: string;
  description: string;
  latestVersion: string;
  downloads?: number;
  author: string;
  verified?: boolean;
}

export interface PluginConfig {
  pluginsDir?: string;
  autoUpdate?: boolean;
  registry?: string;
}
