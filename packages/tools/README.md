# @joule/tools

Built-in tool implementations, MCP client, and plugin system for Joule. Tools
follow the `ToolDefinition` pattern with Zod schemas for input/output validation.

## Installation

```bash
pnpm add @joule/tools
```

Optional peer dependencies for extended functionality:

```bash
pnpm add playwright   # browser automation tools
pnpm add mqtt         # IoT MQTT tools
```

## Key Exports

### Filesystem Tools

- `fileReadTool` -- read file contents with optional truncation
- `fileWriteTool` -- write or overwrite file contents

### Shell and HTTP

- `shellExecTool` -- execute shell commands
- `httpFetchTool` -- make HTTP requests

### Data

- `jsonTransformTool` -- transform JSON with JSONPath expressions

### Memory Tools

- `memoryPutTool`, `memoryGetTool` -- low-level key-value memory
- `memoryStoreTool`, `memoryRecallTool` -- semantic memory store/recall
- `memoryEpisodesTool` -- retrieve episodic memory entries
- `memoryPreferencesTool` -- manage user preference memory

### Browser Tools (requires Playwright)

- `browserNavigateTool` -- navigate to a URL
- `browserScreenshotTool` -- capture a screenshot
- `browserClickTool` -- click an element
- `browserTypeTool` -- type text into an element
- `browserExtractTool` -- extract content from the page
- `browserEvaluateTool` -- evaluate JavaScript in the page
- `configureBrowser(config)` -- set browser options
- `closeBrowser()` -- shut down the browser instance

### IoT Tools

- `iotMqttPublishTool` -- publish an MQTT message (requires mqtt)
- `iotMqttSubscribeTool` -- subscribe to an MQTT topic (requires mqtt)
- `iotHomeAssistantControlTool` -- control a Home Assistant entity
- `iotHomeAssistantStatusTool` -- query Home Assistant entity status
- `configureIot(config)` -- set IoT connection options

### MCP Client

- `McpClient` -- connect to Model Context Protocol servers
- `mcpToolToJouleToolDefinition()` -- convert MCP tools to Joule ToolDefinitions
- `jsonSchemaToZod()` -- convert JSON Schema to Zod schemas

### Plugin System

- `PluginManager` -- discover and load plugins from directories
- `loadPluginFromFile(path)` -- load a single plugin file
- `loadPluginsFromDirectory(dir)` -- load all plugins in a directory

## Usage

```typescript
import { fileReadTool, shellExecTool, McpClient } from '@joule/tools';

// Execute a tool directly
const result = await fileReadTool.execute({
  path: './README.md',
  encoding: 'utf-8',
  maxBytes: 100_000,
});
console.log(result.content);

// Connect to an MCP server
const mcp = new McpClient('filesystem');
await mcp.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
});
const tools = await mcp.listTools();
```
