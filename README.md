# Pinclaw — OpenClaw Hardware Voice Plugin

> Turn your [OpenClaw](https://openclaw.ai) into a wearable AI voice assistant.

Pinclaw is a hardware clip you wear. It has a microphone, speaker, and button. Speak to it, and your OpenClaw agent responds through your earpiece — no phone needed.

**This repo is the OpenClaw plugin.** It connects the Pinclaw hardware (via the iPhone companion app) to your existing OpenClaw agent, giving it a voice.

```
Pinclaw Clip ──BLE──> iPhone App ──WebSocket──> [This Plugin] ──RPC──> OpenClaw Agent ──> AI
 (mic/speaker)        (STT/TTS)                (port 18790)           (your agent)       (LLM)
```

## What you need

1. **OpenClaw** — self-hosted, running in gateway mode
2. **Pinclaw iOS app** — pairs with your clip via Bluetooth
3. **Pinclaw hardware** — [pinclaw.ai](https://pinclaw.ai) (or use the BLE simulator for development)

## Install

```bash
npm install pinclaw
```

Or install manually:

```bash
cd ~/.openclaw/plugins
git clone https://github.com/ericshang98/pinclaw-plugin.git pinclaw
cd pinclaw && npm install
```

Then add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["pinclaw"]
  },
  "channels": {
    "pinclaw": {
      "enabled": true,
      "authToken": "your-secret-token",
      "wsPort": 18790
    }
  }
}
```

Restart your OpenClaw gateway:

```bash
openclaw gateway --force
```

The plugin starts automatically. You should see:

```
[pinclaw] WebSocket server started on port 18790
```

## Configure the iPhone app

1. Open the Pinclaw app on your iPhone
2. Go to **Settings** → **Server**
3. Enter your server address: `ws://YOUR_IP:18790`
4. Enter the same auth token you set in `openclaw.json`
5. Tap **Connect**

That's it. Press the button on your clip and talk.

## What the plugin does

When you install this plugin, it automatically:

| Feature | What it does |
|---------|-------------|
| **Voice interface** | Creates a hardware voice channel with speech-optimized AI responses |
| **Personality** | Loads a default SOUL personality — concise, no filler, speed-first. Customizable via iPhone app or config |
| **Device tools** | iPhone app registers tools (contacts, calendar, location, etc.) that the AI can call |
| **Server tools** | Extensible tool registry — add your own server-side tools in `src/tools/` |
| **Cron notifications** | Routes scheduled task results to your hardware clip |
| **Cloud STT** | Optional Deepgram integration for higher-quality speech recognition |
| **Interactive AI** | Play button for proactive AI check-ins |
| **Remote access** | Optional cloud relay for accessing your plugin outside your LAN |

## Configuration reference

### openclaw.json

| Key | Default | Description |
|-----|---------|-------------|
| `channels.pinclaw.enabled` | `true` | Enable/disable the plugin |
| `channels.pinclaw.authToken` | `""` | Shared secret between server and iPhone app |
| `channels.pinclaw.wsPort` | `18790` | WebSocket server port |
| `notes.soul` | (built-in) | Custom AI personality |

### Environment variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `DEEPGRAM_API_KEY` | Cloud speech-to-text (Deepgram) | No |
| `AI_API_KEY` | Interactive AI (Play button) API key | No |
| `AI_BASE_URL` | Interactive AI API endpoint | No |
| `AI_LIGHT_MODEL` | Light model for Interactive AI (default: `kimi-k2`) | No |
| `PINCLAW_RELAY_TOKEN` | Cloud relay authentication token | No |
| `PINCLAW_RELAY_URL` | Cloud relay URL (default: `wss://api.pinclaw.ai`) | No |

## HTTP API

