import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, generateKeyPairSync, sign, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILLS_DIR = join(homedir(), ".openclaw", "workspace", "skills");

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return { meta, body: match[2] };
}

function buildSkillMd(name: string, description: string, userInvocable: boolean, body: string): string {
  return `---\nname: "${name}"\ndescription: "${description}"\nuserInvocable: ${userInvocable}\n---\n${body}`;
}
import type {
  WsInboundMessage,
  WsOutboundMessage,
  PendingMessage,
  DeviceToolDef,
} from "./types.js";

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PENDING_MAX_PER_DEVICE = 20;

// ── Device Identity for Gateway RPC auth ──
interface DeviceIdentity {
  version: number;
  deviceId: string;      // SHA-256 of public key, hex
  publicKeyB64: string;  // raw 32-byte Ed25519 pubkey, base64url
  privateKeyDer: string; // DER-encoded private key, base64
}

const DEVICE_IDENTITY_PATH = join(homedir(), ".openclaw", "pinclaw-device-identity.json");

function getOrCreateDeviceIdentity(): DeviceIdentity {
  try {
    const data = JSON.parse(readFileSync(DEVICE_IDENTITY_PATH, "utf-8"));
    if (data.version === 1 && data.deviceId && data.publicKeyB64 && data.privateKeyDer) {
      return data;
    }
  } catch {}

  // Generate new Ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32); // last 32 bytes are the raw key
  const deviceId = createHash("sha256").update(pubRaw).digest("hex");
  const publicKeyB64 = base64url(pubRaw);
  const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

  const identity: DeviceIdentity = { version: 1, deviceId, publicKeyB64, privateKeyDer };
  try {
    mkdirSync(join(homedir(), ".openclaw"), { recursive: true });
    writeFileSync(DEVICE_IDENTITY_PATH, JSON.stringify(identity, null, 2));
  } catch {}

  return identity;
}

