import { getPinclawWsServer, setPinclawWsServer } from "./runtime.js";
import { PinclawWsServer } from "./ws-server.js";
import type { ResolvedPinclawAccount, PinclawAccountConfig } from "./types.js";

const DEFAULT_WS_PORT = 18790;
const DEFAULT_ACCOUNT_ID = "default";

export const pinclawPlugin = {
  id: "pinclaw" as const,

  meta: {
    id: "pinclaw" as const,
    label: "Pinclaw",
    selectionLabel: "Pinclaw Hardware Clip",
    docsPath: "channels/pinclaw",
    blurb: "Hardware voice interface for OpenClaw — wearable clip with mic, speaker, and button",
    aliases: ["hardware", "clip"],
  },

  capabilities: {
    chatTypes: ["direct" as const],
  },

  reload: { configPrefixes: ["channels.pinclaw"] },

  // ── Config adapter ──

  config: {
    listAccountIds: (cfg: any): string[] => {
      const section = cfg.channels?.pinclaw;
      if (!section) return [];
      if (section.accounts) return Object.keys(section.accounts);
      // Top-level config counts as default account
      if (section.enabled !== false) return [DEFAULT_ACCOUNT_ID];
      return [];
    },

    resolveAccount: (cfg: any, accountId?: string | null): ResolvedPinclawAccount => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      const section = cfg.channels?.pinclaw;
      const acct: PinclawAccountConfig =
        id !== DEFAULT_ACCOUNT_ID
          ? section?.accounts?.[id] ?? {}
          : section ?? {};

      return {
        accountId: id,
        enabled: acct.enabled !== false,
        wsPort: acct.wsPort ?? DEFAULT_WS_PORT,
        authToken: acct.authToken ?? "",
        config: acct,
      };
    },

    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,

    isConfigured: (account: ResolvedPinclawAccount): boolean =>
      Boolean(account.authToken?.trim()),

    isEnabled: (account: ResolvedPinclawAccount): boolean =>
      account.enabled,

    describeAccount: (account: ResolvedPinclawAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.authToken?.trim()),
    }),
  },

  // ── Outbound adapter (agent → hardware device) ──
  // OpenClaw's announce/cron pipeline calls sendText/sendMedia to deliver messages.
  // Returns OutboundDeliveryResult { channel, messageId } as required by createPluginHandler().

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4096,

    sendText: async (ctx: { to: string; text: string; [k: string]: any }) => {
      const server = getPinclawWsServer();
      const msgId = `pinclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const deviceId = ctx.to || "pinclaw";
      console.log(`[pinclaw outbound] sendText to=${deviceId} text=${(ctx.text ?? "").slice(0, 80)}...`);
      if (server) {
        // Route through Pinclaw session AI for voice compression,
        // then push to hardware. This handles cron announce results —
        // the AI applies SOUL + voice rules before speaking to the user.
        try {
          const result = await server.relayToDevice(deviceId, ctx.text, "announce");
          console.log(`[pinclaw outbound] relayToDevice result: ok=${result.ok} queued=${result.queued}`);
        } catch (err: any) {
          // Fallback: if relay fails (e.g. Gateway down), push raw text directly
          console.log(`[pinclaw outbound] relay failed (${err.message}), falling back to direct push`);
          await server.sendToDevice(deviceId, ctx.text);
        }
      } else {
        console.log(`[pinclaw outbound] NO server instance — message lost!`);
      }
      return { channel: "pinclaw" as const, messageId: msgId };
    },

    sendMedia: async (ctx: { to: string; text: string; mediaUrl?: string; [k: string]: any }) => {
      const server = getPinclawWsServer();
      const msgId = `pinclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const deviceId = ctx.to || "pinclaw";
      const text = ctx.mediaUrl ? `${ctx.text}\n[media: ${ctx.mediaUrl}]` : ctx.text;
      if (server) {
        try {
          await server.relayToDevice(deviceId, text, "announce");
        } catch {
          await server.sendToDevice(deviceId, text);
        }
      }
      return { channel: "pinclaw" as const, messageId: msgId };
    },
  },

  // ── Status adapter ──

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastError: null,
    },

    buildAccountSnapshot: ({ account, runtime }: any) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.authToken?.trim()),
      running: runtime?.running ?? false,
      lastError: runtime?.lastError ?? null,
    }),
  },

  // ── Security adapter ──

  security: {
    resolveDmPolicy: ({ account }: { account: ResolvedPinclawAccount }) => ({
      policy: "open" as const,
      allowFrom: ["*"],
      allowFromPath: "channels.pinclaw.dm.",
      approveHint: "Pinclaw hardware device",
    }),
  },

  // ── Gateway adapter (lifecycle) ──

  gateway: {
    startAccount: async (ctx: any): Promise<void> => {
      const account: ResolvedPinclawAccount = ctx.account;
      const gatewayPort = ctx.cfg.gateway?.port ?? 18789;
      const gatewayToken =
        ctx.cfg.gateway?.auth?.token ?? "";

      const server = new PinclawWsServer({
        port: account.wsPort,
        authToken: account.authToken,
        gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
        gatewayToken,
        abortSignal: ctx.abortSignal,
        log: ctx.log
          ? {
              info: (...args: any[]) => ctx.log.info("[pinclaw]", ...args),
              warn: (...args: any[]) => ctx.log.warn("[pinclaw]", ...args),
              error: (...args: any[]) => ctx.log.error("[pinclaw]", ...args),
            }
          : undefined,
      });

      await server.start();
      setPinclawWsServer(server);

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
      });

      ctx.log?.info(
        `Pinclaw WebSocket server started on port ${account.wsPort}`,
      );

      // Block until abort signal fires (keeps gateway alive)
      return new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            server.stop();
            setPinclawWsServer(null);
            ctx.setStatus({
              accountId: account.accountId,
              running: false,
            });
            resolve();
          },
          { once: true },
        );
      });
    },
  },
};
