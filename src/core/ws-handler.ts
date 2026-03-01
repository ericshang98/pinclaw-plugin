import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type {
  WsInboundMessage,
  DeviceSkillManifest,
  WsAudioStartMessage,
  WsPlayRequestMessage,
} from "../types.js";
import type { Logger } from "./utils.js";
import { sendWs } from "./utils.js";
import type { DeviceManager } from "./device-manager.js";
import type { VersionChecker } from "./version-check.js";
import type { DeepgramSTT } from "../deepgram-stt.js";
import type { InteractiveAI } from "../interactive-ai.js";

export interface WsHandlerDeps {
  authToken: string;
  deviceManager: DeviceManager;
  versionChecker: VersionChecker;
  deepgramStt: DeepgramSTT | null;
  interactiveAI: InteractiveAI | null;
  processMessage: (text: string, opts: { deviceId?: string }) => Promise<void>;
  log: Logger;
}

export function handleWsConnection(ws: WebSocket, deps: WsHandlerDeps): void {
  const { authToken, deviceManager, versionChecker, deepgramStt, interactiveAI, processMessage, log } = deps;

  let deviceId: string | null = null;
  let authenticated = false;

  const authTimer = setTimeout(() => {
    if (!authenticated) {
      sendWs(ws, { type: "error", message: "Auth timeout" });
      ws.close(4001, "Auth timeout");
    }
  }, 10_000);

  ws.on("message", async (raw, isBinary) => {
    // Binary frames are audio chunks for Deepgram STT
    if (isBinary) {
      if (!authenticated || !deviceId) return;
      const session = deviceManager.getDeepgramSession(deviceId);
      if (session) {
        session.sendAudio(Buffer.from(raw as ArrayBuffer));
      }
      return;
    }

    let msg: WsInboundMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendWs(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (msg.type === "auth") {
      if (msg.token !== authToken) {
        sendWs(ws, { type: "error", message: "Invalid token" });
        ws.close(4003, "Invalid token");
        return;
      }
      deviceId = msg.deviceId;
      authenticated = true;
      clearTimeout(authTimer);

      deviceManager.addDevice(deviceId, ws);

      // Build services config for direct iPhone API calls
      const services: Record<string, any> = {};
      const aiKey = process.env.AI_API_KEY || process.env.CLAUDE_PROXY_API_KEY || "";
      const aiBase = process.env.AI_BASE_URL || process.env.CLAUDE_PROXY_BASE_URL || "";
      const lightModel = process.env.AI_LIGHT_MODEL || "kimi-k2";
      if (aiKey && aiBase) {
        services.interactiveAI = { apiKey: aiKey, baseUrl: aiBase, model: lightModel };
      }
      const dgKey = process.env.DEEPGRAM_API_KEY ?? "";
      if (dgKey) {
        services.deepgram = { apiKey: dgKey };
      }

      sendWs(ws, {
        type: "auth_ok",
        deviceId,
        ...(Object.keys(services).length > 0 ? { services } : {}),
      });
      log.info(`Device authenticated: ${deviceId} (services: ${Object.keys(services).join(", ") || "none"})`);

      // Notify device of available updates
      versionChecker.notifyDevice(ws);
      return;
    }

    if (msg.type === "ping") {
      sendWs(ws, { type: "pong" });
      return;
    }

    if (msg.type === "device_tools_register") {
      if (!authenticated || !deviceId) {
        sendWs(ws, { type: "error", message: "Not authenticated" });
        return;
      }

      let skills: DeviceSkillManifest[];
      if (msg.skills && msg.skills.length > 0) {
        skills = msg.skills;
      } else if (msg.tools && msg.tools.length > 0) {
        skills = [{
          id: "device.legacy",
          name: "Legacy Tools",
          enabled: true,
          permission: "authorized",
          tools: msg.tools,
        }];
      } else {
        skills = [];
      }

      deviceManager.registerSkills(deviceId, skills);
      return;
    }

    if (msg.type === "context_update") {
      if (!authenticated || !deviceId) {
        sendWs(ws, { type: "error", message: "Not authenticated" });
        return;
      }
      deviceManager.updateContextHints(deviceId, msg.hints);
      return;
    }

    if (msg.type === "tool_result") {
      deviceManager.resolvePendingToolCall(msg.callId, {
        success: msg.success,
        result: msg.result,
        error: msg.error,
      });
      return;
    }

    // ── Cloud STT: audio_start / audio_end ──

    if (msg.type === "audio_start") {
      if (!authenticated || !deviceId) {
        sendWs(ws, { type: "error", message: "Not authenticated" });
        return;
      }
      if (!deepgramStt?.enabled) {
        sendWs(ws, { type: "error", message: "Cloud STT not configured" });
        return;
      }

      const audioMsg = msg as WsAudioStartMessage;
      const dId = deviceId;
      const autoProcess = audioMsg.autoProcess !== false;
      const session = deepgramStt.createSession({
        language: audioMsg.language ?? "zh",
        keywords: ["Pinclaw:2", "OpenClaw:2"],
        onPartial: (text, confidence) => {
          sendWs(ws, { type: "stt_partial", text, confidence });
        },
        onFinal: (text, confidence) => {
          sendWs(ws, { type: "stt_final", text, confidence });
          deviceManager.removeDeepgramSession(dId);
          if (autoProcess && text.trim()) {
            sendWs(ws, { type: "ack", sound: "notifyArrive" });
            processMessage(text.trim(), { deviceId: dId });
          }
        },
        onError: (err) => {
          log.error(`[deepgram] Error for ${dId}:`, err.message);
          sendWs(ws, { type: "error", message: `STT error: ${err.message}` });
          deviceManager.removeDeepgramSession(dId);
        },
      }, audioMsg.sampleRate ?? 16000);

      deviceManager.setDeepgramSession(deviceId, session, autoProcess);
      log.info(`[deepgram] Started session for ${deviceId} (lang=${audioMsg.language ?? "zh"}, rate=${audioMsg.sampleRate ?? 16000}, autoProcess=${autoProcess})`);
      return;
    }

    if (msg.type === "audio_end") {
      if (!authenticated || !deviceId) return;
      const session = deviceManager.getDeepgramSession(deviceId);
      if (session) {
        session.finalize();
        log.info(`[deepgram] Finalized audio for ${deviceId}`);
      }
      return;
    }

    if (msg.type === "play_request") {
      if (!authenticated || !deviceId) {
        sendWs(ws, { type: "error", message: "Not authenticated" });
        return;
      }
      if (!interactiveAI) {
        sendWs(ws, { type: "interactive_error", message: "Interactive AI not configured", requestId: randomUUID() });
        return;
      }
      const requestId = randomUUID();
      try {
        const playMsg = msg as WsPlayRequestMessage;
        const content = await interactiveAI.generate(playMsg.recentEntries, playMsg.currentTime);
        sendWs(ws, { type: "interactive_response", content, requestId });
      } catch (err: any) {
        log.error("[interactive] Error:", err.message);
        sendWs(ws, { type: "interactive_error", message: err.message ?? "Unknown error", requestId: randomUUID() });
      }
      return;
    }

    if (msg.type === "text") {
      if (!authenticated || !deviceId) {
        sendWs(ws, { type: "error", message: "Not authenticated" });
        return;
      }
      sendWs(ws, { type: "ack", sound: "notifyArrive" });
      processMessage(msg.content, { deviceId });
      return;
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (deviceId) {
      deviceManager.removeDevice(deviceId, ws);
    }
  });

  ws.on("error", (err) => {
    log.error(`WebSocket error (device=${deviceId}):`, err.message);
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);
  ws.on("close", () => clearInterval(pingInterval));
}