function signDevicePayload(identity: DeviceIdentity, payload: string): string {
  const { createPrivateKey } = require("node:crypto");
  const privKey = createPrivateKey({
    key: Buffer.from(identity.privateKeyDer, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(payload), privKey);
  return base64url(signature);
}

function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

interface DeviceConnection {
  ws: WebSocket;
  deviceId: string;
}

export interface PinclawWsServerOptions {
  port: number;
  authToken: string;
  gatewayUrl: string;
  gatewayToken: string;
  fallbackAiKey?: string;
  fallbackAiUrl?: string;
  abortSignal?: AbortSignal;
  log?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
}

export class PinclawWsServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private devices = new Map<string, DeviceConnection>();
  private pendingQueues = new Map<string, PendingMessage[]>();
  private deviceTools = new Map<string, DeviceToolDef[]>();
  private pendingToolCalls = new Map<string, {
    resolve: (result: { success: boolean; result?: string; error?: string }) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private port: number;
  private authToken: string;
  private gatewayUrl: string;
  private gatewayToken: string;
  private fallbackAiKey: string;
  private fallbackAiUrl: string;
  private log: NonNullable<PinclawWsServerOptions["log"]>;

  // Gateway RPC WebSocket connection (uses same protocol as Dashboard)
  private gatewayWs: WebSocket | null = null;
  private gatewayWsReady = false;
  private rpcCallbacks = new Map<string, {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    chunks: string[];
    timer: ReturnType<typeof setTimeout>;
    deviceId?: string;
    lastDeltaLen: number;
  }>();
  // Generic Gateway RPC callbacks (non-chat: sessions.list, chat.history, etc.)
  private gwRpcCallbacks = new Map<string, {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(opts: PinclawWsServerOptions) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.gatewayUrl = opts.gatewayUrl;
    this.gatewayToken = opts.gatewayToken;
    this.fallbackAiKey = opts.fallbackAiKey ?? "";
    this.fallbackAiUrl = opts.fallbackAiUrl ?? "https://yinli.one/v1/chat/completions";
    this.log = opts.log ?? {
      info: (...args: any[]) => console.log("[pinclaw]", ...args),
      warn: (...args: any[]) => console.warn("[pinclaw]", ...args),
      error: (...args: any[]) => console.error("[pinclaw]", ...args),
    };

    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => this.stop(), { once: true });
    }
  }

  // ── Lifecycle ──

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;

      // HTTP server handles both REST fallback and WebSocket upgrade
      this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.httpServer.on("listening", () => {
        started = true;
        this.log.info(`Server listening on port ${this.port} (WebSocket + HTTP fallback)`);
        resolve();
      });

      this.httpServer.on("error", (err) => {
        this.log.error("Server error:", err);
        if (!started) reject(err);
      });

      this.wss.on("connection", (ws) => this.handleWsConnection(ws));

      this.httpServer.listen(this.port);

      // Connect to Gateway via WebSocket RPC (same protocol as Dashboard)
      this.connectGatewayWs();
    });
  }

  stop(): void {
    if (!this.wss) return;
    this.gatewayWs?.close();
    this.gatewayWs = null;
    for (const conn of this.devices.values()) {
      conn.ws.close(1000, "Server shutting down");
    }
    this.devices.clear();
    this.wss.close();
    this.httpServer?.close();
    this.wss = null;
    this.httpServer = null;
    this.log.info("Server stopped");
  }

  // ── Public API (used by outbound.sendText) ──

  async sendToDevice(deviceId: string, text: string): Promise<{ ok: boolean; queued?: boolean }> {
    const conn = this.devices.get(deviceId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      const parsed = this.parseResponseMode(text);
      this.sendWs(conn.ws, { type: "agent_message", content: parsed.display, voice: parsed.voice, mode: parsed.mode, sound: parsed.sound, proactive: true });
      return { ok: true };
    }
    // Device offline — enqueue for later delivery
    this.enqueueMessage(deviceId, text);
    return { ok: true, queued: true };
  }

  // ── Pending message queue ──

  private enqueueMessage(deviceId: string, text: string): void {
    let queue = this.pendingQueues.get(deviceId);
    if (!queue) {
      queue = [];
      this.pendingQueues.set(deviceId, queue);
    }
    // Lazy purge expired
    const now = Date.now();
    const filtered = queue.filter(m => m.expiresAt > now);

    filtered.push({
      id: randomUUID(),
      text,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    });

    // FIFO overflow
    while (filtered.length > PENDING_MAX_PER_DEVICE) {
      filtered.shift();
    }

    this.pendingQueues.set(deviceId, filtered);
    this.log.info(`Enqueued message for offline device ${deviceId} (queue size: ${filtered.length})`);
  }

  /** Deliver all pending messages over an open WS connection and clear the queue. */
  private async deliverPending(deviceId: string, ws: WebSocket): Promise<void> {
    const queue = this.pendingQueues.get(deviceId);
    if (!queue || queue.length === 0) return;

    const now = Date.now();
    const valid = queue.filter(m => m.expiresAt > now);
    this.pendingQueues.delete(deviceId);

    if (valid.length === 0) return;

    this.log.info(`Delivering ${valid.length} pending message(s) to ${deviceId}`);
    for (const msg of valid) {
      const parsed = this.parseResponseMode(msg.text);
      this.sendWs(ws, { type: "agent_message", content: parsed.display, voice: parsed.voice, mode: parsed.mode, sound: parsed.sound, proactive: true });
    }
  }

  /** Take all pending messages for a device (used by GET /pending). */
  takePending(deviceId: string): { id: string; text: string }[] {
    const queue = this.pendingQueues.get(deviceId);
    if (!queue || queue.length === 0) return [];

    const now = Date.now();
    const valid = queue.filter(m => m.expiresAt > now);
    this.pendingQueues.delete(deviceId);

    return valid.map(m => ({ id: m.id, text: m.text }));
  }

  isDeviceConnected(deviceId: string): boolean {
    const conn = this.devices.get(deviceId);
    return Boolean(conn && conn.ws.readyState === WebSocket.OPEN);
  }

  listConnectedDevices(): string[] {
    return Array.from(this.devices.keys());
  }

  // ══════════════════════════════════════════════════
  // HTTP fallback — POST /message
  // Used by iPhone when WebSocket is disconnected
  // (e.g. app woken from background by BLE event)
  // ══════════════════════════════════════════════════

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        devices: this.listConnectedDevices().length,
      }));
      return;
    }

    // POST /message — HTTP fallback for inbound messages
    if (req.method === "POST" && req.url === "/message") {
      await this.handleHttpMessage(req, res);
      return;
    }

    // POST /push — Proactive push from Agent to device
    if (req.method === "POST" && req.url === "/push") {
      await this.handleHttpPush(req, res);
      return;
    }

    // POST /notify — Cross-session result relay to hardware
    // Other sessions (Main, Cron) call this to send results through Pinclaw session AI → hardware
    if (req.method === "POST" && req.url === "/notify") {
      await this.handleNotify(req, res);
      return;
    }

    // GET /pending?deviceId=xxx — Retrieve queued offline messages
    if (req.method === "GET" && req.url?.startsWith("/pending")) {
      this.handleHttpPending(req, res);
      return;
    }

    // GET /devices — List connected devices
    if (req.method === "GET" && req.url === "/devices") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        devices: this.listConnectedDevices(),
        count: this.listConnectedDevices().length,
      }));
      return;
    }

    // ── Cron job management endpoints ──

    const parsedUrl = new URL(req.url ?? "", `http://localhost:${this.port}`);
    const cronJobsMatch = parsedUrl.pathname.match(/^\/cron\/jobs(?:\/([^/]+))?(?:\/(.+))?$/);

    if (cronJobsMatch) {
      // Auth check — Bearer token
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (token !== this.authToken) {
        res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }

      const jobId = cronJobsMatch[1];
      const action = cronJobsMatch[2];

      // GET /cron/jobs — List all cron jobs
      if (req.method === "GET" && !jobId) {
        await this.handleCronList(res);
        return;
      }

      // POST /cron/jobs — Create a new cron job
      if (req.method === "POST" && !jobId) {
        await this.handleCronCreate(req, res);
        return;
      }

      // DELETE /cron/jobs/:id — Delete a cron job
      if (req.method === "DELETE" && jobId && !action) {
        await this.handleCronDelete(jobId, res);
        return;
      }

      // POST /cron/jobs/:id/toggle — Enable/disable a cron job
      if (req.method === "POST" && jobId && action === "toggle") {
        await this.handleCronToggle(jobId, req, res);
        return;
      }
    }

    // ── Skills management endpoints ──

    const skillsMatch = parsedUrl.pathname.match(/^\/skills(?:\/([^/]+))?$/);

    if (skillsMatch) {
      // Auth check — Bearer token
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (token !== this.authToken) {
        res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }

      const skillName = skillsMatch[1] ? decodeURIComponent(skillsMatch[1]) : undefined;

      // GET /skills — List all skills
      if (req.method === "GET" && !skillName) {
        this.handleSkillsList(res);
        return;
      }

      // GET /skills/:name — Get a single skill
      if (req.method === "GET" && skillName) {
        this.handleSkillGet(skillName, res);
        return;
      }

      // POST /skills — Create a new skill
      if (req.method === "POST" && !skillName) {
        await this.handleSkillCreate(req, res);
        return;
      }

      // PUT /skills/:name — Update a skill
      if (req.method === "PUT" && skillName) {
        await this.handleSkillUpdate(skillName, req, res);
        return;
      }

      // DELETE /skills/:name — Delete a skill
      if (req.method === "DELETE" && skillName) {
        this.handleSkillDelete(skillName, res);
        return;
      }
    }

    // ── Gateway proxy endpoints (for iPhone when GW WS is unreachable) ──

    const gwMatch = parsedUrl.pathname.match(/^\/gateway\/sessions(?:\/(.+?))?(?:\/(history))?$/);

    if (gwMatch && req.method === "GET") {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (token !== this.authToken) {
        res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }

      const sessionKey = gwMatch[1];
      const action = gwMatch[2]; // "history" or undefined

      if (!sessionKey) {
        // GET /gateway/sessions → list all sessions
        try {
          const result = await this.sendGatewayRPC("sessions.list", {});
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (sessionKey && action === "history") {
        // GET /gateway/sessions/:key/history → get chat history
        try {
          const result = await this.sendGatewayRPC("chat.history", { sessionKey: decodeURIComponent(sessionKey) });
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async handleHttpMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf-8");

    let body: any;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Auth check
    const token = body.token ?? req.headers.authorization?.replace("Bearer ", "");
    if (token !== this.authToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }

    const deviceId: string = body.deviceId;
    const content: string = body.content;
    if (!deviceId || !content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing deviceId or content" }));
      return;
    }

    this.log.info(`HTTP fallback message from ${deviceId}: ${content.slice(0, 60)}...`);

    // Route to agent (same logic as WebSocket path)
    try {
      const agentResponse = await this.callAgent(deviceId, content);
      const parsed = agentResponse.content
        ? this.parseResponseMode(agentResponse.content)
        : { mode: "voice", voice: "", display: "", sound: undefined };
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({
        content: parsed.display,
        voice: parsed.voice,
        mode: parsed.mode,
        sound: parsed.sound,
        error: agentResponse.error,
      }));
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message ?? String(err) }));
    }
  }

  // ══════════════════════════════════════════════════
  // Proactive push — POST /push
  // Used by external agents (OpenClaw, cron, scripts) to
  // push messages to connected devices without user request
  // ══════════════════════════════════════════════════

  private async handleHttpPush(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf-8");

    let body: any;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Auth check
    const token = body.token ?? req.headers.authorization?.replace("Bearer ", "");
    if (token !== this.authToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }

    const deviceId: string = body.deviceId;
    const text: string = body.text;
    if (!deviceId || !text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing deviceId or text" }));
      return;
    }

    this.log.info(`Proactive push to ${deviceId}: ${text.slice(0, 60)}...`);

    const result = await this.sendToDevice(deviceId, text);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ ok: true, deviceId, queued: result.queued ?? false }));
  }

  // ══════════════════════════════════════════════════
  // Relay to device — shared core for /notify and outbound
  // Routes text through Pinclaw session AI for compression,
  // then pushes the AI response to hardware.
  // ══════════════════════════════════════════════════

  async relayToDevice(
    deviceId: string,
    message: string,
    source: string = "system",
  ): Promise<{ ok: boolean; content?: string; voice?: string; mode?: string; sound?: string; queued?: boolean; error?: string }> {
    this.log.info(`relay from ${source} to ${deviceId}: ${message.slice(0, 80)}...`);

    const conn = this.devices.get(deviceId);

    // 1. Route to Pinclaw session AI with source prefix
    //    callAgent → callAgentViaRpc → streams deltas to device automatically
    //    No initial sound notification — sendToDevice sends proactive: true
    //    which triggers notifyArrive on the iOS side (BLEManager handles it)
    const prefixed = `[来自${source}的结果]\n${message}`;
    const agentResponse = await this.callAgent(deviceId, prefixed);

    // 2. Send final AI response to hardware (parsed into voice/display/sound)
    if (agentResponse.content) {
      await this.sendToDevice(deviceId, agentResponse.content);
    }

    const parsed = agentResponse.content
      ? this.parseResponseMode(agentResponse.content)
      : { mode: "voice", voice: "", display: "", sound: undefined };

    return {
      ok: true,
      content: parsed.display,
      voice: parsed.voice,
      mode: parsed.mode,
      sound: parsed.sound,
      queued: !conn || conn.ws.readyState !== WebSocket.OPEN,
      error: agentResponse.error,
    };
  }

  // ══════════════════════════════════════════════════
  // POST /notify — HTTP interface for relayToDevice
  // Other sessions (Main, Cron) exec curl to relay
  // results through Pinclaw session AI → hardware
  // ══════════════════════════════════════════════════

  private async handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf-8");

    let body: any;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Auth check
    const token = body.token ?? req.headers.authorization?.replace("Bearer ", "");
    if (token !== this.authToken) {
      res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }

    const message: string = body.message;
    const source: string = body.source ?? "system";
    const deviceId: string = body.deviceId ?? "pinclaw";

    if (!message) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Missing message" }));
      return;
    }

    try {
      const result = await this.relayToDevice(deviceId, message, source);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ...result, deviceId }));
    } catch (err: any) {
      this.log.error(`/notify failed: ${err.message}`);
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message ?? String(err) }));
    }
  }

  // ══════════════════════════════════════════════════
  // GET /pending — retrieve queued offline messages
  // Used by iPhone when woken by BLE heartbeat while WS is down
  // ══════════════════════════════════════════════════

  private handleHttpPending(req: IncomingMessage, res: ServerResponse): void {
    // Auth check — Bearer token
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== this.authToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }

    // Parse deviceId from query string
    const url = new URL(req.url ?? "", `http://localhost:${this.port}`);
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing deviceId query parameter" }));
      return;
    }

    const messages = this.takePending(deviceId);
    this.log.info(`GET /pending for ${deviceId}: returning ${messages.length} message(s)`);

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ messages }));
  }

  // ══════════════════════════════════════════════════
  // WebSocket connection handling
  // ══════════════════════════════════════════════════

  private handleWsConnection(ws: WebSocket): void {
    let deviceId: string | null = null;
    let authenticated = false;

    // Require auth within 10 seconds
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        this.sendWs(ws, { type: "error", message: "Auth timeout" });
        ws.close(4001, "Auth timeout");
      }
    }, 10_000);

    ws.on("message", async (raw) => {
      let msg: WsInboundMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.sendWs(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      if (msg.type === "auth") {
        if (msg.token !== this.authToken) {
          this.sendWs(ws, { type: "error", message: "Invalid token" });
          ws.close(4003, "Invalid token");
          return;
        }
        deviceId = msg.deviceId;
        authenticated = true;
        clearTimeout(authTimer);

        const old = this.devices.get(deviceId);
        if (old) old.ws.close(1000, "Replaced by new connection");

        this.devices.set(deviceId, { ws, deviceId });
        this.sendWs(ws, { type: "auth_ok", deviceId });
        this.log.info(`Device authenticated: ${deviceId}`);
        // Deliver any queued offline messages
        this.deliverPending(deviceId, ws);
        return;
      }

      if (msg.type === "ping") {
        this.sendWs(ws, { type: "pong" });
        return;
      }

      if (msg.type === "device_tools_register") {
        if (!authenticated || !deviceId) {
          this.sendWs(ws, { type: "error", message: "Not authenticated" });
          return;
        }
        this.deviceTools.set(deviceId, msg.tools);
        this.log.info(`Device ${deviceId} registered ${msg.tools.length} tool(s): ${msg.tools.map(t => t.name).join(", ")}`);
        return;
      }

      if (msg.type === "tool_result") {
        const pending = this.pendingToolCalls.get(msg.callId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingToolCalls.delete(msg.callId);
          pending.resolve({ success: msg.success, result: msg.result, error: msg.error });
        }
        return;
      }

      if (msg.type === "text") {
        if (!authenticated || !deviceId) {
          this.sendWs(ws, { type: "error", message: "Not authenticated" });
          return;
        }
        // Send immediate ack so user knows message was received (not an agent_message to avoid duplicate RECENT entries)
        this.sendWs(ws, { type: "ack", sound: "notifyArrive" });
        try {
          const result = await this.callAgent(deviceId, msg.content);
          if (result.content) {
            const parsed = this.parseResponseMode(result.content);
            this.sendWs(ws, { type: "agent_message", content: parsed.display, voice: parsed.voice, mode: parsed.mode, sound: parsed.sound, proactive: false });
          } else {
            this.sendWs(ws, { type: "error", message: result.error ?? "Empty response" });
          }
        } catch (err: any) {
          this.sendWs(ws, { type: "error", message: err.message ?? String(err) });
        }
        return;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (deviceId) {
        const conn = this.devices.get(deviceId);
        if (conn?.ws === ws) {
          this.devices.delete(deviceId);
          // Clean up device tools
          this.deviceTools.delete(deviceId);
          // Reject all pending tool calls for this device
          for (const [callId, pending] of this.pendingToolCalls) {
            pending.reject(new Error("Device disconnected"));
            clearTimeout(pending.timer);
            this.pendingToolCalls.delete(callId);
          }
          this.log.info(`Device disconnected: ${deviceId}`);
        }
      }
    });

    ws.on("error", (err) => {
      this.log.error(`WebSocket error (device=${deviceId}):`, err.message);
    });

    // Keepalive ping every 30s
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    ws.on("close", () => clearInterval(pingInterval));
  }

  // ══════════════════════════════════════════════════
  // Shared: call OpenClaw agent
  // Used by both WebSocket and HTTP paths
  // ══════════════════════════════════════════════════

  // ══════════════════════════════════════════════════
  // Gateway RPC WebSocket — same protocol as Dashboard
  // Bypasses the buggy /v1/chat/completions HTTP endpoint
  // ══════════════════════════════════════════════════

  private connectGatewayWs(): void {
    if (this.gatewayWs?.readyState === WebSocket.OPEN) return;

    const wsUrl = this.gatewayUrl.replace(/^http/, "ws");
    this.log.info(`Connecting to Gateway WebSocket: ${wsUrl}`);

    const identity = getOrCreateDeviceIdentity();
    this.log.info(`Device identity: ${identity.deviceId.slice(0, 12)}...`);

    const ws = new WebSocket(wsUrl);
    this.gatewayWs = ws;
    this.gatewayWsReady = false;
    let connectSent = false;

    const clientId = "gateway-client";
    const clientMode = "backend";
    const role = "operator";
    const scopes = ["operator.admin", "operator.write", "operator.read"];

    const sendConnect = (nonce?: string) => {
      if (connectSent) return;
      connectSent = true;

      const signedAt = Date.now();
      // Signing payload: v2|deviceId|clientId|clientMode|role|scopes_csv|signedAtMs|token|nonce
      const payloadStr = `v2|${identity.deviceId}|${clientId}|${clientMode}|${role}|${scopes.join(",")}|${signedAt}|${this.gatewayToken}|${nonce ?? ""}`;
      const signature = signDevicePayload(identity, payloadStr);

      ws.send(JSON.stringify({
        type: "req",
        id: randomUUID(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: clientId,
            version: "0.1.0",
            platform: "node",
            mode: clientMode,
            instanceId: randomUUID(),
          },
          role,
          scopes,
          caps: [],
          device: {
            id: identity.deviceId,
            publicKey: identity.publicKeyB64,
            signature,
            signedAt,
            nonce: nonce ?? undefined,
          },
          auth: { token: this.gatewayToken },
          userAgent: "pinclaw-channel/0.1.0",
          locale: "zh",
        },
      }));
    };

    ws.on("open", () => {
      this.log.info("Gateway WebSocket connected, waiting for challenge...");
      // Dashboard waits 750ms for challenge, then sends anyway
      setTimeout(() => sendConnect(), 800);
    });

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Handle connect.challenge event (sent before connect)
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const nonce = msg.payload?.nonce;
        this.log.info("Got connect challenge, sending auth...");
        sendConnect(nonce);
        return;
      }

      // Handle connect response
      if (msg.type === "res" && !this.gatewayWsReady) {
        if (msg.ok !== false) {
          this.gatewayWsReady = true;
          const authInfo = msg.payload?.auth;
          this.log.info("Gateway WebSocket authenticated — RPC ready");
          this.log.info(`Granted scopes: ${JSON.stringify(authInfo?.scopes ?? "none")}`);
          this.log.info(`Role: ${authInfo?.role ?? "none"}`);
          const methods = msg.payload?.features?.methods ?? [];
          this.log.info(`Available methods: ${methods.join(", ")}`);
          // Save device token for future use if provided
          if (authInfo?.deviceToken) {
            this.log.info("Received device token from Gateway (device paired)");
          }
          // Ensure the "pinclaw" hardware session exists — it's a core product session
          // that must always be present (like iMessage on an iPhone)
          this.ensurePinclawSession();
        } else {
          this.log.error("Gateway auth failed:", JSON.stringify(msg.error ?? msg).slice(0, 500));
        }
        return;
      }

      // Handle RPC responses (chat.send acknowledgement + generic gwRpc)
      if (msg.type === "res" && msg.id) {
        // Generic gateway RPC (sessions.list, chat.history, etc.)
        const gwCb = this.gwRpcCallbacks.get(msg.id);
        if (gwCb) {
          clearTimeout(gwCb.timer);
          this.gwRpcCallbacks.delete(msg.id);
          if (msg.ok === false) {
            gwCb.reject(new Error(msg.error?.message ?? "RPC error"));
          } else {
            gwCb.resolve(msg.payload ?? {});
          }
          return;
        }

        // Chat RPC callbacks
        const cb = this.rpcCallbacks.get(msg.id);
        if (cb && msg.ok === false) {
          cb.reject(new Error(msg.error?.message ?? "RPC error"));
          clearTimeout(cb.timer);
          this.rpcCallbacks.delete(msg.id);
        }
        return;
      }

      // Handle chat events (agent response chunks and final)
      if (msg.type === "event" && msg.event === "chat") {
        this.handleChatEvent(msg.payload);
        return;
      }
    });

    ws.on("close", () => {
      this.gatewayWsReady = false;
      this.gatewayWs = null;
      this.log.warn("Gateway WebSocket disconnected, reconnecting in 3s...");
      setTimeout(() => this.connectGatewayWs(), 3000);
    });

    ws.on("error", (err) => {
      this.log.error("Gateway WebSocket error:", err.message);
    });
  }

  private handleChatEvent(payload: any): void {
    if (!payload) return;

    // Find the matching RPC callback (we only have one at a time typically)
    for (const [reqId, cb] of this.rpcCallbacks) {
      if (payload.state === "delta") {
        // Extract text from delta — Dashboard uses a helper that reads message.content
        const text = this.extractTextFromMessage(payload.message);
        if (text) {
          // Delta sends the FULL accumulated text so far, not just the new part
          cb.chunks = [text];
          // Push incremental delta to device for real-time feedback
          if (cb.deviceId && text.length > cb.lastDeltaLen) {
            const newText = text.slice(cb.lastDeltaLen);
            cb.lastDeltaLen = text.length;
            const conn = this.devices.get(cb.deviceId);
            if (conn?.ws.readyState === WebSocket.OPEN) {
              this.sendWs(conn.ws, { type: "agent_delta", content: newText });
            }
          }
        }
      } else if (payload.state === "final") {
        const finalText = this.extractTextFromMessage(payload.message)
          ?? cb.chunks.join("");
        clearTimeout(cb.timer);
        this.rpcCallbacks.delete(reqId);
        if (finalText) {
          cb.resolve(finalText);
        } else {
          cb.reject(new Error("Empty agent response"));
        }
        return;
      } else if (payload.state === "error" || payload.state === "aborted") {
        const partialText = cb.chunks.join("");
        clearTimeout(cb.timer);
        this.rpcCallbacks.delete(reqId);
        if (partialText) {
          cb.resolve(partialText);
        } else {
          cb.reject(new Error(payload.errorMessage ?? "Agent error/aborted"));
        }
        return;
      }
    }
  }

  private extractTextFromMessage(message: any): string | null {
    if (!message) return null;
    // message.content can be a string or an array of content blocks
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((b: any) => b.type === "text" && b.text)
        .map((b: any) => b.text)
        .join("") || null;
    }
    return null;
  }

  // ── Device tool call parsing ──

  private parseDeviceToolCall(text: string): { toolName: string; params: Record<string, any> } | null {
    const match = text.match(/<device_tool\s+name="([^"]+)"\s+params='([^']*)'\s*\/>/);
    if (!match) return null;
    try {
      return { toolName: match[1], params: JSON.parse(match[2] || "{}") };
    } catch {
      return { toolName: match[1], params: {} };
    }
  }

  private async callAgent(deviceId: string, text: string): Promise<{ content?: string; error?: string }> {
    // Get initial AI response
    let aiContent: string | undefined;

    // Primary: Gateway WebSocket RPC (same as Dashboard — no [object Object] bug)
    if (this.gatewayWsReady && this.gatewayWs?.readyState === WebSocket.OPEN) {
      try {
        aiContent = await this.callAgentViaRpc(deviceId, text);
      } catch (err: any) {
        this.log.warn(`Gateway RPC failed: ${err.message}, falling back to direct AI`);
      }
    }

    // Fallback: direct AI API
    if (!aiContent) {
      try {
        aiContent = await this.callDirectAi(deviceId, text);
      } catch (err: any) {
        this.log.error(`Direct AI fallback failed: ${err.message}`);
        return { error: "All AI endpoints failed" };
      }
    }

    if (!aiContent) return { error: "Empty AI response" };

    // Tool call loop (max 3 rounds)
    const deviceToolsList = this.deviceTools.get(deviceId);
    if (deviceToolsList && deviceToolsList.length > 0) {
      let currentContent = aiContent;
      for (let round = 0; round < 3; round++) {
        const toolCall = this.parseDeviceToolCall(currentContent);
        if (!toolCall) break;

        this.log.info(`AI requested device tool: ${toolCall.toolName} (round ${round + 1})`);

        let toolResultText: string;
        try {
          const result = await this.callDeviceTool(deviceId, toolCall.toolName, toolCall.params);
          toolResultText = result.success
            ? (result.result ?? "Success")
            : `Error: ${result.error ?? "Unknown error"}`;
        } catch (err: any) {
          toolResultText = `Error: ${err.message}`;
        }

        // Re-call AI with tool result context
        const followUp = `[Tool result for ${toolCall.toolName}]: ${toolResultText}\n\nBased on this result, respond to the user.`;
        try {
          currentContent = await this.callDirectAiWithContext(deviceId, text, currentContent, followUp);
        } catch {
          // If follow-up fails, return raw tool result in display mode
          currentContent = `<mode>display</mode><voice>查到了</voice><display>${toolResultText}</display>`;
          break;
        }
      }
      return { content: currentContent };
    }

    return { content: aiContent };
  }

  private async callDirectAi(deviceId: string, text: string): Promise<string> {
    const deviceToolsList = this.deviceTools.get(deviceId) ?? [];
    let systemPrompt = [
      "You are a voice AI on a wearable device. Wrap EVERY reply in one XML mode:",
      "1. sound: <mode>sound</mode><sound>taskSuccess</sound><display>短文字</display>",
      "2. voice: <mode>voice</mode><voice>≤15中文字的回复</voice>",
      "3. display: <mode>display</mode><voice>看手机</voice><display>完整内容</display>",
      "Confirmations→sound. Short Q&A→voice(≤15字). Long info→display.",
      "Match user's language. No emoji/symbols/markdown. Never repeat user's words.",
    ].join("\n");

    if (deviceToolsList.length > 0) {
      const toolLines = deviceToolsList.map(t => {
        const paramDesc = t.parameters.length > 0
          ? ` (params: ${t.parameters.map(p => `${p.name}: ${p.type}`).join(", ")})`
          : "";
        return `- ${t.name}: ${t.description}${paramDesc}`;
      }).join("\n");
      systemPrompt += `\n\nDevice tools available on the user's iPhone:\n${toolLines}\nTo call a tool: <device_tool name="tool_name" params='{"key":"value"}'/>\nOnly call a tool when the user's request clearly needs it.`;
    }

    const response = await fetch(this.fallbackAiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.fallbackAiKey}`,
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        max_tokens: 200,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.length > 0) return content;
    throw new Error("Empty response");
  }

  private async callDirectAiWithContext(
    deviceId: string, userText: string, aiResponse: string, toolResult: string,
  ): Promise<string> {
    const response = await fetch(this.fallbackAiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.fallbackAiKey}`,
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [
          {
            role: "system",
            content: [
              "You are a voice AI on a wearable device. Wrap EVERY reply in one XML mode:",
              "1. sound: <mode>sound</mode><sound>taskSuccess</sound><display>短文字</display>",
              "2. voice: <mode>voice</mode><voice>≤15中文字的回复</voice>",
              "3. display: <mode>display</mode><voice>看手机</voice><display>完整内容</display>",
              "Match user's language. No emoji/symbols/markdown.",
            ].join("\n"),
          },
          { role: "user", content: userText },
          { role: "assistant", content: aiResponse },
          { role: "user", content: toolResult },
        ],
        max_tokens: 200,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.length > 0) return content;
    throw new Error("Empty response");
  }

  /** Ensure the "pinclaw" hardware session exists in the Gateway.
   *  This is a core product session — it must always be present.
   *  Checks via sessions.list; if missing, sends a silent init message to create it. */
  private async ensurePinclawSession(): Promise<void> {
    try {
      const result = await this.sendGatewayRPC("sessions.list", {});
      const sessions: any[] = result?.sessions ?? [];
      const exists = sessions.some((s: any) => s.key === "pinclaw" || s.key?.endsWith(":pinclaw"));
      if (exists) {
        this.log.info("Pinclaw session exists — ready");
        return;
      }
      this.log.info("Pinclaw session not found — creating...");
      // Send a minimal message to create the session. The AI will respond,
      // which also warms up the session with voice XML rules via the hook.
      this.callAgentViaRpc("pinclaw", "系统初始化：硬件 session 已就绪。回复：<mode>sound</mode><sound>taskSuccess</sound><display>Pinclaw ready</display>")
        .then(() => this.log.info("Pinclaw session created successfully"))
        .catch((err) => this.log.error("Failed to create pinclaw session:", err.message));
    } catch (err: any) {
      this.log.warn("Could not check pinclaw session:", err.message);
    }
  }

  /** Generic Gateway RPC — sends a request and waits for a non-chat response */
  private sendGatewayRPC(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.gatewayWsReady || this.gatewayWs?.readyState !== WebSocket.OPEN) {
        return reject(new Error("Gateway not connected"));
      }
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        this.gwRpcCallbacks.delete(reqId);
        reject(new Error("Gateway RPC timeout (15s)"));
      }, 15_000);

      this.gwRpcCallbacks.set(reqId, { resolve, reject, timer });

      this.gatewayWs!.send(JSON.stringify({ type: "req", id: reqId, method, params }));
    });
  }

  private callAgentViaRpc(deviceId: string, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        this.rpcCallbacks.delete(reqId);
        reject(new Error("RPC timeout (120s)"));
      }, 120_000);

      this.rpcCallbacks.set(reqId, { resolve, reject, chunks: [], timer, deviceId, lastDeltaLen: 0 });

      this.gatewayWs!.send(JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "pinclaw",
          message: text,
          idempotencyKey: randomUUID(),
        },
      }));

      this.log.info(`RPC chat.send → session pinclaw: ${text.slice(0, 60)}...`);
    });
  }

  // ── Three-mode response parsing ──

  private parseResponseMode(text: string): { mode: string; voice: string; display: string; sound?: string } {
    // Try to parse XML tags from AI response
    const modeMatch = text.match(/<mode>(sound|voice|display)<\/mode>/);
    if (!modeMatch) {
      // Fallback: AI didn't use XML — use display mode to preserve full text
      // Generate a meaningful voice summary instead of generic "有新消息"
      const voiceSummary = this.generateVoiceSummary(text, "broadcast");
      return { mode: "display", voice: voiceSummary || "看一下", display: text };
    }

    const mode = modeMatch[1];
    const voiceMatch = text.match(/<voice>([\s\S]*?)<\/voice>/);
    const displayMatch = text.match(/<display>([\s\S]*?)<\/display>/);
    const soundMatch = text.match(/<sound>([\s\S]*?)<\/sound>/);

    switch (mode) {
      case "sound":
        return {
          mode: "sound",
          voice: "",
          display: displayMatch?.[1]?.trim() ?? "",
          sound: soundMatch?.[1]?.trim() ?? "taskSuccess",
        };
      case "display":
        return {
          mode: "display",
          voice: voiceMatch?.[1]?.trim() ?? "看一下手机",
          display: displayMatch?.[1]?.trim() ?? text.replace(/<[^>]+>/g, "").trim(),
        };
      case "voice":
      default:
        return {
          mode: "voice",
          voice: voiceMatch?.[1]?.trim() ?? text.replace(/<[^>]+>/g, "").trim(),
          display: voiceMatch?.[1]?.trim() ?? text.replace(/<[^>]+>/g, "").trim(),
        };
    }
  }

  // ── Voice summary generation (fallback) ──

  private generateVoiceSummary(text: string, mode: "response" | "broadcast" = "response"): string {
    // Fallback truncation when AI doesn't use XML mode tags.
    // Used by parseResponseMode when no <mode> tag is detected.
    const cleaned = text.replace(/[#*`>•\-—–]/g, "").replace(/\n{2,}/g, " ").trim();

    const threshold = mode === "broadcast" ? 30 : 50;
    if (cleaned.length <= threshold) return cleaned;

    // Try sentence-based truncation first
    const sentences = cleaned.match(/[^。！？.!?\n]+[。！？.!?]?/g);
    if (sentences && sentences.length > 0) {
      const count = mode === "broadcast" ? 1 : 2;
      const result = sentences.slice(0, count).join("").trim();
      if (result.length <= threshold * 2) return result;
    }
    return cleaned.slice(0, threshold);
  }

  // ══════════════════════════════════════════════════
  // Cron job management — proxies to `openclaw cron` CLI
  // ══════════════════════════════════════════════════

  private execCron(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("openclaw", ["cron", ...args], { timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      });
    });
  }

  private async handleCronList(res: ServerResponse): Promise<void> {
    try {
      const output = await this.execCron(["list", "--json"]);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      // output is already JSON from --json flag
      res.end(output || "[]");
    } catch (err: any) {
      this.log.error("cron list failed:", err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleCronCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { name, message, at, every, cron, announce, deleteAfterRun, channel, to, session, bestEffortDeliver } = body;
    if (!message) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Missing 'message' field" }));
      return;
    }

    const jobName = name || `pinclaw-${Date.now()}`;
    const args: string[] = ["add", "--json", "--name", jobName, "--message", message];
    if (at) args.push("--at", at);
    if (every) args.push("--every", every);
    if (cron) args.push("--cron", cron);
    if (announce !== false) args.push("--announce");
    if (deleteAfterRun) args.push("--delete-after-run");
    if (channel) args.push("--channel", channel);
    if (to) args.push("--to", to);
    if (session) args.push("--session", session);
    if (bestEffortDeliver) args.push("--best-effort-deliver");

    try {
      const output = await this.execCron(args);
      this.log.info(`Cron job created: ${output.slice(0, 100)}`);
      res.writeHead(201, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(output || JSON.stringify({ ok: true }));
    } catch (err: any) {
      this.log.error("cron add failed:", err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleCronDelete(jobId: string, res: ServerResponse): Promise<void> {
    try {
      await this.execCron(["rm", jobId]);
      this.log.info(`Cron job deleted: ${jobId}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, id: jobId }));
    } catch (err: any) {
      this.log.error(`cron rm ${jobId} failed:`, err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleCronToggle(jobId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    let body: any = {};
    try {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {}

    const enabled = body.enabled ?? true;
    const action = enabled ? "enable" : "disable";

    try {
      await this.execCron([action, jobId]);
      this.log.info(`Cron job ${action}d: ${jobId}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, id: jobId, enabled }));
    } catch (err: any) {
      this.log.error(`cron ${action} ${jobId} failed:`, err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ══════════════════════════════════════════════════
  // Skills management — CRUD for ~/.openclaw/workspace/skills/
  // ══════════════════════════════════════════════════

  private handleSkillsList(res: ServerResponse): void {
    try {
      if (!existsSync(SKILLS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end("[]");
        return;
      }

      const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
      const skills: any[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const mdPath = join(SKILLS_DIR, entry.name, "SKILL.md");
        if (!existsSync(mdPath)) continue;

        try {
          const raw = readFileSync(mdPath, "utf-8");
          const { meta, body } = parseFrontmatter(raw);
          skills.push({
            name: entry.name,
            description: meta.description ?? "",
            userInvocable: meta.userInvocable === "true",
            bodyPreview: body.slice(0, 200),
            bodyLength: body.length,
          });
        } catch {
          // Skip unreadable skills
        }
      }

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(skills));
    } catch (err: any) {
      this.log.error("skills list failed:", err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private handleSkillGet(name: string, res: ServerResponse): void {
    if (!/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid skill name" }));
      return;
    }

    const mdPath = join(SKILLS_DIR, name, "SKILL.md");
    if (!existsSync(mdPath)) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Skill not found" }));
      return;
    }

    try {
      const raw = readFileSync(mdPath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        name,
        description: meta.description ?? "",
        userInvocable: meta.userInvocable === "true",
        body,
      }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleSkillCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { name, description, userInvocable, body: skillBody } = body;
    if (!name || typeof name !== "string") {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Missing 'name' field" }));
      return;
    }

    if (!/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid name: only a-z, 0-9, and - allowed" }));
      return;
    }

    const skillDir = join(SKILLS_DIR, name);
    if (existsSync(skillDir)) {
      res.writeHead(409, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Skill already exists" }));
      return;
    }

    try {
      mkdirSync(skillDir, { recursive: true });
      const md = buildSkillMd(name, description ?? "", userInvocable ?? false, skillBody ?? "");
      writeFileSync(join(skillDir, "SKILL.md"), md, "utf-8");

      this.log.info(`Skill created: ${name}`);
      res.writeHead(201, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, name }));
    } catch (err: any) {
      this.log.error("skill create failed:", err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleSkillUpdate(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid skill name" }));
      return;
    }

    const mdPath = join(SKILLS_DIR, name, "SKILL.md");
    if (!existsSync(mdPath)) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Skill not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    try {
      const raw = readFileSync(mdPath, "utf-8");
      const existing = parseFrontmatter(raw);

      const newDescription = body.description ?? existing.meta.description ?? "";
      const newUserInvocable = body.userInvocable ?? (existing.meta.userInvocable === "true");
      const newBody = body.body ?? existing.body;

      const md = buildSkillMd(name, newDescription, newUserInvocable, newBody);
      writeFileSync(mdPath, md, "utf-8");

      this.log.info(`Skill updated: ${name}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, name }));
    } catch (err: any) {
      this.log.error("skill update failed:", err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private handleSkillDelete(name: string, res: ServerResponse): void {
    if (!/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid skill name" }));
      return;
    }

    const skillDir = join(SKILLS_DIR, name);
    if (!existsSync(skillDir)) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Skill not found" }));
      return;
    }

    try {
      rmSync(skillDir, { recursive: true, force: true });
      this.log.info(`Skill deleted: ${name}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, name }));
    } catch (err: any) {
      this.log.error("skill delete failed:", err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Device Tool Call Bridge ──

  getDeviceTools(deviceId: string): DeviceToolDef[] {
    return this.deviceTools.get(deviceId) ?? [];
  }

  callDeviceTool(deviceId: string, toolName: string, params: Record<string, any>): Promise<{ success: boolean; result?: string; error?: string }> {
    const conn = this.devices.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Device not connected"));
    }

    const tools = this.deviceTools.get(deviceId);
    if (!tools || !tools.some(t => t.name === toolName)) {
      return Promise.reject(new Error(`Tool not registered: ${toolName}`));
    }

    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        reject(new Error("Tool call timeout (10s)"));
      }, 10_000);

      this.pendingToolCalls.set(callId, { resolve, reject, timer });
      this.sendWs(conn.ws, { type: "tool_call", callId, tool: toolName, params });
      this.log.info(`Tool call → ${deviceId}: ${toolName}(${JSON.stringify(params).slice(0, 100)})`);
    });
  }

  // ── Helpers ──

  private sendWs(ws: WebSocket, msg: WsOutboundMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
