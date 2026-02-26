import type { Joule } from '@joule/core';
import {
  OllamaProvider,
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
} from '@joule/models';
import {
  fileReadTool,
  fileWriteTool,
  shellExecTool,
  httpFetchTool,
  jsonTransformTool,
  memoryPutTool,
  memoryGetTool,
  memoryStoreTool,
  memoryRecallTool,
  memoryEpisodesTool,
  memoryPreferencesTool,
  memoryStatsTool,
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserWaitAndClickTool,
  browserTypeTool,
  browserExtractTool,
  browserObserveTool,
  browserEvaluateTool,
  browserSnapshotTool,
  browserActTool,
  configureBrowser,
  iotMqttPublishTool,
  iotMqttSubscribeTool,
  iotHomeAssistantControlTool,
  iotHomeAssistantStatusTool,
  configureIot,
  captchaSolveImageTool,
  captchaSolveMathTool,
  captchaSolveTextTool,
  captchaSolveExternalTool,
  osScreenshotTool,
  osMouseTool,
  osKeyboardTool,
  osWindowTool,
  osOpenTool,
  osClipboardTool,
  configureOsAutomation,
  McpClient,
} from '@joule/tools';

// Track MCP clients for shutdown
const mcpClients: McpClient[] = [];

export async function setupJoule(joule: Joule): Promise<void> {
  // Initialize SQLite persistence — must happen before any other setup
  // that might read from or write to the store
  joule.initializeDatabase();

  const config = joule.config.getAll();

  // Register providers
  if (config.providers.ollama?.enabled) {
    joule.providers.register(new OllamaProvider({
      baseUrl: config.providers.ollama.baseUrl,
      model: config.providers.ollama.models.slm,
    }));
  }

  if (config.providers.anthropic?.enabled && config.providers.anthropic.apiKey) {
    joule.providers.register(new AnthropicProvider({
      apiKey: config.providers.anthropic.apiKey,
      slmModel: config.providers.anthropic.models.slm,
      llmModel: config.providers.anthropic.models.llm,
    }));
  }

  if (config.providers.openai?.enabled && config.providers.openai.apiKey) {
    joule.providers.register(new OpenAIProvider({
      apiKey: config.providers.openai.apiKey,
      slmModel: config.providers.openai.models.slm,
      llmModel: config.providers.openai.models.llm,
    }));
  }

  if (config.providers.google?.enabled && config.providers.google.apiKey) {
    joule.providers.register(new GoogleProvider({
      apiKey: config.providers.google.apiKey,
      slmModel: config.providers.google.models.slm,
      llmModel: config.providers.google.models.llm,
    }));
  }

  // Register built-in tools
  if (config.tools.builtinEnabled) {
    joule.tools.register(fileReadTool, 'builtin');
    joule.tools.register(fileWriteTool, 'builtin');
    joule.tools.register(shellExecTool, 'builtin');
    joule.tools.register(httpFetchTool, 'builtin');
    joule.tools.register(jsonTransformTool, 'builtin');
    joule.tools.register(memoryPutTool, 'builtin');
    joule.tools.register(memoryGetTool, 'builtin');
    joule.tools.register(memoryStoreTool, 'builtin');
    joule.tools.register(memoryRecallTool, 'builtin');
    joule.tools.register(memoryEpisodesTool, 'builtin');
    joule.tools.register(memoryPreferencesTool, 'builtin');
    joule.tools.register(memoryStatsTool, 'builtin');

    // Register CAPTCHA solving tools
    joule.tools.register(captchaSolveImageTool, 'builtin');
    joule.tools.register(captchaSolveMathTool, 'builtin');
    joule.tools.register(captchaSolveTextTool, 'builtin');
    joule.tools.register(captchaSolveExternalTool, 'builtin');

    // Register browser tools (Playwright is optional)
    try {
      await import('playwright');
      // Configure browser — auto-detect Chrome profile for login sessions
      configureBrowser({
        headless: false, // Browser automation needs to be visible
        profileDirectory: 'Profile 1', // mweeb19@gmail.com — "Manga Weeb" profile
        ...config.browser,
      });
      joule.tools.register(browserNavigateTool, 'builtin');
      joule.tools.register(browserScreenshotTool, 'builtin');
      joule.tools.register(browserClickTool, 'builtin');
      joule.tools.register(browserWaitAndClickTool, 'builtin');
      joule.tools.register(browserTypeTool, 'builtin');
      joule.tools.register(browserExtractTool, 'builtin');
      joule.tools.register(browserObserveTool, 'builtin');
      joule.tools.register(browserEvaluateTool, 'builtin');
      joule.tools.register(browserSnapshotTool, 'builtin');
      joule.tools.register(browserActTool, 'builtin');
    } catch (err) {
      // Playwright not installed — browser tools unavailable
      if (process.env.JOULE_DEBUG) {
        console.error('[debug] Browser tools unavailable:', (err as Error).message);
      }
    }

    // Register OS automation tools (no extra deps — uses OS-native commands)
    if (config.osAutomation) {
      configureOsAutomation(config.osAutomation);
    }
    joule.tools.register(osScreenshotTool, 'builtin');
    joule.tools.register(osMouseTool, 'builtin');
    joule.tools.register(osKeyboardTool, 'builtin');
    joule.tools.register(osWindowTool, 'builtin');
    joule.tools.register(osOpenTool, 'builtin');
    joule.tools.register(osClipboardTool, 'builtin');

    // Register IoT tools (MQTT is optional, Home Assistant uses fetch)
    if (config.iot) {
      configureIot(config.iot);
    }
    joule.tools.register(iotHomeAssistantControlTool, 'builtin');
    joule.tools.register(iotHomeAssistantStatusTool, 'builtin');
    try {
      await import('mqtt');
      joule.tools.register(iotMqttPublishTool, 'builtin');
      joule.tools.register(iotMqttSubscribeTool, 'builtin');
    } catch {
      // MQTT not installed — MQTT tools unavailable
    }
  }

  // Connect MCP servers
  if (config.mcp?.servers) {
    for (const [name, serverConfig] of Object.entries(config.mcp.servers)) {
      if (serverConfig.enabled === false) continue;

      try {
        const client = new McpClient(name);
        await client.connect(serverConfig);
        mcpClients.push(client);

        const tools = await client.listTools();
        for (const tool of tools) {
          joule.tools.register(tool, 'mcp');
        }
        console.log(`MCP: Connected to ${name} (${tools.length} tools)`);
      } catch (err) {
        console.warn(`MCP: Failed to connect to ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export async function shutdownMcp(): Promise<void> {
  for (const client of mcpClients) {
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }
  mcpClients.length = 0;
}
