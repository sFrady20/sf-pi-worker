// Event-driven presence via `ip monitor neigh`. Watches one phone's MAC and fires
// a "home"/"away" transition. Arrivals are instant; departures are debounced (with
// a confirming ping) because phones sleep WiFi and emit false "gone" signals.
import { spawn } from "node:child_process";
import type { Presence } from "./reminders.js";

const MAC = (process.env.PRESENCE_MAC ?? "").toLowerCase();
const IFACE = process.env.PRESENCE_INTERFACE?.toLowerCase();
const AWAY_GRACE_MS = Number(process.env.PRESENCE_AWAY_GRACE_SECONDS ?? 300) * 1000;
const REACHABLE = /\b(REACHABLE|STALE|DELAY|PROBE|PERMANENT)\b/;
const IP = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

let present = false;
let lastIp: string | null = null;
let lastSeen = 0;
let awayTimer: ReturnType<typeof setTimeout> | null = null;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout?.on("data", (d) => (out += String(d)));
    p.on("exit", () => resolve(out));
    p.on("error", () => resolve(""));
  });
}

function ping(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ping", ["-c", "1", "-W", "2", ip], { stdio: "ignore" });
    p.on("exit", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

function cancelAway(): void {
  if (awayTimer) {
    clearTimeout(awayTimer);
    awayTimer = null;
  }
}

function scheduleAway(handler: (s: Presence) => void): void {
  if (!present || awayTimer) return;
  awayTimer = setTimeout(async () => {
    awayTimer = null;
    if (!present) return;
    const alive = lastIp ? await ping(lastIp) : false; // confirm before declaring away
    if (alive) {
      lastSeen = Date.now();
      return;
    }
    present = false;
    handler("away");
  }, AWAY_GRACE_MS);
}

function handleLine(line: string, handler: (s: Presence) => void): void {
  const low = line.toLowerCase();
  if (IFACE && !low.includes(` dev ${IFACE} `)) return;
  const ip = line.match(IP)?.[1] ?? null;

  if (low.includes(MAC)) {
    if (ip) lastIp = ip;
    if (REACHABLE.test(line) && !low.includes("failed") && !low.startsWith("deleted")) {
      lastSeen = Date.now();
      cancelAway();
      if (!present) {
        present = true;
        handler("home");
      }
      return;
    }
    if (low.includes("failed")) scheduleAway(handler);
    return;
  }

  // FAILED/Deleted lines often carry no MAC — match on the phone's last-known IP.
  if (ip && ip === lastIp && (low.startsWith("deleted") || low.includes("failed"))) {
    scheduleAway(handler);
  }
}

function spawnMonitor(handler: (s: Presence) => void): void {
  const proc = spawn("ip", ["monitor", "neigh"], { stdio: ["ignore", "pipe", "ignore"] });
  let buf = "";
  proc.stdout?.on("data", (d) => {
    buf += String(d);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) handleLine(line, handler);
    }
  });
  proc.on("exit", (code) => {
    console.warn(`[presence] ip monitor exited (${code}) — restarting in 5s`);
    setTimeout(() => spawnMonitor(handler), 5000);
  });
  proc.on("error", (err) => console.error("[presence] ip monitor error", err));
}

async function seed(): Promise<void> {
  // Set initial state from the current table without firing a (false) arrival.
  const out = await run("ip", ["neigh", "show"]);
  for (const line of out.split("\n")) {
    const low = line.toLowerCase();
    if (!low.includes(MAC)) continue;
    lastIp = line.match(IP)?.[1] ?? null;
    if (REACHABLE.test(line) && !low.includes("failed")) {
      present = true;
      lastSeen = Date.now();
    }
  }
  console.log(`[presence] initial state: ${present ? "home" : "away"}`);
}

export async function startPresence(handler: (s: Presence) => void): Promise<void> {
  if (!MAC) {
    console.warn("[presence] PRESENCE_MAC not set — presence disabled");
    return;
  }
  await seed();
  spawnMonitor(handler);
  console.log(`[presence] watching ${MAC}`);
}
