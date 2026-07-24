// Discord Gateway listener. The agent on Vercel can only receive slash-command
// webhooks; reading server messages needs a persistent WebSocket with the
// (privileged) Message Content intent — which this always-on worker holds.
// Messages are batched and forwarded to the agent's ingest endpoint, which
// runs a cheap triage pass (like Gmail). Zero deps: Bun's global WebSocket.
//
//   DISCORD_BOT_TOKEN        same bot as the agent
//   AGENT_DISCORD_URL        https://<vercel-app>/eve/v1/discord/ingest
//   DISCORD_AGENT_SECRET     must match the agent's DISCORD_INGEST_SECRET
//   DISCORD_WATCH_CHANNELS   optional comma-separated channel ids (empty = all)
//   DISCORD_BATCH_SECONDS    flush cadence for the forward buffer (default 60)
//
// Enable "Message Content Intent" for the bot in the Discord Developer Portal
// (Bot → Privileged Gateway Intents) or the gateway closes with code 4014.

import { randomUUID } from "node:crypto";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const MAX_BUFFER = 200;
const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: "authentication failed — check DISCORD_BOT_TOKEN",
  4010: "invalid shard",
  4011: "sharding required",
  4012: "invalid gateway version",
  4013: "invalid intents",
  4014: "disallowed intents — enable 'Message Content Intent' in the Discord Developer Portal",
};

export interface ForwardedMessage {
  id: string;
  guildId?: string;
  channelId: string;
  channel: string; // "#name" or "DM"
  author: string;
  authorId: string;
  content: string;
  attachments: string[]; // filenames only
  at: string; // ISO timestamp
}

// Minimal structural type over Bun/Node's global WebSocket (keeps us off DOM libs).
interface WS {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
}

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

const channelNames = new Map<string, string>();
const buffer: ForwardedMessage[] = [];

let ws: WS | null = null;
let seq: number | null = null;
let sessionId: string | null = null;
let resumeUrl: string | null = null;
let botUserId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let ackReceived = true;
let reconnectDelayMs = 1000;
let stopped = false;

export function startDiscord(): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  const agentUrl = process.env.AGENT_DISCORD_URL;
  const secret = process.env.DISCORD_AGENT_SECRET;
  if (!token || !agentUrl || !secret) {
    console.log("[discord] disabled (set DISCORD_BOT_TOKEN, AGENT_DISCORD_URL, DISCORD_AGENT_SECRET)");
    return;
  }
  const flushSeconds = Math.max(10, Number(process.env.DISCORD_BATCH_SECONDS) || 60);
  setInterval(() => void flush(agentUrl, secret), flushSeconds * 1000).unref?.();
  connect(token);
  console.log("[discord] gateway listener starting");
}

function connect(token: string): void {
  if (stopped) return;
  const url = sessionId && resumeUrl ? `${resumeUrl}?v=10&encoding=json` : GATEWAY_URL;
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!WebSocketCtor) {
    console.error("[discord] no global WebSocket (run with Bun or Node 22+)");
    return;
  }
  const socket = new WebSocketCtor(url) as WS;
  ws = socket;

  socket.addEventListener("message", ((event: { data: unknown }) => {
    try {
      handlePayload(JSON.parse(String(event.data)) as GatewayPayload, token);
    } catch (err) {
      console.warn("[discord] bad payload", (err as Error).message);
    }
  }) as never);

  socket.addEventListener("close", ((event: { code?: number; reason?: string }) => {
    stopHeartbeat();
    const code = event.code ?? 0;
    const fatal = FATAL_CLOSE_CODES[code];
    if (fatal) {
      console.error(`[discord] gateway closed (${code}): ${fatal} — not reconnecting`);
      stopped = true;
      return;
    }
    // 4007 (invalid seq) and 4009 (session timed out) need a fresh identify.
    if (code === 4007 || code === 4009) {
      sessionId = null;
      resumeUrl = null;
    }
    console.warn(`[discord] gateway closed (${code}) — reconnecting in ${reconnectDelayMs / 1000}s`);
    setTimeout(() => connect(token), reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
  }) as never);

  socket.addEventListener("error", (() => {
    // close always follows; reconnect happens there
  }) as never);
}

