import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const API_URL = process.env.PINCLAW_RELAY_URL || "https://api.pinclaw.ai";
const SUPABASE_URL = "https://avnpyblaihqkzpwxotfp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2bnB5YmxhaWhxa3pwd3hvdGZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwMzc4NTksImV4cCI6MjA4NzYxMzg1OX0.xz_ZlBUEuK1_3Mbp5sgbs9KnT13lsIsg8NwIiA81aF0";

let loginInProgress = false;

// ── Helpers ──

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    process.stdout.write(question);

    // Mute stdin echo if terminal
    if (process.stdin.isTTY) {
      (process.stdin as any).setRawMode?.(true);
    }

    let password = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r") {
        if (process.stdin.isTTY) {
          (process.stdin as any).setRawMode?.(false);
        }
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(password);
      } else if (c === "\u007f" || c === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c === "\u0003") {
        // Ctrl+C
        if (process.stdin.isTTY) {
          (process.stdin as any).setRawMode?.(false);
        }
        rl.close();
        resolve("");
      } else {
        password += c;
        process.stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function supabaseSignIn(
  email: string,
  password: string,
): Promise<{ accessToken: string; email: string } | { error: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 400 && body.error_description) {
      return { error: body.error_description };
    }
    return { error: body.msg || body.error || `Auth error ${res.status}` };
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    email: data.user?.email || email,
  };
}

async function ensureRelay(accessToken: string): Promise<
  | {
      relayToken: string;
      pinclawToken: string;
      subdomain: string;
      created: boolean;
    }
  | { error: string }
> {
  const res = await fetch(`${API_URL}/api/v1/instances/me/ensure-relay`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body.error || `Server error ${res.status}` };
  }

  const data = await res.json();
  return {
    relayToken: data.relayToken,
    pinclawToken: data.token || "",
    subdomain: data.subdomain || "",
    created: !!data.created,
  };
}

// ── Login handler ──

/**
 * openclaw pinclaw login — sign in with email/password, auto-configure relay.
 *
 * Flow:
 * 1. Prompt for email and password in terminal
 * 2. Authenticate via Supabase Auth API
 * 3. Call ensure-relay (same endpoint as iPhone app)
 * 4. Write relay config to ~/.openclaw/openclaw.json
 * 5. Done — same relay instance as iPhone app, no browser needed
 */
export async function handlePinclawLogin(
  _api: any,
  opts?: { email?: string; password?: string },
): Promise<{ text: string }> {
  if (loginInProgress) {
    return { text: "Login already in progress." };
  }

  // Check if already configured
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (config.channels?.pinclaw?.relay?.token) {
      return {
        text: "Already connected. Run /pinclaw logout first to reconfigure.",
      };
    }
  } catch {}

  loginInProgress = true;

  try {
    // 1. Get credentials (from args or interactive prompt)
    let email = opts?.email;
    let password = opts?.password;

    if (!email || !password) {
      console.log("");
      console.log("Sign in with your pinclaw.ai account:");
      console.log("");

      if (!email) {
        email = await prompt("  Email: ");
        if (!email) {
          loginInProgress = false;
          return { text: "Login cancelled." };
        }
      }

      if (!password) {
        password = await promptPassword("  Password: ");
        if (!password) {
          loginInProgress = false;
          return { text: "Login cancelled." };
        }
      }
    }

    console.log("");
    console.log("Signing in...");

    // 2. Authenticate
    const authResult = await supabaseSignIn(email, password);
    if ("error" in authResult) {
      loginInProgress = false;
      return { text: `Login failed: ${authResult.error}` };
    }

    console.log("Setting up relay...");

    // 3. Ensure relay instance
    const relayResult = await ensureRelay(authResult.accessToken);
    if ("error" in relayResult) {
      loginInProgress = false;
      return { text: `Relay setup failed: ${relayResult.error}` };
    }

    // 4. Write config
    writeRelayConfig({
      relayToken: relayResult.relayToken,
      pinclawToken: relayResult.pinclawToken,
      subdomain: relayResult.subdomain,
    });

    // 5. Restart gateway so it picks up the new relay config
    console.log("Restarting gateway...");
    const restartOk = await restartGateway();

    loginInProgress = false;

    if (restartOk) {
      const gatewayUp = await waitForGatewayReady();

      const lines: string[] = [];
      lines.push("");
      lines.push(`Logged in as ${authResult.email}`);
      if (gatewayUp) {
        lines.push("Relay connected!");
      } else {
        lines.push("Gateway restarted. Relay connecting...");
      }
      lines.push("");
      lines.push("Your Pinclaw is ready.");
      return { text: lines.join("\n") };
    }

    // Gateway restart failed — still show success but tell user
    const lines: string[] = [];
    lines.push("");
    lines.push(`Logged in as ${authResult.email}`);
    lines.push(`Relay: ${relayResult.subdomain}`);
    lines.push("");
    lines.push("Config saved. Restart the gateway to connect:");
    lines.push("  openclaw gateway restart");
    return { text: lines.join("\n") };
  } catch (err: any) {
    loginInProgress = false;
    return { text: `Login failed: ${err.message}` };
  }
}

// ── Gateway restart + health check ──

async function restartGateway(): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile(
        "openclaw",
        ["gateway", "restart"],
        { timeout: 30_000 },
        (err) => {
          if (err) {
            console.log(
              `  Gateway restart failed: ${err.message}. Run manually: openclaw gateway restart`,
            );
            resolve(false);
          } else {
            resolve(true);
          }
        },
      );
    });
  } catch {
    return false;
  }
}

async function waitForGatewayReady(): Promise<boolean> {
  // Poll the plugin health endpoint until it responds (gateway is up)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch("http://127.0.0.1:18790/health", {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // Not up yet
    }
  }
  return false;
}

// ── Config management ──

export function writeRelayConfig(data: {
  relayToken: string;
  pinclawToken: string;
  subdomain: string;
}): void {
  const configDir = join(homedir(), ".openclaw");
  const configPath = join(configDir, "openclaw.json");

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let config: any = {};

  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // File missing or invalid — start fresh
  }

  // Ensure plugins.allow includes pinclaw
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.allow) config.plugins.allow = [];
  if (!config.plugins.allow.includes("pinclaw")) {
    config.plugins.allow.push("pinclaw");
  }

  // Write channels.pinclaw with relay config
  if (!config.channels) config.channels = {};
  config.channels.pinclaw = {
    ...config.channels.pinclaw,
    enabled: true,
    authToken:
      data.pinclawToken ||
      config.channels?.pinclaw?.authToken ||
      randomBytes(32).toString("hex"),
    relay: {
      enabled: true,
      token: data.relayToken,
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export async function handlePinclawStatus(
  _api: any,
): Promise<{ text: string }> {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const relay = config.channels?.pinclaw?.relay;
    if (relay?.enabled && relay?.token) {
      return {
        text: `Pinclaw relay: configured (token=${relay.token.substring(0, 8)}...)`,
      };
    }
    return { text: "Pinclaw relay: not configured. Run /pinclaw login" };
  } catch {
    return { text: "Pinclaw relay: not configured. Run /pinclaw login" };
  }
}

export async function handlePinclawLogout(
  _api: any,
): Promise<{ text: string }> {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (config.channels?.pinclaw) {
      delete config.channels.pinclaw.relay;
      delete config.channels.pinclaw.authToken;
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    }
    return { text: "Pinclaw relay config removed." };
  } catch {
    return { text: "Nothing to remove." };
  }
}
