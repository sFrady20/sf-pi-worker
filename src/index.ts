// Tiny HTTP worker. Exposed to the agent via Tailscale Funnel and guarded by a
// bearer secret. Zero runtime deps for the core; lighting adds lifx-lan-client.
// Runs with `bun src/index.ts`.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cancelJob, listJobs, loadAndArm, scheduleReminder } from "./jobs.js";
import type { SceneLookInput, TastePatch, ThemeInput } from "./lighting/daemon.js";
import { startPresence } from "./presence/monitor.js";
import {
  addPresenceReminder,
  cancelPresenceReminder,
  firePresence,
  listPresenceReminders,
  loadPresenceReminders,
  type Presence,
} from "./presence/reminders.js";

const PORT = Number(process.env.PORT ?? 8088);
const SECRET = process.env.WORKER_SECRET;

// Loaded lazily so the worker still runs (reminders) even if LIFX isn't set up.
type Lighting = typeof import("./lighting/daemon.js");
let lighting: Lighting | null = null;

function authorized(req: IncomingMessage): boolean {
  if (!SECRET) return false;
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return false;
  const provided = Buffer.from(auth.replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(SECRET);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Lighting mutations are fire-and-forget: we ack immediately and apply to the
// bulbs in the background. A wedged LIFX socket can then never hang the agent.
const bg = (p: Promise<unknown>) => void p.catch((e) => console.warn("[lighting]", (e as Error).message));

async function handleLighting(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!lighting) return send(res, 503, { error: "lighting unavailable" });
  if (req.method === "GET" && path === "/lighting") return send(res, 200, lighting.status());
  const l = lighting;
  const body = await readJson(req);
  switch (path) {
    case "/lighting/scene":
      bg(l.applyScene(body.scene as "morning" | "day" | "evening" | "night"));
      return send(res, 200, { ok: true });
    case "/lighting/theme":
      bg(l.setTheme(body as ThemeInput));
      return send(res, 200, { ok: true });
    case "/lighting/auto":
      bg(l.resumeAuto());
      return send(res, 200, { ok: true });
    case "/lighting/scene-look":
      bg(l.setSceneLook(body as unknown as SceneLookInput));
      return send(res, 200, { ok: true });
    case "/lighting/power":
      bg(l.setAllPower(Boolean(body.on)));
      return send(res, 200, { ok: true });
    case "/lighting/enable":
      bg(l.setEnabled(Boolean(body.enabled)));
      return send(res, 200, { ok: true });
    case "/lighting/flash":
      bg(l.flash(typeof body.times === "number" ? body.times : 2));
      return send(res, 200, { ok: true });
    case "/lighting/tune":
      bg(l.tune(body as TastePatch));
      return send(res, 200, { ok: true });
    default:
      return send(res, 404, { error: "not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

    if (path === "/jobs" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readJson(req);
      if (body.type === "reminder" && typeof body.message === "string" && typeof body.delaySeconds === "number") {
        const job = await scheduleReminder(body.message, body.delaySeconds);
        return send(res, 200, { id: job.id, fireAt: new Date(job.fireAt).toISOString() });
      }
      if (body.type === "presence" && typeof body.message === "string" && (body.trigger === "home" || body.trigger === "away")) {
        const r = await addPresenceReminder(body.message, body.trigger as Presence);
        return send(res, 200, { id: r.id, trigger: r.trigger });
      }
      return send(res, 400, {
        error: "Expected a reminder {message,delaySeconds} or presence {message,trigger:'home'|'away'} job",
      });
    }

    if (path === "/jobs" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, {
        timed: listJobs().map((j) => ({
          id: j.id,
          message: j.message,
          fireAt: new Date(j.fireAt).toISOString(),
        })),
        presence: listPresenceReminders(),
      });
    }

    const jobId = path.match(/^\/jobs\/([^/]+)$/)?.[1];
    if (jobId && req.method === "DELETE") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const id = decodeURIComponent(jobId);
      const canceled = (await cancelJob(id)) || (await cancelPresenceReminder(id));
      return canceled ? send(res, 200, { canceled: id }) : send(res, 404, { error: "not found" });
    }

    if (path.startsWith("/lighting")) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      return handleLighting(req, res, path);
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[worker] request failed", err);
    send(res, 500, { error: "internal error" });
  }
});

async function notifyAgentPresence(state: Presence): Promise<void> {
  const url = process.env.AGENT_PRESENCE_URL;
  const secret = process.env.PRESENCE_AGENT_SECRET;
  if (!url || !secret) return;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, at: new Date().toISOString() }),
  });
}

await loadAndArm();
await loadPresenceReminders();
await startPresence(async (state) => {
  console.log("[presence]", state);
  await firePresence(state);
  await notifyAgentPresence(state).catch((e) => console.warn("[presence] agent notify failed", e));
});

server.listen(PORT, () => {
  console.log(`[worker] listening on :${PORT}`);
  void (async () => {
    try {
      lighting = await import("./lighting/daemon.js");
      await lighting.startLighting();
    } catch (err) {
      console.warn("[lighting] disabled:", (err as Error).message);
    }
  })();
});
