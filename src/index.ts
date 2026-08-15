// Tiny HTTP worker. Exposed to the agent via Tailscale Funnel and guarded by a
// bearer secret. Zero runtime deps for the core; lighting adds lifx-lan-client.
// Runs with `bun src/index.ts`.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { checkParking, parkingConfigured, parkingStatus, startWatch, stopWatch, type WatchInput } from "./camera/parking.js";
import { cameraConfigured, getSnapshot } from "./camera/snapshot.js";
import {
  configureCrons,
  CronInputError,
  cronsView,
  loadCrons,
  runCronNow,
  setCronTimezone,
  startCrons,
  type CronUpdate,
} from "./crons.js";
import { startDiscord } from "./discord/gateway.js";
import { cancelJob, cancelJobByKey, listJobs, loadAndArm, scheduleJob } from "./jobs.js";
import type {
  ConfigPatch,
  PartyInput,
  SceneLookInput,
  ScheduleUpdate,
  SetLightsInput,
  TastePatch,
  ThemeInput,
} from "./lighting/daemon.js";
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

// A timed job may be placed relatively ("in 90 minutes") or absolutely ("at
// 16:15 local", sent as an ISO timestamp). Returns null when neither is usable.
function resolveFireAt(body: Record<string, unknown>): number | null {
  if (typeof body.delaySeconds === "number" && Number.isFinite(body.delaySeconds)) {
    return Date.now() + Math.max(0, body.delaySeconds) * 1000;
  }
  if (typeof body.fireAt === "string") {
    const at = Date.parse(body.fireAt);
    if (!Number.isNaN(at)) return at;
  }
  return null;
}

// Long-running effects are fire-and-forget so a wedged bulb cannot hang the
// agent. Config, schedule, and direct-control routes await validation/results.
const bg = (p: Promise<unknown>) => void p.catch((e) => console.warn("[lighting]", (e as Error).message));

async function handleLighting(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!lighting) return send(res, 503, { error: "lighting unavailable" });
  if (req.method === "GET" && path === "/lighting") return send(res, 200, await lighting.status());
  const l = lighting;
  let body: Record<string, unknown>;
  try {
    const parsed = (await readJson(req)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return send(res, 400, { error: "JSON body must be an object" });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return send(res, 400, { error: "invalid JSON body" });
  }
  try {
    switch (path) {
      case "/lighting/control":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        return send(res, 200, await l.setLights(body as SetLightsInput));
      case "/lighting/schedule":
        if (req.method !== "PATCH") return send(res, 405, { error: "method not allowed" });
        await l.configureSchedule(body as ScheduleUpdate);
        return send(res, 200, { schedule: l.scheduleView() });
      case "/lighting/config":
        if (req.method !== "PATCH") return send(res, 405, { error: "method not allowed" });
        await l.configure(body as ConfigPatch);
        return send(res, 200, { config: l.configView() });
      case "/lighting/scene":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        if (typeof body.scene !== "string") throw new l.LightingInputError("scene must be a name");
        bg(l.applyScene(body.scene));
        return send(res, 200, { ok: true, scene: body.scene });
      case "/lighting/theme":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        bg(l.setTheme(body as ThemeInput));
        return send(res, 200, { ok: true });
      case "/lighting/auto":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        bg(l.resumeAuto());
        return send(res, 200, { ok: true });
      case "/lighting/scene-look":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        bg(l.setSceneLook(body as unknown as SceneLookInput));
        return send(res, 200, { ok: true });
      case "/lighting/power":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        if (typeof body.on !== "boolean") throw new l.LightingInputError("on must be a boolean");
        bg(l.setAllPower(body.on));
        return send(res, 200, { ok: true, on: body.on });
      case "/lighting/enable":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        if (typeof body.enabled !== "boolean") throw new l.LightingInputError("enabled must be a boolean");
        bg(l.setEnabled(body.enabled));
        return send(res, 200, { ok: true, enabled: body.enabled });
      case "/lighting/flash":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        if (body.times !== undefined && (typeof body.times !== "number" || !Number.isInteger(body.times) || body.times < 1 || body.times > 10)) {
          throw new l.LightingInputError("times must be an integer from 1 to 10");
        }
        bg(l.flash(typeof body.times === "number" ? body.times : 2));
        return send(res, 200, { ok: true });
      case "/lighting/party":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        bg(l.startParty(body as PartyInput));
        return send(res, 200, { ok: true });
      case "/lighting/party/stop":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        bg(l.stopParty());
        return send(res, 200, { ok: true });
      case "/lighting/tune":
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        bg(l.tune(body as TastePatch));
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: "not found" });
    }
  } catch (error) {
    if (error instanceof l.LightingInputError) return send(res, 400, { error: error.message });
    throw error;
  }
}