The plugin exposes these endpoints on the WebSocket port:

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check (`{"ok": true}`) |
| `/message` | POST | Yes | Send a text message |
| `/devices` | GET | Yes | List connected devices |
| `/cron/jobs` | GET | Yes | List cron jobs |
| `/cron/jobs` | POST | Yes | Create a cron job |
| `/cron/jobs/:id` | DELETE | Yes | Delete a cron job |
| `/cron/jobs/:id/toggle` | POST | Yes | Enable/disable a cron job |
| `/skills` | GET | Yes | List device skills |

Auth: `Authorization: Bearer <authToken>` header.

## Remote access

**Option A: Cloud relay** (recommended)

Set `PINCLAW_RELAY_TOKEN` in your environment. The plugin connects outbound to `wss://api.pinclaw.ai` and your iPhone connects through the relay — no port forwarding needed.

**Option B: VPN / Tailscale**

Connect your iPhone and server to the same VPN network. Point the app at your server's VPN IP.

## Extending with server tools

You can add custom server-side tools that the AI can invoke. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

Quick version: create a `.ts` file in `src/tools/`, export a `ServerToolDef`:

```typescript
import type { ServerToolDef } from "./types.js";

const tool: ServerToolDef = {
  name: "my_tool",
  description: "Does something useful",
  parameters: [
    { name: "query", type: "string", required: true, description: "Search query" }
  ],
  async execute(params, context) {
    // Your logic here
    return JSON.stringify({ result: "done" });
  },
};

export default tool;
```

Tools are auto-discovered on startup. Files starting with `_` are ignored.

## Customize the personality

The plugin ships with a default personality optimized for voice interaction. To customize:

**Option A: Edit via iPhone app**
Settings → Personality → Edit

**Option B: Edit the config directly**
Add to your `openclaw.json`:
```json
{
  "notes": {
    "soul": "Your custom personality instructions here..."
  }
}
```

## Project structure

```
pinclaw-plugin/
├── index.ts                  # Plugin entry — hooks, SOUL injection
├── openclaw.plugin.json      # OpenClaw plugin manifest
├── package.json
├── src/
│   ├── channel.ts            # OpenClaw channel adapter
│   ├── ws-server.ts          # Server factory export
│   ├── runtime.ts            # Global state refs
│   ├── types.ts              # WebSocket protocol types
│   ├── interactive-ai.ts     # Interactive AI (Play button)
│   ├── deepgram-stt.ts       # Deepgram cloud STT
│   ├── relay-client.ts       # Cloud relay client
│   ├── core/
│   │   ├── server.ts         # Core WebSocket + HTTP server
│   │   ├── ws-handler.ts     # WebSocket connection handler
│   │   ├── http-router.ts    # HTTP API routes
│   │   ├── gateway-rpc.ts    # OpenClaw Gateway RPC client
│   │   ├── device-manager.ts # Device connection management
│   │   ├── device-identity.ts# Device identity verification
│   │   ├── ai-pipeline.ts    # AI call pipeline
│   │   ├── cron-proxy.ts     # Cron job management
│   │   ├── skills-crud.ts    # Device skills CRUD
│   │   ├── version-check.ts  # Version check client
│   │   └── utils.ts          # Shared utilities
│   └── tools/
│       ├── registry.ts       # Auto-discovery tool registry
│       ├── types.ts          # ServerToolDef interface
│       └── _example.ts       # Example tool (ignored by registry)
```

## FAQ

**Do I need the iPhone app?**
Yes. The iPhone handles Bluetooth communication with the clip, speech-to-text, and text-to-speech. The plugin is the server-side component.

**Can I use this without the hardware?**
The plugin runs fine without hardware connected. You can use the BLE simulator (`swift peripheral_simulator.swift`) for development.

**Does this work with any OpenClaw model?**
Yes. The plugin works with whatever model your OpenClaw agent is configured to use.

**Can I use Pinclaw Cloud instead of self-hosting?**
Yes. [pinclaw.ai](https://pinclaw.ai) offers a hosted service. This repo is for users who prefer to self-host.

## License

MIT