function handlePayload(payload: GatewayPayload, token: string): void {
  if (payload.s != null) seq = payload.s;

  switch (payload.op) {
    case 10: {
      // hello → heartbeat + identify/resume
      const { heartbeat_interval } = payload.d as { heartbeat_interval: number };
      startHeartbeat(heartbeat_interval);
      if (sessionId) {
        sendPayload({ op: 6, d: { token, session_id: sessionId, seq } });
      } else {
        sendPayload({
          op: 2,
          d: {
            token,
            intents: INTENTS,
            properties: { os: "linux", browser: "sf-pi-worker", device: "sf-pi-worker" },
          },
        });
      }
      return;
    }
    case 1: // server asked for an immediate heartbeat
      sendPayload({ op: 1, d: seq });
      return;
    case 11: // heartbeat ack
      ackReceived = true;
      return;
    case 7: // server asks us to reconnect (resume)
      ws?.close(3000, "reconnect requested");
      return;
    case 9: // invalid session; d=true means resumable
      if (payload.d !== true) {
        sessionId = null;
        resumeUrl = null;
      }
      setTimeout(() => ws?.close(3000, "invalid session"), 1000 + Math.random() * 4000);
      return;
    case 0:
      handleDispatch(payload.t ?? "", payload.d);
      return;
  }
}

function handleDispatch(type: string, d: unknown): void {
  switch (type) {
    case "READY": {
      const data = d as { session_id: string; resume_gateway_url: string; user: { id: string } };
      sessionId = data.session_id;
      resumeUrl = data.resume_gateway_url;
      botUserId = data.user.id;
      reconnectDelayMs = 1000;
      console.log("[discord] gateway ready");
      return;
    }
    case "RESUMED":
      reconnectDelayMs = 1000;
      console.log("[discord] gateway resumed");
      return;
    case "GUILD_CREATE": {
      const guild = d as { channels?: Array<{ id: string; name?: string }> };
      for (const ch of guild.channels ?? []) if (ch.name) channelNames.set(ch.id, ch.name);
      return;
    }
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE": {
      const ch = d as { id: string; name?: string };
      if (ch.name) channelNames.set(ch.id, ch.name);
      return;
    }
    case "MESSAGE_CREATE":
      handleMessage(d as DiscordMessage);
      return;
  }
}

interface DiscordMessage {
  id: string;
  guild_id?: string;
  channel_id: string;
  content?: string;
  timestamp?: string;
  author?: { id: string; bot?: boolean; username?: string; global_name?: string };
  attachments?: Array<{ filename?: string }>;
}

function handleMessage(msg: DiscordMessage): void {
  const author = msg.author;
  if (!author || author.bot || author.id === botUserId) return;

  const watch = (process.env.DISCORD_WATCH_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // DMs always pass; guild messages honor the watch list when one is set.
  if (msg.guild_id && watch.length > 0 && !watch.includes(msg.channel_id)) return;

  const content = msg.content ?? "";
  const attachments = (msg.attachments ?? []).map((a) => a.filename ?? "file").slice(0, 10);
  if (!content.trim() && attachments.length === 0) return;

  buffer.push({
    id: msg.id,
    guildId: msg.guild_id,
    channelId: msg.channel_id,
    channel: msg.guild_id ? `#${channelNames.get(msg.channel_id) ?? msg.channel_id}` : "DM",
    author: author.global_name ?? author.username ?? author.id,
    authorId: author.id,
    content: content.slice(0, 2000),
    attachments,
    at: msg.timestamp ?? new Date().toISOString(),
  });
  // Bound memory if the agent is unreachable for a while — drop oldest.
  while (buffer.length > MAX_BUFFER) buffer.shift();
}

async function flush(agentUrl: string, secret: string): Promise<void> {
  if (buffer.length === 0) return;
  const messages = buffer.splice(0, buffer.length);
  try {
    const res = await fetch(agentUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: randomUUID(), messages }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
  } catch (err) {
    // Put them back (front) and retry on the next flush.
    buffer.unshift(...messages);
    while (buffer.length > MAX_BUFFER) buffer.shift();
    console.warn("[discord] forward failed — will retry", (err as Error).message);
  }
}

function startHeartbeat(intervalMs: number): void {
  stopHeartbeat();
  ackReceived = true;
  // First beat after interval * jitter per the gateway docs.
  setTimeout(() => sendPayload({ op: 1, d: seq }), intervalMs * Math.random());
  heartbeatTimer = setInterval(() => {
    if (!ackReceived) {
      // Zombie connection — close and let the reconnect path resume.
      console.warn("[discord] missed heartbeat ack — reconnecting");
      ws?.close(3001, "heartbeat timeout");
      return;
    }
    ackReceived = false;
    sendPayload({ op: 1, d: seq });
  }, intervalMs);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function sendPayload(payload: GatewayPayload): void {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}