// Camera + parking. A parking check does a snapshot + one vision call, so it
// can take ~10-30s — callers should use a generous timeout on POST .../check.
async function handleCamera(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method === "GET" && path === "/camera/snapshot") {
    if (!cameraConfigured()) return send(res, 503, { error: "camera unavailable (set WYZE_BRIDGE_URL + PARKING_CAMERA)" });
    let frame: Buffer;
    try {
      frame = await getSnapshot();
    } catch (err) {
      return send(res, 502, { error: `camera: ${(err as Error).message}` });
    }
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": frame.length });
    res.end(frame);
    return;
  }
  if (req.method === "GET" && path === "/camera/parking") return send(res, 200, parkingStatus());
  if (!parkingConfigured()) {
    return send(res, 503, {
      error: "parking unavailable (set WYZE_BRIDGE_URL + PARKING_CAMERA and ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY)",
    });
  }
  if (req.method === "POST" && path === "/camera/parking/check") {
    try {
      return send(res, 200, await checkParking());
    } catch (err) {
      // Upstream failed (bridge frame or vision call) — 502 carrying the reason,
      // so the agent can tell Steven which half broke instead of guessing.
      return send(res, 502, { error: (err as Error).message });
    }
  }
  if (req.method === "POST" && path === "/camera/parking/watch") {
    const body = (await readJson(req)) as WatchInput;
    return send(res, 200, { watching: true, ...startWatch(body) });
  }
  if (req.method === "DELETE" && path === "/camera/parking/watch") {
    return send(res, 200, { stopped: stopWatch() });
  }
  send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

    if (path === "/jobs" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readJson(req);
      // Timed: a reminder (fixed text) or a wake (the agent runs a real turn).
      // Either accepts a relative delaySeconds or an absolute ISO fireAt.
      if ((body.type === "reminder" || body.type === "wake") && typeof body.message === "string") {
        const fireAt = resolveFireAt(body);
        if (fireAt === null) {
          return send(res, 400, { error: "provide delaySeconds (number) or fireAt (ISO timestamp)" });
        }
        const job = await scheduleJob({
          type: body.type,
          message: body.message,
          fireAt,
          key: typeof body.key === "string" ? body.key : undefined,
          source: typeof body.source === "string" ? body.source : undefined,
        });
        return send(res, 200, { id: job.id, type: job.type, fireAt: new Date(job.fireAt).toISOString() });
      }
      if (body.type === "presence" && typeof body.message === "string" && (body.trigger === "home" || body.trigger === "away")) {
        const kind = body.kind === "wake" ? "wake" : "notify";
        const r = await addPresenceReminder(body.message, body.trigger as Presence, kind);
        return send(res, 200, { id: r.id, trigger: r.trigger, kind: r.kind });
      }
      return send(res, 400, {
        error:
          "Expected {type:'reminder'|'wake', message, delaySeconds|fireAt} or " +
          "{type:'presence', message, trigger:'home'|'away', kind?}",
      });
    }

    // Everything on the agent's clock in one call: pending one-shots, presence
    // triggers, and the recurring entries it owns.
    if (path === "/jobs" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, {
        timed: listJobs().map((j) => ({
          id: j.id,
          type: j.type,
          message: j.message,
          fireAt: new Date(j.fireAt).toISOString(),
          key: j.key,
          source: j.source,
        })),
        presence: listPresenceReminders(),
        recurring: cronsView(),
      });
    }

    const jobId = path.match(/^\/jobs\/([^/]+)$/)?.[1];
    if (jobId && req.method === "DELETE") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const id = decodeURIComponent(jobId);
      const canceled =
        (await cancelJob(id)) || (await cancelPresenceReminder(id)) || (await cancelJobByKey(id));
      return canceled ? send(res, 200, { canceled: id }) : send(res, 404, { error: "not found" });
    }

    if (path.startsWith("/crons")) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      try {
        if (req.method === "GET" && path === "/crons") return send(res, 200, cronsView());
        if (req.method === "PATCH" && path === "/crons") {
          const body = await readJson(req);
          if (typeof body.timezone === "string") await setCronTimezone(body.timezone);
          if (body.replace !== undefined || body.remove !== undefined || body.upsert !== undefined) {
            await configureCrons(body as CronUpdate);
          } else if (typeof body.timezone !== "string") {
            throw new CronInputError("provide replace, remove, upsert, or timezone");
          }
          return send(res, 200, cronsView());
        }
        const runName = path.match(/^\/crons\/([^/]+)\/run$/)?.[1];
        if (runName && req.method === "POST") {
          const ran = await runCronNow(decodeURIComponent(runName));
          return ran ? send(res, 200, { ran: decodeURIComponent(runName) }) : send(res, 404, { error: "not found" });
        }
        return send(res, 404, { error: "not found" });
      } catch (error) {
        if (error instanceof CronInputError) return send(res, 400, { error: error.message });
        throw error;
      }
    }

    if (path.startsWith("/lighting")) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      // `await` matters: returning the promise unawaited lets a rejection escape
      // this try/catch and kill the process (it did — see the camera handler).
      return await handleLighting(req, res, path);
    }

    if (path.startsWith("/camera")) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      return await handleCamera(req, res, path);
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[worker] request failed", err);
    // Say what actually broke. This worker is private and bearer-gated, and an
    // opaque error is what made a camera outage look like a dead worker.
    if (!res.headersSent) send(res, 500, { error: (err as Error).message });
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

// Last line of defense for an always-on box: one stray rejection used to take
// the whole worker down — lighting, presence, and the Discord gateway with it.
// Log it loudly and keep serving. (uncaughtException is deliberately NOT caught;
// that leaves the process in an unknown state, so let systemd restart it.)
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection", reason);
});

await loadAndArm();
await loadCrons();
startCrons();
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
      const loadedLighting = await import("./lighting/daemon.js");
      await loadedLighting.startLighting();
      lighting = loadedLighting;
    } catch (err) {
      console.warn("[lighting] disabled:", (err as Error).message);
    }
  })();
  startDiscord(); // no-ops unless DISCORD_BOT_TOKEN + AGENT_DISCORD_URL are set
});
