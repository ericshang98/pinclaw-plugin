// ── WebSocket protocol messages (companion app ↔ plugin) ──

export interface WsAuthMessage {
  type: "auth";
  deviceId: string;
  token: string;
}

export interface WsTextMessage {
  type: "text";
  content: string;
}

export interface WsPingMessage {
  type: "ping";
}

// ── Device Skills protocol ──

export interface DeviceToolDef {
  name: string;
  description: string;
  parameters: { name: string; type: string; required?: boolean; description?: string }[];
}

export interface WsDeviceToolsRegisterMessage {
  type: "device_tools_register";
  tools: DeviceToolDef[];
}

export interface WsToolResultMessage {
  type: "tool_result";
  callId: string;
  success: boolean;
  result?: string;
  error?: string;
}

export type WsInboundMessage =
  | WsAuthMessage
  | WsTextMessage
  | WsPingMessage
  | WsDeviceToolsRegisterMessage
  | WsToolResultMessage;

export interface WsAuthOkMessage {
  type: "auth_ok";
  deviceId: string;
}

export interface WsAgentMessage {
  type: "agent_message";
  content: string;
  voice?: string;
  mode?: string;     // "voice" | "sound" | "display"
  sound?: string;    // e.g. "taskSuccess", "taskFailure"
  proactive: boolean;
}

export interface WsAgentDeltaMessage {
  type: "agent_delta";
  content: string;
}

export interface WsAckMessage {
  type: "ack";
  sound?: string;
}

export interface WsErrorMessage {
  type: "error";
  message: string;
}

export interface WsPongMessage {
  type: "pong";
}

export interface WsToolCallMessage {
  type: "tool_call";
  callId: string;
  tool: string;
  params: Record<string, any>;
}

export type WsOutboundMessage =
  | WsAuthOkMessage
  | WsAgentMessage
  | WsAgentDeltaMessage
  | WsAckMessage
  | WsErrorMessage
  | WsPongMessage
  | WsToolCallMessage;

// ── Pending message queue (offline delivery) ──

export interface PendingMessage {
  id: string;        // crypto.randomUUID()
  text: string;
  createdAt: number;
  expiresAt: number;
}

// ── Pinclaw account config (from openclaw.json channels.pinclaw) ──

export interface PinclawAccountConfig {
  enabled?: boolean;
  wsPort?: number;
  authToken?: string;
}

export interface ResolvedPinclawAccount {
  accountId: string;
  enabled: boolean;
  wsPort: number;
  authToken: string;
  config: PinclawAccountConfig;
}
