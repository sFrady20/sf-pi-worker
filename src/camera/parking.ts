// Parking-spot checks on the Wyze camera: grab a frame, ask a cheap vision
// model how many spots are open, and optionally watch on a timer — pinging
// Telegram the moment a spot opens. Watches are in-memory (short-lived by
// design); a worker restart simply ends any active watch.

import { notify } from "../notify.js";
import { cameraConfigured, getSnapshot } from "./snapshot.js";
import { describeImage, visionConfigured } from "./vision.js";

export interface ParkingResult {
  open: number;
  total: number;
  detail: string;
  at: string; // ISO timestamp of the check
}

export interface WatchInput {
  minutes?: number; // watch window (default 60)
  intervalSeconds?: number; // time between checks (default 120, min 30)
  stopWhenOpen?: boolean; // stop after the first open spot (default true)
}

interface Watch {
  endsAt: number;
  intervalMs: number;
  stopWhenOpen: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  checks: number;
  found: boolean;
}

const DEFAULT_PROMPT =
  "You are looking at a still image from a parking camera. Count the parking " +
  "spots you can clearly evaluate and how many are open (no vehicle in them).";

const MAX_CONSECUTIVE_FAILURES = 3;

let last: ParkingResult | null = null;
let watch: Watch | null = null;

export function parkingConfigured(): boolean {
  return cameraConfigured() && visionConfigured();
}

function buildPrompt(): string {
  const desc = process.env.PARKING_PROMPT ?? DEFAULT_PROMPT;
  return (
    `${desc}\n\nReply with ONLY a JSON object, no other text:\n` +
    `{"open": <number of open spots>, "total": <number of spots evaluated>, ` +
    `"detail": "<one short sentence describing what you see>"}`
  );
}

function parseReply(raw: string): { open: number; total: number; detail: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`vision reply was not JSON: ${raw.slice(0, 200)}`);
  const obj = JSON.parse(match[0]) as { open?: unknown; total?: unknown; detail?: unknown };
  const open = Number(obj.open);
  const total = Number(obj.total);
  return {
    open: Number.isFinite(open) ? Math.max(0, Math.round(open)) : 0,
    total: Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0,
    detail: typeof obj.detail === "string" ? obj.detail : "",
  };
}

export async function checkParking(): Promise<ParkingResult> {
  const frame = await getSnapshot();
  const raw = await describeImage(frame, buildPrompt());
  last = { ...parseReply(raw), at: new Date().toISOString() };
  return last;
}

export function parkingStatus(): {
  configured: boolean;
  last: ParkingResult | null;
  watch: { endsAt: string; intervalSeconds: number; stopWhenOpen: boolean; checks: number } | null;
} {
  return {
    configured: parkingConfigured(),
    last,
    watch: watch
      ? {
          endsAt: new Date(watch.endsAt).toISOString(),
          intervalSeconds: Math.round(watch.intervalMs / 1000),
          stopWhenOpen: watch.stopWhenOpen,
          checks: watch.checks,
        }
      : null,
  };
}

export function startWatch(input: WatchInput): { endsAt: string; intervalSeconds: number } {
  stopWatch(); // restarting retunes in place
  const minutes = clamp(input.minutes ?? 60, 1, 12 * 60);
  const intervalMs = clamp(input.intervalSeconds ?? 120, 30, 3600) * 1000;
  watch = {
    endsAt: Date.now() + minutes * 60_000,
    intervalMs,
    stopWhenOpen: input.stopWhenOpen ?? true,
    timer: null,
    consecutiveFailures: 0,
    checks: 0,
    found: false,
  };
  // First check right away; later ones chain via setTimeout so a slow vision
  // call can never overlap the next tick.
  schedule(0);
  return { endsAt: new Date(watch.endsAt).toISOString(), intervalSeconds: intervalMs / 1000 };
}

export function stopWatch(): boolean {
  if (!watch) return false;
  if (watch.timer) clearTimeout(watch.timer);
  watch = null;
  return true;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function schedule(delayMs: number): void {
  if (!watch) return;
  watch.timer = setTimeout(() => void tick(), delayMs);
}

async function tick(): Promise<void> {
  const w = watch;
  if (!w) return;

  if (Date.now() >= w.endsAt) {
    stopWatch();
    if (!w.found) await quietNotify("🅿️ Parking watch ended — no spot opened while I was looking.");
    return;
  }

  try {
    const result = await checkParking();
    w.consecutiveFailures = 0;
    w.checks += 1;
    if (result.open > 0) {
      w.found = true;
      await quietNotify(
        `🅿️ Parking: ${result.open} of ${result.total} spot${result.total === 1 ? "" : "s"} open. ${result.detail}`.trim(),
      );
      if (w.stopWhenOpen) {
        stopWatch();
        return;
      }
    }
  } catch (err) {
    w.consecutiveFailures += 1;
    console.warn("[parking] check failed", (err as Error).message);
    if (w.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stopWatch();
      await quietNotify(
        `🅿️ Parking watch stopped — ${MAX_CONSECUTIVE_FAILURES} checks in a row failed (${(err as Error).message}).`,
      );
      return;
    }
  }
  schedule(w.intervalMs);
}

async function quietNotify(text: string): Promise<void> {
  try {
    await notify(text);
  } catch (err) {
    console.warn("[parking] notify failed", (err as Error).message);
  }
}
