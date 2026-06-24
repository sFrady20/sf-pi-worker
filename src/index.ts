// Tiny HTTP worker. Exposed to the agent via Tailscale Funnel and guarded by a
// bearer secret. Zero runtime dependencies — runs with `bun src/index.ts`.

import { createServer, type IncomingMessage } from "node:http";
import { loadAndArm, scheduleReminder } from "./jobs.js";

const PORT = Number(process.env.PORT ?? 8088);
const SECRET = process.env.WORKER_SECRET;

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

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

    if (req.method === "POST" && (req.url === "/jobs" || req.url?.startsWith("/jobs?"))) {
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

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[worker] request failed", err);
    send(res, 500, { error: "internal error" });
  }
});

await loadAndArm();
server.listen(PORT, () => console.log(`[worker] listening on :${PORT}`));
