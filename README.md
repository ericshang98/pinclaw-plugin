# Pinclaw — OpenClaw Hardware Voice Plugin

> Turn your [OpenClaw](https://openclaw.ai) into a wearable AI voice assistant.

Pinclaw is a hardware clip you wear. It has a microphone, speaker, and button. Speak to it, and your OpenClaw agent responds through your earpiece — no phone needed.

**This repo is the OpenClaw plugin.** It connects the Pinclaw hardware (via the iPhone companion app) to your existing OpenClaw agent, giving it a voice.

```
Pinclaw Clip ──BLE──> iPhone App ──WebSocket──> [This Plugin] ──RPC──> OpenClaw Agent ──> AI
 (mic/speaker)        (STT/TTS)                (port 18790)           (your agent)       (LLM)
```

## What you need

1. **Pinclaw hardware** — [pinclaw.ai](https://pinclaw.ai)
2. **Pinclaw iOS app** — App Store (pairs with your clip via Bluetooth)
3. **OpenClaw** — self-hosted or cloud, running in gateway mode
4. **This plugin** — installed in your OpenClaw plugins directory

## Install

```bash
cd ~/.openclaw/plugins
git clone https://github.com/ericshang98/pinclaw-plugin.git pinclaw
cd pinclaw
npm install
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
openclaw gateway restart
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
| **Pinclaw session** | Creates a dedicated `pinclaw` session in your OpenClaw with voice-optimized rules |
| **Voice format** | Injects XML response format (voice/display/sound modes) so the AI responds in speech-friendly chunks |
| **Personality** | Loads a default SOUL personality — concise, no filler, speed-first. You can customize it |
| **Cron notifications** | Routes cron/announce results through the Pinclaw session AI, compresses them for voice, and pushes to your clip |
| **Offline queue** | Queues messages when your clip is disconnected, delivers them when it reconnects |
| **Device tools** | The iPhone app can register tools (contacts, location, etc.) that the AI can call |

### How notifications work

When a cron job or background task completes in another session, the result flows through the plugin:

```
Cron result: "航班查询完成：CA1234 07:20 ¥680, MU5678 09:00 ¥520"
                    │
                    ▼
        Plugin receives via outbound.sendText()
                    │
                    ▼
        Routes to Pinclaw session AI (has voice rules)
                    │
                    ▼
        AI compresses: <mode>voice</mode><voice>最早航班7点20</voice>
                    │
                    ▼
        Pushes to hardware → you hear "最早航班7点20"
```

No setup needed — this works automatically once the plugin is installed.

## Customize the personality

The plugin ships with a default personality. To customize:

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

The personality controls how the AI talks through the clip — tone, language, verbosity. The technical voice rules (XML format, character limits) are handled separately by the plugin and cannot be overridden.

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `channels.pinclaw.enabled` | `true` | Enable/disable the plugin |
| `channels.pinclaw.authToken` | `""` | Shared secret between server and iPhone app |
| `channels.pinclaw.wsPort` | `18790` | WebSocket server port |
| `notes.soul` | (built-in) | Custom AI personality |

## HTTP endpoints

The plugin exposes these endpoints on the WebSocket port:

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check (`{"ok": true}`) |
| `/message` | POST | Yes | Send a message (HTTP fallback when WS is down) |
| `/notify` | POST | Yes | Push a notification from another session to the clip |
| `/devices` | GET | Yes | List connected devices |
| `/pending` | GET | Yes | Retrieve queued offline messages |
| `/cron/jobs` | GET/POST | Yes | List or create cron jobs |
| `/cron/jobs/:id` | DELETE | Yes | Delete a cron job |
| `/cron/jobs/:id/toggle` | POST | Yes | Enable/disable a cron job |

Auth: `Authorization: Bearer <authToken>` header or `token` field in request body.

## Development

### Run tests

```bash
npm install
npx tsx test/pinclaw-server.test.ts
```

99 tests covering WebSocket protocol, HTTP endpoints, Gateway RPC, cron management, device tools, and offline queue.

### Project structure

```
pinclaw/
├── index.ts                      # Plugin entry — hooks, SOUL injection, voice rules
├── openclaw.plugin.json          # OpenClaw plugin manifest
├── package.json
├── src/
│   ├── ws-server.ts              # Core: WebSocket server + HTTP + Gateway RPC
│   ├── channel.ts                # OpenClaw channel adapter (outbound, config, lifecycle)
│   ├── types.ts                  # WebSocket protocol message types
│   └── runtime.ts                # Global state (server instance ref)
└── test/
    └── pinclaw-server.test.ts    # Full test suite
```

## FAQ

**Do I need the iPhone app?**
Yes. The iPhone handles Bluetooth communication with the clip, speech-to-text, and text-to-speech. The plugin is the server-side component.

**Can I use this without the hardware?**
The plugin runs fine without hardware connected (messages queue up). But without the clip + iPhone app, there's nothing to talk to.

**Does this work with any OpenClaw model?**
Yes. The plugin works with whatever model your OpenClaw agent is configured to use. It just adds voice formatting rules to the responses.

**Can I use Pinclaw Cloud instead of self-hosting?**
Yes. [pinclaw.ai](https://pinclaw.ai) offers a hosted service where you don't need to run OpenClaw yourself. This repo is for users who prefer to self-host.

## License

MIT
