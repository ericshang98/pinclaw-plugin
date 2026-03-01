# Contributing to Pinclaw

Thanks for your interest in contributing! The most impactful way to contribute is by adding **server tools** — custom capabilities that the AI can invoke on your server.

## Adding a Server Tool

Server tools live in `src/tools/`. Each tool is a single `.ts` file that exports a `ServerToolDef` object. The tool registry auto-discovers and loads them on startup.

### Quick start

1. Create a new file in `src/tools/` (e.g., `weather.ts`)
2. Export a default object implementing `ServerToolDef`
3. Restart the gateway — your tool is available

### Interface

```typescript
// src/tools/types.ts

interface ServerToolDef {
  name: string;                    // Tool name (snake_case, unique)
  description: string;             // What the tool does (shown to AI)
  parameters: ServerToolParam[];   // Input parameters
  execute(
    params: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<string>;              // Must return a string result
}

interface ServerToolParam {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;              // default: true
  description?: string;
}

interface ToolExecutionContext {
  deviceId: string;                // Connected device ID
  log: Logger;                     // Structured logger
  gatewayRpc?: (              // Optional: call Gateway RPC methods
    method: string,
    params: Record<string, unknown>
  ) => Promise<any>;
}
```

### Full example

```typescript
// src/tools/weather.ts
import type { ServerToolDef } from "./types.js";

const tool: ServerToolDef = {
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: [
    { name: "city", type: "string", required: true, description: "City name" },
    { name: "unit", type: "string", required: false, description: "celsius or fahrenheit" },
  ],
  async execute(params, context) {
    const { city, unit = "celsius" } = params;
    context.log.info(`[get_weather] Looking up weather for ${city}`);

    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    const data = await res.json();
    const current = data.current_condition[0];

    return JSON.stringify({
      city,
      temp: unit === "fahrenheit" ? current.temp_F + "°F" : current.temp_C + "°C",
      description: current.weatherDesc[0].value,
      humidity: current.humidity + "%",
    });
  },
};

export default tool;
```

### Conventions

- **File naming**: `kebab-case.ts` (e.g., `smart-home.ts`)
- **Tool naming**: `snake_case` (e.g., `smart_home_control`)
- **Files starting with `_`** are ignored by auto-discovery (use for examples/drafts)
- **Return value**: Always return a JSON string. The AI reads this to compose its response.
- **Error handling**: Throw an error with a descriptive message. The framework catches it and reports to the AI.
- **Side effects**: Tools can do anything — HTTP calls, file I/O, shell commands. Keep them focused and secure.

### Testing your tool

1. Add your tool file to `src/tools/`
2. Restart: `openclaw gateway --force`
3. Check logs for `Server tool registered: your_tool_name`
4. Talk to your Pinclaw: "use [tool description]" — the AI will call it

## Pull request guidelines

1. One tool per PR (unless they're closely related)
2. Include a brief description of what the tool does and why it's useful
3. Test with an actual OpenClaw gateway before submitting
4. No hardcoded API keys — use environment variables

## Code style

- TypeScript, ES modules (`import`/`export`)
- No semicolons at statement end is fine; be consistent within your file
- Minimal dependencies — prefer Node.js built-ins and `fetch`

## Reporting issues

Open an issue on GitHub. Include:
- Your OpenClaw version
- Plugin version (`npm list pinclaw`)
- Error logs (redact any tokens)
- Steps to reproduce
