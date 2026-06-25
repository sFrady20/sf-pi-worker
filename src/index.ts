// Tiny HTTP worker. Exposed to the agent via Tailscale Funnel and guarded by a
// bearer secret. Zero runtime deps for the core; lighting adds lifx-lan-client.
// Runs with `bun src/index.ts`.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadAndArm, scheduleReminder } from "./jobs.js";
import type { TastePatch } from "./lighting/daemon.js";

const PORT = Number(process.env.PORT ?? 8088);
const SECRET = process.env.WORKER_SECRET;

// Loaded lazily so the worker still runs (reminders) even if LIFX isn't set up.
type Lighting = typeof import("./lighting/daemon.js");
let lighting: Lighting | null = null;

function authorized(req: IncomingMessage): boolean {
  if (!SECRET) return false;
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.replace(/^Bearer\s+/i, "").trim() === SECRET;
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

async function handleLighting(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!lighting) return send(res, 503, { error: "lighting unavailable" });
  if (req.method === "GET" && path === "/lighting") return send(res, 200, lighting.status());
  const body = await readJson(req);
  switch (path) {
    case "/lighting/scene":
      await lighting.applyScene(body.scene as "morning" | "day" | "evening" | "night");
      return send(res, 200, { ok: true });
    case "/lighting/power":
      await lighting.setAllPower(Boolean(body.on));
      return send(res, 200, { ok: true });
    case "/lighting/enable":
      await lighting.setEnabled(Boolean(body.enabled));
      return send(res, 200, { ok: true });
    case "/lighting/flash":
      await lighting.flash(typeof body.times === "number" ? body.times : 2);
      return send(res, 200, { ok: true });
    case "/lighting/tune":
      return send(res, 200, { ok: true, taste: await lighting.tune(body as TastePatch) });
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
      if (
        body.type !== "reminder" ||
        typeof body.message !== "string" ||
        typeof body.delaySeconds !== "number"
      ) {
        return send(res, 400, {
          error: "Expected { type: 'reminder', message: string, delaySeconds: number }",
        });
      }
      const job = await scheduleReminder(body.message, body.delaySeconds);
      return send(res, 200, { id: job.id, fireAt: new Date(job.fireAt).toISOString() });
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

await loadAndArm();
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
